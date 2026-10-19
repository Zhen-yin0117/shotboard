"""调用通义千问视觉模型（Qwen-VL）给样片自动打标签。"""
import base64
import io
import json
import os
import queue
import random
import re
import threading
import time
from pathlib import Path

import httpx
from PIL import Image

from . import db

TAXONOMY_PATH = Path(__file__).resolve().parent / "taxonomy.json"
CONFIG_PATH = db.DATA_DIR / "config.json"

ENDPOINTS = {
    "cn": "https://dashscope.aliyuncs.com/compatible-mode/v1",        # 北京（国内账号）
    "intl": "https://dashscope-intl.aliyuncs.com/compatible-mode/v1", # 新加坡（国际账号）
}
DEFAULT_CONFIG = {
    "api_key": "",
    "region": "cn",
    "model": "qwen3-vl-plus",
    "auto_tag": True,
    "concurrency": 2,
}

MOCK = os.environ.get("SHOTBOARD_MOCK") == "1"  # 测试用：不调 API，随机打标


# ---------- 配置 ----------
def load_config():
    cfg = dict(DEFAULT_CONFIG)
    if CONFIG_PATH.exists():
        try:
            cfg.update(json.loads(CONFIG_PATH.read_text("utf-8")))
        except Exception:
            pass
    if os.environ.get("DASHSCOPE_API_KEY") and not cfg["api_key"]:
        cfg["api_key"] = os.environ["DASHSCOPE_API_KEY"]
    return cfg


def save_config(updates: dict):
    cfg = load_config()
    for k in DEFAULT_CONFIG:
        if k in updates and updates[k] is not None:
            cfg[k] = updates[k]
    CONFIG_PATH.write_text(db.dumps(cfg), "utf-8")
    return cfg


def is_ready():
    return MOCK or bool(load_config()["api_key"])


def load_taxonomy():
    return json.loads(TAXONOMY_PATH.read_text("utf-8"))


# ---------- 提示词 ----------
def build_prompt(tax):
    lines = []
    for d in tax["dimensions"]:
        kind = "可多选（1-3 个）" if d["multi"] else "单选（只选 1 个）"
        lines.append(f'- "{d["key"]}"（{d["label"]}，{d["hint"]}，{kind}）：{"、".join(d["options"])}')
    dims = "\n".join(lines)
    # 示例只示意格式，用占位文字，避免模型照抄第一个选项
    example = {d["key"]: ([f"{d['label']}标签"] if d["multi"] else f"{d['label']}标签") for d in tax["dimensions"]}
    example.update({
        "description": "一句话描述这张照片",
        "pose_hint": "给模特的动作指导",
        "lighting_hint": "如何复刻这个光线",
    })
    return f"""你是一位资深人像摄影师，正在帮另一位摄影师整理样片库。请仔细观察这张照片，按下面的分类体系打标签。

分类维度和可选标签（只能从给定选项中选，原样照抄文字）：
{dims}

另外写三段简短中文：
- "description"：一句话描述画面（人物、动作、环境、氛围），30 字以内
- "pose_hint"：如果要让模特复刻这个姿势，你会怎么用口语指导她/他，40 字以内
- "lighting_hint"：如何复刻这个光线（光源位置、方向、软硬、是否需要反光板），40 字以内

判断布光时注意：伦勃朗光=鼻子一侧阴影在另一侧脸颊形成倒三角亮区；蝴蝶光=鼻子正下方有蝴蝶状阴影；环形光=鼻影向下斜但不与脸颊阴影相连；分割光=脸一半亮一半暗。看不清时宁可少选。

只输出一个 JSON 对象，不要任何其他文字。格式示例：
{json.dumps(example, ensure_ascii=False)}"""


# ---------- 图片编码 ----------
def encode_image(path: Path, max_side=1280):
    with Image.open(path) as im:
        im = im.convert("RGB")
        im.thumbnail((max_side, max_side))
        buf = io.BytesIO()
        im.save(buf, "JPEG", quality=88)
    return "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()


def parse_json(text: str):
    text = text.strip()
    m = re.search(r"\{.*\}", text, re.S)
    if not m:
        raise ValueError(f"模型没有返回 JSON：{text[:200]}")
    return json.loads(m.group(0))


