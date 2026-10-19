"""Shotboard 本地服务：导入样片、筛选、编辑标签。"""
import base64
import hashlib
import io
import uuid
from pathlib import Path
from typing import List, Optional
from urllib.parse import urlparse

import httpx
from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from PIL import Image, ImageOps
from pydantic import BaseModel

from . import db, plans, tagger

try:  # 支持 iPhone 的 HEIC 照片
    from pillow_heif import register_heif_opener
    register_heif_opener()
except Exception:
    pass

STATIC_DIR = Path(__file__).resolve().parent / "static"
ALLOWED_EXT = {".jpg", ".jpeg", ".png", ".webp", ".heic", ".heif", ".bmp", ".tif", ".tiff", ".gif"}
MAX_BYTES = 40 * 1024 * 1024

db.init()
app = FastAPI(title="Shotboard")
# 只允许浏览器插件跨域访问（下一版的小红书收藏插件会用到）
app.add_middleware(CORSMiddleware, allow_origin_regex=r"^chrome-extension://.*$",
                   allow_methods=["*"], allow_headers=["*"])


app.include_router(plans.router)


@app.on_event("startup")
def _startup():
    tagger.start_workers()


# ---------- 导入 ----------
def platform_of(url: Optional[str]):
    if not url:
        return None
    host = urlparse(url).netloc.lower()
    for key, name in (("xiaohongshu", "小红书"), ("xhscdn", "小红书"), ("pinterest", "Pinterest"),
                      ("pinimg", "Pinterest"), ("instagram", "Instagram"), ("douban", "豆瓣"),
                      ("weibo", "微博"), ("lofter", "LOFTER"), ("unsplash", "Unsplash")):
        if key in host:
            return name
    return host or None


def save_image_bytes(data: bytes, original_name: str, meta: dict):
    """保存一张图，返回 (record, is_new)。相同图片自动去重。"""
    if len(data) > MAX_BYTES:
        raise ValueError("文件太大（超过 40MB）")
    sha = hashlib.sha256(data).hexdigest()
    with db.conn() as c:
        old = c.execute("SELECT * FROM images WHERE sha256=?", (sha,)).fetchone()
        if old:
            return db.row_to_dict(c, old), False
    try:
        im = Image.open(io.BytesIO(data))
        im = ImageOps.exif_transpose(im)
        im.load()
    except Exception:
        raise ValueError("无法识别的图片格式")
    stem = uuid.uuid4().hex[:12]
    ext = (im.format or "JPEG").lower()
    if ext in ("jpeg", "mpo"):
        ext = "jpg"
    if ext not in ("jpg", "png", "webp", "gif"):
        # HEIC / TIFF 等统一转 JPG，浏览器才能显示
        ext = "jpg"
        rgb = im.convert("RGB")
        buf = io.BytesIO()
        rgb.save(buf, "JPEG", quality=92)
        data = buf.getvalue()
    filename = f"{stem}.{ext}"
    (db.IMAGE_DIR / filename).write_bytes(data)
    thumb = im.convert("RGB")
    thumb.thumbnail((720, 1440))
    thumb.save(db.THUMB_DIR / f"{stem}.jpg", "JPEG", quality=84)

    with db.conn() as c:
        cur = c.execute(
            """INSERT INTO images (filename, sha256, original_name, width, height, source_url, platform, author, title)
               VALUES (?,?,?,?,?,?,?,?,?)""",
            (filename, sha, original_name, im.width, im.height, meta.get("source_url"),
             meta.get("platform") or platform_of(meta.get("source_url")), meta.get("author"), meta.get("title")))
        rec = db.row_to_dict(c, c.execute("SELECT * FROM images WHERE id=?", (cur.lastrowid,)).fetchone())
    cfg = tagger.load_config()
    if cfg["auto_tag"] and tagger.is_ready():
        tagger.enqueue(rec["id"])
    return rec, True


@app.post("/api/import")
async def import_files(files: List[UploadFile] = File(...)):
    added, skipped, failed = [], 0, []
    for f in files:
        if Path(f.filename or "").suffix.lower() not in ALLOWED_EXT:
            failed.append({"name": f.filename, "error": "不是图片文件"})
            continue
        try:
            rec, new = save_image_bytes(await f.read(), f.filename, {})
            if new:
                added.append(rec)
            else:
                skipped += 1
        except Exception as e:
            failed.append({"name": f.filename, "error": str(e)})
    return {"added": len(added), "skipped": skipped, "failed": failed}


class UrlImport(BaseModel):
    image_url: Optional[str] = None     # 图片地址
    image_data: Optional[str] = None    # 或 base64 图片（浏览器插件会用）
    source_url: Optional[str] = None    # 原帖链接
    title: Optional[str] = None
    author: Optional[str] = None
    platform: Optional[str] = None


