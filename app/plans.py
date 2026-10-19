"""拍摄方案：一次拍摄要拍哪些镜头、每个镜头的姿势和布光。"""
import json
from typing import List, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from . import db

router = APIRouter(prefix="/api")


def shot_dict(c, row):
    d = dict(row)
    try:
        d["diagram"] = json.loads(d.pop("diagram_json")) if row["diagram_json"] else None
    except Exception:
        d["diagram"] = None
    img = c.execute("SELECT * FROM images WHERE id=?", (row["image_id"],)).fetchone()
    d["image"] = db.row_to_dict(c, img) if img else None
    d["mirror"] = bool(d["mirror"])
    return d


def plan_dict(c, row, with_shots=True):
    d = dict(row)
    shots = c.execute("SELECT * FROM plan_shots WHERE plan_id=? ORDER BY position, id", (row["id"],)).fetchall()
    d["shot_count"] = len(shots)
    if with_shots:
        d["shots"] = [shot_dict(c, s) for s in shots]
    else:  # 列表页只要前几张缩略图
        d["covers"] = []
        for s in shots[:4]:
            img = c.execute("SELECT filename FROM images WHERE id=?", (s["image_id"],)).fetchone()
            if img:
                d["covers"].append(f"/thumbs/{img['filename'].rsplit('.', 1)[0]}.jpg")
    return d


def get_plan_or_404(c, plan_id):
    row = c.execute("SELECT * FROM plans WHERE id=?", (plan_id,)).fetchone()
    if not row:
        raise HTTPException(404, "找不到这个拍摄方案")
    return row


def touch(c, plan_id):
    c.execute("UPDATE plans SET updated_at=datetime('now','localtime') WHERE id=?", (plan_id,))


class PlanIn(BaseModel):
    name: Optional[str] = None
    shoot_date: Optional[str] = None
    location: Optional[str] = None
    model_name: Optional[str] = None
    notes: Optional[str] = None
    image_ids: Optional[List[int]] = None   # 创建时顺便加入的样片


@router.get("/plans")
def list_plans():
    with db.conn() as c:
        rows = c.execute("SELECT * FROM plans ORDER BY updated_at DESC, id DESC").fetchall()
        return [plan_dict(c, r, with_shots=False) for r in rows]


@router.post("/plans")
def create_plan(p: PlanIn):
    name = (p.name or "").strip() or "未命名拍摄"
    with db.conn() as c:
        cur = c.execute("INSERT INTO plans (name, shoot_date, location, model_name, notes) VALUES (?,?,?,?,?)",
                        (name, p.shoot_date, p.location, p.model_name, p.notes))
        plan_id = cur.lastrowid
        if p.image_ids:
            _add_shots(c, plan_id, p.image_ids)
        return plan_dict(c, get_plan_or_404(c, plan_id))


@router.get("/plans/{plan_id}")
def get_plan(plan_id: int):
    with db.conn() as c:
        return plan_dict(c, get_plan_or_404(c, plan_id))


@router.patch("/plans/{plan_id}")
def update_plan(plan_id: int, p: PlanIn):
    with db.conn() as c:
        get_plan_or_404(c, plan_id)
        for field in ("name", "shoot_date", "location", "model_name", "notes"):
            v = getattr(p, field)
            if v is not None:
                c.execute(f"UPDATE plans SET {field}=? WHERE id=?", (v, plan_id))
        touch(c, plan_id)
        return plan_dict(c, get_plan_or_404(c, plan_id), with_shots=False)


@router.delete("/plans/{plan_id}")
def delete_plan(plan_id: int):
    with db.conn() as c:
        get_plan_or_404(c, plan_id)
        c.execute("DELETE FROM plans WHERE id=?", (plan_id,))
    return {"ok": True}


class ShotsIn(BaseModel):
    image_ids: List[int]


def _add_shots(c, plan_id, image_ids):
    pos = c.execute("SELECT COALESCE(MAX(position), -1) FROM plan_shots WHERE plan_id=?", (plan_id,)).fetchone()[0]
    existing = {r["image_id"] for r in c.execute("SELECT image_id FROM plan_shots WHERE plan_id=?", (plan_id,))}
    added = 0
    for iid in dict.fromkeys(image_ids):
        if iid in existing or not c.execute("SELECT 1 FROM images WHERE id=?", (iid,)).fetchone():
            continue
        pos += 1
        c.execute("INSERT INTO plan_shots (plan_id, image_id, position) VALUES (?,?,?)", (plan_id, iid, pos))
        added += 1
    touch(c, plan_id)
    return added


@router.post("/plans/{plan_id}/shots")
def add_shots(plan_id: int, body: ShotsIn):
    with db.conn() as c:
        get_plan_or_404(c, plan_id)
        added = _add_shots(c, plan_id, body.image_ids)
        return {"added": added, "skipped": len(set(body.image_ids)) - added}


class ShotPatch(BaseModel):
    title: Optional[str] = None
    notes: Optional[str] = None
    pose_hint: Optional[str] = None
    lighting_hint: Optional[str] = None
    diagram: Optional[dict] = None
    reset_diagram: Optional[bool] = None
    mirror: Optional[bool] = None


@router.patch("/shots/{shot_id}")
def update_shot(shot_id: int, p: ShotPatch):
    with db.conn() as c:
        row = c.execute("SELECT * FROM plan_shots WHERE id=?", (shot_id,)).fetchone()
        if not row:
            raise HTTPException(404, "找不到这个镜头")
        for field in ("title", "notes", "pose_hint", "lighting_hint"):
            v = getattr(p, field)
            if v is not None:
                c.execute(f"UPDATE plan_shots SET {field}=? WHERE id=?", (v, shot_id))
        if p.diagram is not None:
            c.execute("UPDATE plan_shots SET diagram_json=? WHERE id=?", (db.dumps(p.diagram), shot_id))
        if p.reset_diagram:
            c.execute("UPDATE plan_shots SET diagram_json=NULL WHERE id=?", (shot_id,))
        if p.mirror is not None:
            c.execute("UPDATE plan_shots SET mirror=? WHERE id=?", (int(p.mirror), shot_id))
        touch(c, row["plan_id"])
        return shot_dict(c, c.execute("SELECT * FROM plan_shots WHERE id=?", (shot_id,)).fetchone())


@router.delete("/shots/{shot_id}")
def delete_shot(shot_id: int):
    with db.conn() as c:
        row = c.execute("SELECT plan_id FROM plan_shots WHERE id=?", (shot_id,)).fetchone()
        if not row:
            raise HTTPException(404, "找不到这个镜头")
        c.execute("DELETE FROM plan_shots WHERE id=?", (shot_id,))
        touch(c, row["plan_id"])
    return {"ok": True}


class OrderIn(BaseModel):
    shot_ids: List[int]


@router.post("/plans/{plan_id}/reorder")
def reorder(plan_id: int, body: OrderIn):
    with db.conn() as c:
        get_plan_or_404(c, plan_id)
        for i, sid in enumerate(body.shot_ids):
            c.execute("UPDATE plan_shots SET position=? WHERE id=? AND plan_id=?", (i, sid, plan_id))
        touch(c, plan_id)
    return {"ok": True}