def normalize(result: dict, tax):
    """只保留分类体系里存在的标签，防止模型自己编。"""
    tags = {}
    for d in tax["dimensions"]:
        raw = result.get(d["key"])
        if raw is None:
            continue
        values = raw if isinstance(raw, list) else [raw]
        valid = [v for v in values if isinstance(v, str) and v in d["options"]]
        if not d["multi"]:
            valid = valid[:1]
        if valid:
            tags[d["key"]] = valid
    extra = {k: str(result.get(k) or "").strip() for k in ("description", "pose_hint", "lighting_hint")}
    return tags, extra


# ---------- 错误翻译 ----------
class AccountError(RuntimeError):
    """账号层面的问题（欠费、Key 错误等）：换哪张图都会失败，需要暂停队列。"""


# (匹配关键词, 中文说明, 是否账号级问题)
ERROR_RULES = [
    (("Arrearage", "overdue-payment"),
     "阿里云账号欠费或余额不足。请到阿里云「费用中心」充值，几分钟后点「重试」。", True),
    (("FreeTierOnly", "free allocated quota", "Free allocated quota"),
     "免费额度已用完，并且开启了「免费额度用完即停」。请到百炼控制台关闭该开关或充值。", True),
    (("InvalidApiKey", "Incorrect API key", "invalid_api_key", "Invalid API-key"),
     "API Key 不对。请检查是否复制完整；另外，国内账号的 Key 要选「中国内地」，国际站的 Key 要选「国际」，选错地区也会报这个错。", True),
    (("model_not_found", "does not exist", "ModelNotFound", "Model not exist"),
     "找不到这个模型。可能是你的账号地区没有这个模型，换成 qwen3-vl-flash 或 qwen-vl-max 试试。", True),
    (("AccessDenied", "Model access denied", "not authorized", "Unpurchased"),
     "账号没有这个模型的使用权限。请在百炼控制台的「模型广场」里开通该模型。", True),
    (("DataInspectionFailed", "inappropriate content", "data_inspection"),
     "这张图被阿里云的内容审核拦截了（常见于泳装、贴身服装类图片），无法自动打标，可以手动加标签。", False),
    (("Throttling", "rate limit", "RateLimit", "TooManyRequests"),
     "请求太频繁被限流了，稍后点「重试」即可。", False),
    (("InvalidParameter", "download the media", "image format", "image size"),
     "图片格式或尺寸不被接受，可以手动加标签。", False),
]


def friendly_error(status, raw: str):
    for keys, msg, account in ERROR_RULES:
        if any(k.lower() in raw.lower() for k in keys):
            return msg, account
    if status in (401, 403):
        return f"阿里云拒绝了请求（{status}）。请检查 API Key 和账号地区设置。", True
    if status and status >= 500:
        return f"阿里云服务暂时出错（{status}），稍后重试。", False
    return f"调用失败（{status}）：{raw[:200]}", False


def raise_api_error(r):
    try:
        err = r.json().get("error", {}) or {}
        raw = f"{err.get('code', '')} {err.get('type', '')} {err.get('message', '')}"
    except Exception:
        raw = r.text
    msg, account = friendly_error(r.status_code, raw)
    raise (AccountError if account else RuntimeError)(msg)


def post(url, body, cfg, timeout):
    try:
        return httpx.post(url, json=body, headers={"Authorization": f"Bearer {cfg['api_key']}"}, timeout=timeout)
    except httpx.TimeoutException:
        raise RuntimeError("阿里云响应超时，稍后重试。")
    except httpx.HTTPError:
        raise AccountError("连不上阿里云服务器。请检查网络；如果开了代理/VPN，试试关掉或切换地区设置。")