@app.post("/api/import-url")
def import_url(item: UrlImport):
    if item.image_data:
        raw = item.image_data.split(",", 1)[-1]
        data = base64.b64decode(raw)
        name = "web-image"
    elif item.image_url:
        headers = {"User-Agent": "Mozilla/5.0"}
        if item.source_url:
            headers["Referer"] = item.source_url
        try:
            r = httpx.get(item.image_url, headers=headers, timeout=30, follow_redirects=True)
            r.raise_for_status()
        except Exception as e:
            raise HTTPException(400, f"下载图片失败：{e}")
        data = r.content
        name = Path(urlparse(item.image_url).path).name or "web-image"
    else:
        raise HTTPException(400, "需要 image_url 或 image_data")
    try:
        rec, new = save_image_bytes(data, name, item.model_dump())
    except ValueError as e:
        raise HTTPException(400, str(e))
    if not new:  # 已存在的图：补充来源信息
        with db.conn() as c:
            c.execute("""UPDATE images SET source_url=COALESCE(source_url,?), title=COALESCE(title,?),
                         author=COALESCE(author,?), platform=COALESCE(platform,?) WHERE id=?""",
                      (item.source_url, item.title, item.author,
                       item.platform or platform_of(item.source_url), rec["id"]))
    return {"image": rec, "new": new}


# ---------- 浏览与筛选 ----------
@app.get("/api/images")
def list_images(request: Request, q: str = "", status: str = "", favorite: int = 0,
                platform: str = "", page: int = 1, page_size: int = 60, sort: str = "new"):
    where, args = [], []
    tax_keys = {d["key"] for d in tagger.load_taxonomy()["dimensions"]} | {"custom"}
    for key in tax_keys:
        values = request.query_params.getlist(key)
        if values:
            # 同一维度内是“或”，不同维度之间是“且”
            where.append(f"id IN (SELECT image_id FROM image_tags WHERE dim=? AND tag IN ({','.join('?'*len(values))}))")
            args += [key, *values]
    if q:
        for word in q.split():
            like = f"%{word}%"
            where.append("""(description LIKE ? OR notes LIKE ? OR title LIKE ? OR author LIKE ? OR pose_hint LIKE ?
                           OR lighting_hint LIKE ? OR id IN (SELECT image_id FROM image_tags WHERE tag LIKE ?))""")
            args += [like] * 7
    if status:
        where.append("status=?")
        args.append(status)
    if favorite:
        where.append("favorite=1")
    if platform:
        where.append("platform=?")
        args.append(platform)
    sql_where = ("WHERE " + " AND ".join(where)) if where else ""
    order = {"new": "id DESC", "old": "id ASC", "random": "RANDOM()"}.get(sort, "id DESC")
    with db.conn() as c:
        total = c.execute(f"SELECT COUNT(*) FROM images {sql_where}", args).fetchone()[0]
        rows = c.execute(f"SELECT * FROM images {sql_where} ORDER BY {order} LIMIT ? OFFSET ?",
                         args + [page_size, (page - 1) * page_size]).fetchall()
        items = [db.row_to_dict(c, r) for r in rows]
    return {"total": total, "page": page, "items": items}


@app.get("/api/facets")
def facets():
    with db.conn() as c:
        counts = {}
        for r in c.execute("SELECT dim, tag, COUNT(*) n FROM image_tags GROUP BY dim, tag"):
            counts.setdefault(r["dim"], {})[r["tag"]] = r["n"]
        status = {r["status"]: r["n"] for r in c.execute("SELECT status, COUNT(*) n FROM images GROUP BY status")}
        platforms = {r["platform"]: r["n"] for r in c.execute(
            "SELECT platform, COUNT(*) n FROM images WHERE platform IS NOT NULL GROUP BY platform")}
        fav = c.execute("SELECT COUNT(*) FROM images WHERE favorite=1").fetchone()[0]
    return {"tags": counts, "status": status, "platforms": platforms, "favorite": fav,
            "queue": tagger.queue_size(), "total": sum(status.values()), "paused": tagger.paused_reason()}


@app.get("/api/taxonomy")
def taxonomy():
    return tagger.load_taxonomy()


@app.get("/api/images/{image_id}")
def get_image(image_id: int):
    with db.conn() as c:
        row = c.execute("SELECT * FROM images WHERE id=?", (image_id,)).fetchone()
        if not row:
            raise HTTPException(404, "找不到这张图")
        return db.row_to_dict(c, row)


