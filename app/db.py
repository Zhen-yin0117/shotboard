"""SQLite 存储：图片记录 + 标签。"""
import json
import sqlite3
import threading
from contextlib import contextmanager
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
IMAGE_DIR = DATA_DIR / "images"
THUMB_DIR = DATA_DIR / "thumbs"
DB_PATH = DATA_DIR / "library.db"

_lock = threading.RLock()

SCHEMA = """
CREATE TABLE IF NOT EXISTS images (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    filename     TEXT NOT NULL,
    sha256       TEXT NOT NULL UNIQUE,
    original_name TEXT,
    width        INTEGER,
    height       INTEGER,
    source_url   TEXT,
    platform     TEXT,
    author       TEXT,
    title        TEXT,
    added_at     TEXT DEFAULT (datetime('now','localtime')),
    status       TEXT DEFAULT 'pending',   -- pending / tagging / done / error
    error        TEXT,
    description  TEXT,
    pose_hint    TEXT,
    lighting_hint TEXT,
    notes        TEXT,
    favorite     INTEGER DEFAULT 0,
    tagged_at    TEXT,
    model        TEXT
);
CREATE TABLE IF NOT EXISTS image_tags (
    image_id  INTEGER NOT NULL REFERENCES images(id) ON DELETE CASCADE,
    dim       TEXT NOT NULL,
    tag       TEXT NOT NULL,
    PRIMARY KEY (image_id, dim, tag)
);
CREATE INDEX IF NOT EXISTS idx_tags_dim_tag ON image_tags(dim, tag);
CREATE TABLE IF NOT EXISTS plans (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    shoot_date  TEXT,
    location    TEXT,
    model_name  TEXT,
    notes       TEXT,
    created_at  TEXT DEFAULT (datetime('now','localtime')),
    updated_at  TEXT DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS plan_shots (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    plan_id      INTEGER NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
    image_id     INTEGER NOT NULL REFERENCES images(id) ON DELETE CASCADE,
    position     INTEGER DEFAULT 0,
    title        TEXT,
    notes        TEXT,
    pose_hint    TEXT,     -- 为空时用样片自己的
    lighting_hint TEXT,
    diagram_json TEXT,     -- 用户调整过的布光图
    mirror       INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_shots_plan ON plan_shots(plan_id, position);
CREATE INDEX IF NOT EXISTS idx_images_status ON images(status);
"""


# 旧版本数据库升级时需要补的列
MIGRATIONS = [
    ("images", "pose_json", "TEXT"),   # 姿势骨架点（浏览器里识别后存下来）
]


def init():
    for d in (DATA_DIR, IMAGE_DIR, THUMB_DIR):
        d.mkdir(parents=True, exist_ok=True)
    with conn() as c:
        c.executescript(SCHEMA)
        for table, col, typ in MIGRATIONS:
            cols = {r["name"] for r in c.execute(f"PRAGMA table_info({table})")}
            if col not in cols:
                c.execute(f"ALTER TABLE {table} ADD COLUMN {col} {typ}")


@contextmanager
def conn():
    with _lock:
        c = sqlite3.connect(DB_PATH)
        c.row_factory = sqlite3.Row
        c.execute("PRAGMA foreign_keys = ON")
        try:
            yield c
            c.commit()
        finally:
            c.close()


def row_to_dict(c, row):
    d = dict(row)
    if "pose_json" in d:
        raw = d.pop("pose_json", None)
        try:
            d["pose"] = json.loads(raw) if raw else None
        except Exception:
            d["pose"] = None
    tags = {}
    for t in c.execute("SELECT dim, tag FROM image_tags WHERE image_id=?", (row["id"],)):
        tags.setdefault(t["dim"], []).append(t["tag"])
    d["tags"] = tags
    d["thumb_url"] = f"/thumbs/{Path(row['filename']).stem}.jpg"
    d["image_url"] = f"/images/{row['filename']}"
    return d


def set_tags(c, image_id, tags: dict):
    """tags: {dim: [tag, ...]}，整体替换。"""
    c.execute("DELETE FROM image_tags WHERE image_id=?", (image_id,))
    for dim, values in tags.items():
        for v in dict.fromkeys(values):  # 去重保序
            v = str(v).strip()
            if v:
                c.execute("INSERT OR IGNORE INTO image_tags VALUES (?,?,?)", (image_id, dim, v))


def dumps(o):
    return json.dumps(o, ensure_ascii=False)