# ---------- 调用模型 ----------
def call_model(image_path: Path, tax, cfg):
    if MOCK:
        time.sleep(0.3)
        fake = {}
        for d in tax["dimensions"]:
            k = random.randint(1, 2) if d["multi"] else 1
            fake[d["key"]] = random.sample(d["options"], k)
        fake.update(description="（测试模式）一位模特在窗边", pose_hint="侧身靠窗，下巴微收", lighting_hint="窗光从左侧进入，右侧放反光板")
        return fake, "mock"

    url = ENDPOINTS.get(cfg["region"], ENDPOINTS["cn"]) + "/chat/completions"
    body = {
        "model": cfg["model"],
        "temperature": 0.2,
        "messages": [{
            "role": "user",
            "content": [
                {"type": "image_url", "image_url": {"url": encode_image(image_path)}},
                {"type": "text", "text": build_prompt(tax)},
            ],
        }],
    }
    r = post(url, body, cfg, 120)
    if r.status_code != 200:
        raise_api_error(r)
    content = r.json()["choices"][0]["message"]["content"]
    if isinstance(content, list):  # 个别模型返回分段内容
        content = "".join(p.get("text", "") for p in content if isinstance(p, dict))
    return parse_json(content), cfg["model"]


def test_connection():
    cfg = load_config()
    if MOCK:
        return "测试模式，未调用真实 API"
    if not cfg["api_key"]:
        raise RuntimeError("还没有填 API Key")
    url = ENDPOINTS.get(cfg["region"], ENDPOINTS["cn"]) + "/chat/completions"
    r = post(url, {"model": cfg["model"], "max_tokens": 10,
                   "messages": [{"role": "user", "content": "回复“连接成功”四个字"}]}, cfg, 30)
    if r.status_code != 200:
        raise_api_error(r)
    resume()
    return r.json()["choices"][0]["message"]["content"]


# ---------- 后台队列 ----------
_q: "queue.Queue[int]" = queue.Queue()
_queued: set = set()
_qlock = threading.Lock()
_started = False
_paused = None  # 账号级错误时的说明文字；不为空时队列暂停


def paused_reason():
    return _paused


def resume():
    global _paused
    _paused = None


def enqueue(image_id: int):
    with _qlock:
        if image_id in _queued:
            return
        _queued.add(image_id)
    _q.put(image_id)


def queue_size():
    return len(_queued)


def tag_one(image_id: int):
    tax = load_taxonomy()
    cfg = load_config()
    with db.conn() as c:
        row = c.execute("SELECT filename FROM images WHERE id=?", (image_id,)).fetchone()
        if not row:
            return
        c.execute("UPDATE images SET status='tagging', error=NULL WHERE id=?", (image_id,))
    global _paused
    try:
        result, model = call_model(db.IMAGE_DIR / row["filename"], tax, cfg)
        tags, extra = normalize(result, tax)
        with db.conn() as c:
            # 保留用户手动加的自定义标签
            custom = [r["tag"] for r in c.execute(
                "SELECT tag FROM image_tags WHERE image_id=? AND dim='custom'", (image_id,))]
            if custom:
                tags["custom"] = custom
            db.set_tags(c, image_id, tags)
            c.execute("""UPDATE images SET status='done', error=NULL, description=?, pose_hint=?,
                         lighting_hint=?, tagged_at=datetime('now','localtime'), model=? WHERE id=?""",
                      (extra["description"], extra["pose_hint"], extra["lighting_hint"], model, image_id))
    except AccountError as e:
        # 账号问题：这张退回「待打标」，整个队列暂停，避免一张张白白失败
        _paused = str(e)
        with db.conn() as c:
            c.execute("UPDATE images SET status='pending', error=? WHERE id=?", (str(e)[:500], image_id))
    except Exception as e:
        with db.conn() as c:
            c.execute("UPDATE images SET status='error', error=? WHERE id=?", (str(e)[:500], image_id))


def _worker():
    while True:
        image_id = _q.get()
        try:
            if is_ready() and not _paused:
                tag_one(image_id)
            else:
                with db.conn() as c:
                    c.execute("UPDATE images SET status='pending' WHERE id=?", (image_id,))
        finally:
            with _qlock:
                _queued.discard(image_id)
            _q.task_done()


def start_workers():
    global _started
    if _started:
        return
    _started = True
    n = max(1, min(int(load_config().get("concurrency", 2)), 5))
    for _ in range(n):
        threading.Thread(target=_worker, daemon=True).start()
    # 程序重启后，把上次没打完的重新排队
    with db.conn() as c:
        c.execute("UPDATE images SET status='pending' WHERE status='tagging'")
        ids = [r["id"] for r in c.execute("SELECT id FROM images WHERE status='pending'")]
    if load_config()["auto_tag"] and is_ready():
        for i in ids:
            enqueue(i)