class ImagePatch(BaseModel):
    tags: Optional[dict] = None
    notes: Optional[str] = None
    favorite: Optional[bool] = None
    description: Optional[str] = None
    pose_hint: Optional[str] = None
    lighting_hint: Optional[str] = None
    source_url: Optional[str] = None
    title: Optional[str] = None
    author: Optional[str] = None
    pose: Optional[dict] = None   # 浏览器识别出的姿势骨架 {"points": [[x,y,v],...], "w":..,"h":..}


@app.patch("/api/images/{image_id}")
def update_image(image_id: int, patch: ImagePatch):
    with db.conn() as c:
        if not c.execute("SELECT 1 FROM images WHERE id=?", (image_id,)).fetchone():
            raise HTTPException(404, "找不到这张图")
        if patch.tags is not None:
            db.set_tags(c, image_id, patch.tags)
        for field in ("notes", "description", "pose_hint", "lighting_hint", "source_url", "title", "author"):
            v = getattr(patch, field)
            if v is not None:
                c.execute(f"UPDATE images SET {field}=? WHERE id=?", (v, image_id))
        if patch.source_url is not None:
            c.execute("UPDATE images SET platform=? WHERE id=?", (platform_of(patch.source_url), image_id))
        if patch.pose is not None:
            c.execute("UPDATE images SET pose_json=? WHERE id=?", (db.dumps(patch.pose), image_id))
        if patch.favorite is not None:
            c.execute("UPDATE images SET favorite=? WHERE id=?", (int(patch.favorite), image_id))
        return db.row_to_dict(c, c.execute("SELECT * FROM images WHERE id=?", (image_id,)).fetchone())


@app.delete("/api/images/{image_id}")
def delete_image(image_id: int):
    with db.conn() as c:
        row = c.execute("SELECT filename FROM images WHERE id=?", (image_id,)).fetchone()
        if not row:
            raise HTTPException(404, "找不到这张图")
        c.execute("DELETE FROM images WHERE id=?", (image_id,))
    (db.IMAGE_DIR / row["filename"]).unlink(missing_ok=True)
    (db.THUMB_DIR / f"{Path(row['filename']).stem}.jpg").unlink(missing_ok=True)
    return {"ok": True}


# ---------- 打标 ----------
@app.post("/api/tag/{image_id}")
def retag(image_id: int):
    if not tagger.is_ready():
        raise HTTPException(400, "请先在设置里填写通义千问 API Key")
    tagger.resume()
    with db.conn() as c:
        c.execute("UPDATE images SET status='pending' WHERE id=?", (image_id,))
    tagger.enqueue(image_id)
    return {"ok": True}


@app.post("/api/tag-all")
def tag_all(include_errors: bool = True):
    if not tagger.is_ready():
        raise HTTPException(400, "请先在设置里填写通义千问 API Key")
    tagger.resume()
    statuses = ("pending", "error") if include_errors else ("pending",)
    with db.conn() as c:
        ids = [r["id"] for r in c.execute(
            f"SELECT id FROM images WHERE status IN ({','.join('?'*len(statuses))})", statuses)]
    for i in ids:
        tagger.enqueue(i)
    return {"queued": len(ids)}


# ---------- 设置 ----------
@app.get("/api/settings")
def get_settings():
    cfg = tagger.load_config()
    key = cfg["api_key"]
    cfg["api_key"] = (key[:5] + "…" + key[-4:]) if len(key) > 12 else ("已填写" if key else "")
    cfg["has_key"] = bool(key)
    cfg["mock"] = tagger.MOCK
    return cfg


class SettingsIn(BaseModel):
    api_key: Optional[str] = None
    region: Optional[str] = None
    model: Optional[str] = None
    auto_tag: Optional[bool] = None


@app.post("/api/settings")
def set_settings(s: SettingsIn):
    data = s.model_dump()
    if data.get("api_key") is not None:
        data["api_key"] = data["api_key"].strip()
        if not data["api_key"] or "…" in data["api_key"]:
            data["api_key"] = None  # 没改就不覆盖
    if data.get("region") not in (None, "cn", "intl"):
        raise HTTPException(400, "region 只能是 cn 或 intl")
    tagger.save_config(data)
    tagger.resume()
    return get_settings()


@app.post("/api/settings/test")
def test_settings():
    try:
        return {"ok": True, "reply": tagger.test_connection()}
    except Exception as e:
        return {"ok": False, "error": str(e)}


# ---------- 静态文件 ----------
app.mount("/images", StaticFiles(directory=db.IMAGE_DIR), name="images")
app.mount("/thumbs", StaticFiles(directory=db.THUMB_DIR), name="thumbs")
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.get("/")
def index():
    return FileResponse(STATIC_DIR / "index.html")
