# -*- coding: utf-8 -*-
"""数据库操作函数。所有函数第一个参数为 sqlite3.Connection。

所有写操作（创建/更新订单、入住/退房、删除等）均使用
``BEGIN EXCLUSIVE`` 排他事务包裹，配合冲突检测防止多端同时操作导致的数据不一致。
"""

import json
import math
import sqlite3
from datetime import datetime

import schemas
from utils import (AppError, calculate_price, check_room_conflict, date_str,
                   day_end, day_start, normalize_order_range, now_ts, calculate_expected_repay_date)

_ACTIVE = ("已预订", "已入住")


def _to_dict(row) -> dict | None:
    if row is None:
        return None
    d = dict(row)
    if "channel_id" in d:
        try:
            d["channel_id"] = int(float(d["channel_id"] or 0))
        except (TypeError, ValueError):
            d["channel_id"] = 0
    return d


def _begin_exclusive(conn: sqlite3.Connection) -> None:
    """开启 SQLite 排他写事务：同一时刻只允许一个写事务，天然串行化写操作。"""
    conn.execute("BEGIN EXCLUSIVE")


def _next_order_no(conn: sqlite3.Connection, now: int) -> str:
    """生成订单号：YD + 日期 + 4 位当日序号，如 YD202608100001。

    序号持久化在 order_seq 表中（排他事务内自增），删除订单后不会复用。
    """
    date_key = datetime.fromtimestamp(now).strftime("%Y%m%d")
    row = conn.execute(
        "SELECT last_seq FROM order_seq WHERE date_key = ?", (date_key,)
    ).fetchone()
    seq = (row["last_seq"] if row else 0) + 1
    conn.execute(
        "INSERT INTO order_seq (date_key, last_seq) VALUES (?, ?)"
        " ON CONFLICT(date_key) DO UPDATE SET last_seq = excluded.last_seq",
        (date_key, seq),
    )
    return f"YD{date_key}{seq:04d}"


# ---------------- 房间 ----------------

def get_all_rooms(conn: sqlite3.Connection, status: str | None = None,
                  keyword: str | None = None,
                  include_inactive: bool = False,
                  store_id: int | None = None,
                  active: int | None = None,
                  need_clean: int | None = None) -> list[dict]:
    """房间列表，支持按状态、启用/停用、需打扫、房号/房型关键字、门店筛选。"""
    sql = ("SELECT r.*, (SELECT COUNT(*) FROM orders o WHERE o.room_id = r.id"
           " AND o.status IN ('已预订', '已入住')) AS active_orders"
           " FROM rooms r WHERE 1=1")
    params: list = []
    if active is not None:
        sql += " AND r.is_active = ?"
        params.append(active)
    elif not include_inactive:
        sql += " AND r.is_active = 1"
    if store_id is not None:
        sql += " AND r.store_id = ?"
        params.append(store_id)
    if status:
        sql += " AND r.status = ?"
        params.append(status)
    if need_clean is not None:
        sql += " AND r.need_clean = ?"
        params.append(need_clean)
    if keyword:
        sql += " AND (r.room_number LIKE ? OR r.room_category LIKE ?)"
        kw = f"%{keyword}%"
        params.extend([kw, kw])
    sql += " ORDER BY CAST(room_number AS INTEGER), room_number"
    return [_to_dict(r) for r in conn.execute(sql, params).fetchall()]


def get_room(conn: sqlite3.Connection, room_id: int) -> dict | None:
    return _to_dict(conn.execute("SELECT * FROM rooms WHERE id = ?", (room_id,)).fetchone())


def create_room(conn: sqlite3.Connection, data: schemas.RoomCreate) -> dict:
    number = data.room_number.strip()
    dup = conn.execute(
        "SELECT 1 FROM rooms WHERE store_id = ? AND room_number = ? COLLATE NOCASE",
        (data.store_id, number),
    ).fetchone()
    if dup:
        raise AppError("房间号已存在")
    store = conn.execute("SELECT id FROM stores WHERE id = ?", (data.store_id,)).fetchone()
    if not store:
        raise AppError("门店不存在")
    # 钟点价上限：不高于该房全日价
    hourly = min(data.hourly_price or 0, data.base_price or 0)
    created_at = now_ts()
    cur = conn.execute(
        "INSERT INTO rooms (room_number, room_name, room_category, base_price, hourly_price, status, is_active, store_id, remark, need_clean, created_at)"
        " VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)",
        (number, (data.room_name or "").strip(), data.room_category, data.base_price, hourly,
         data.status.value, data.store_id, (data.remark or "").strip(), data.need_clean or 0, created_at),
    )
    conn.commit()
    return get_room(conn, cur.lastrowid)


def update_room(conn: sqlite3.Connection, room_id: int, data: schemas.RoomUpdate) -> dict:
    room = get_room(conn, room_id)
    if not room:
        raise AppError("房间不存在", 404)
    was_repair = room["status"] == "维修"
    fields = data.model_dump(exclude_unset=True, mode="json")
    if "hourly_price" in fields:
        # 钟点价上限：不高于该房全日价
        base = fields.get("base_price", room["base_price"]) or 0
        fields["hourly_price"] = min(fields["hourly_price"] or 0, base)
    if "room_number" in fields:
        number = fields["room_number"].strip()
        dup = conn.execute(
            "SELECT 1 FROM rooms WHERE id != ? AND store_id = ? AND room_number = ? COLLATE NOCASE",
            (room_id, fields.get("store_id", room["store_id"]), number),
        ).fetchone()
        if dup:
            raise AppError("房间号已存在")
        fields["room_number"] = number
    if "room_name" in fields:
        fields["room_name"] = fields["room_name"].strip()
    # 状态切换：存在订单时由前端提示，确认后照常切换（不再阻断）
    sets = ", ".join(f"{k} = ?" for k in fields)
    conn.execute(f"UPDATE rooms SET {sets} WHERE id = ?", (*fields.values(), room_id))
    if was_repair and "status" in fields and fields["status"] != "维修":
        _sync_room_status(conn, room_id)
    conn.commit()
    return get_room(conn, room_id)


def delete_room(conn: sqlite3.Connection, room_id: int, confirm: bool = False,
                hard: bool = False) -> None:
    """删除房间：
    - 普通删除（hard=False）= 停用/软删除：is_active=0，可恢复，历史订单关联不受影响
    - 彻底删除（hard=True）= 物理删除：仅当该房间没有任何订单记录时允许
    """
    if not confirm:
        raise AppError("请先确认删除操作（confirm=true）")
    _begin_exclusive(conn)
    try:
        room = get_room(conn, room_id)
        if not room:
            raise AppError("房间不存在", 404)
        if hard:
            order_count = conn.execute(
                "SELECT COUNT(*) AS c FROM orders WHERE room_id = ?", (room_id,)
            ).fetchone()["c"]
            if order_count:
                raise AppError(
                    f"该房间存在 {order_count} 条订单记录，无法彻底删除，建议保持停用", 409
                )
            conn.execute("DELETE FROM rooms WHERE id = ?", (room_id,))
        else:
            conn.execute("UPDATE rooms SET is_active = 0 WHERE id = ?", (room_id,))
        conn.commit()
    except Exception:
        conn.rollback()
        raise


def _count_active_orders(conn: sqlite3.Connection, room_id: int) -> int:
    row = conn.execute(
        "SELECT COUNT(*) AS c FROM orders WHERE room_id = ? AND status IN ('已预订', '已入住')",
        (room_id,),
    ).fetchone()
    return row["c"]


def _sync_room_status(conn: sqlite3.Connection, room_id: int) -> None:
    """根据房间的进行中订单自动校正房间状态（维修状态为人工设置，不覆盖）。"""
    rows = conn.execute(
        "SELECT status FROM orders WHERE room_id = ? AND status IN ('已预订', '已入住')",
        (room_id,),
    ).fetchall()
    if any(r["status"] == "已入住" for r in rows):
        target = "已入住"
    elif rows:
        target = "已预订"
    else:
        target = "空闲"
    conn.execute(
        "UPDATE rooms SET status = ? WHERE id = ? AND status != '维修'",
        (target, room_id),
    )


# ---------------- 订单 ----------------

def _order_joined(conn: sqlite3.Connection, order_id: int) -> dict | None:
    row = conn.execute(
        "SELECT o.*, r.room_number, r.room_name, r.room_category, r.base_price, r.hourly_price FROM orders o"
        " JOIN rooms r ON r.id = o.room_id WHERE o.id = ?",
        (order_id,),
    ).fetchone()
    if not row:
        return None
    order = _to_dict(row)
    order["recorded_income"] = round(
        conn.execute(
            "SELECT COALESCE(SUM(amount), 0) AS s FROM order_payments WHERE order_id = ?",
            (order_id,),
        ).fetchone()["s"],
        2,
    )
    return order


def get_all_orders(conn: sqlite3.Connection, status: str | None = None,
                   room_id: int | None = None, room_number: str | None = None,
                   guest_name: str | None = None, guest_phone: str | None = None,
                   keyword: str | None = None,
                   date_from: int | None = None, date_to: int | None = None,
                   store_id: int | None = None,
                   order_type: str | None = None,
                   guest_source: str | None = None,
                   date_mode: str = "overlap") -> list[dict]:
    """订单列表，支持按状态、类型、房间 ID、房号、客人姓名/手机号、日期范围、门店筛选。

    date_mode：
    - overlap（默认）：返回时间范围与订单占用期有重叠的所有订单（单日视图）；
    - start：按订单起始日期归属到时间范围（年/月/自定义视图）。
    """
    sql = ("SELECT o.*, r.room_number, r.room_name, r.room_category, r.base_price, r.hourly_price,"
           " (SELECT COALESCE(SUM(amount), 0) FROM order_payments p WHERE p.order_id = o.id) AS recorded_income"
           " FROM orders o JOIN rooms r ON r.id = o.room_id WHERE 1=1")
    params: list = []
    if status:
        sql += " AND o.status = ?"
        params.append(status)
    if order_type:
        sql += " AND o.order_type = ?"
        params.append(order_type)
    if room_id:
        sql += " AND o.room_id = ?"
        params.append(room_id)
    if room_number:
        sql += " AND r.room_number LIKE ?"
        params.append(f"%{room_number}%")
    if guest_name:
        sql += " AND o.guest_name LIKE ?"
        params.append(f"%{guest_name}%")
    if guest_phone:
        sql += " AND o.guest_phone LIKE ?"
        params.append(f"%{guest_phone}%")
    if keyword:
        sql += " AND (o.guest_name LIKE ? OR o.guest_phone LIKE ? OR r.room_number LIKE ? OR o.order_no LIKE ?)"
        kw = f"%{keyword}%"
        params.extend([kw, kw, kw, kw])
    if guest_source:
        sql += " AND o.guest_source = ?"
        params.append(guest_source)
    if date_from is not None and date_to is not None:
        if date_mode == "start":
            sql += " AND o.start_timestamp >= ? AND o.start_timestamp < ?"
            params.extend([date_from, date_to])
        else:
            sql += " AND o.start_timestamp < ? AND o.end_timestamp > ?"
            params.extend([date_to, date_from])
    if store_id is not None:
        sql += " AND o.room_id IN (SELECT id FROM rooms WHERE store_id = ?)"
        params.append(store_id)
    sql += " ORDER BY o.start_timestamp DESC, o.id DESC"
    return [_to_dict(r) for r in conn.execute(sql, params).fetchall()]


def get_order(conn: sqlite3.Connection, order_id: int) -> dict | None:
    return _order_joined(conn, order_id)


def get_available_rooms(conn: sqlite3.Connection, start_ts: int, end_ts: int,
                        store_id: int | None = None) -> list[dict]:
    """返回 [start_ts, end_ts) 时段内可预订的房间。

    查询所有 is_active=1 的房间，排除在该时段已有「已预订/已入住」订单的房间。
    全日租订单按 14:00 → 次日 12:00 归一化，钟点房按实际 start→end，
    两种类型的重叠均可检出（调用方需传入归一化后的时间范围）。
    """
    if end_ts <= start_ts:
        raise AppError("结束时间必须晚于开始时间")
    sql = "SELECT * FROM rooms WHERE is_active = 1"
    params: list = []
    if store_id is not None:
        sql += " AND store_id = ?"
        params.append(store_id)
    rows = conn.execute(sql, params).fetchall()
    available: list[dict] = []
    for row in rows:
        room = dict(row)
        if not check_room_conflict(conn, room["id"], start_ts, end_ts):
            available.append(room)
    return available


def create_order(conn: sqlite3.Connection, data: schemas.OrderCreate) -> dict:
    """创建订单：排他事务内完成冲突检测（含房型时间归一化）与订单号生成。"""
    _begin_exclusive(conn)
    try:
        room = get_room(conn, data.room_id)
        if not room:
            raise AppError("房间不存在", 404)
        if room.get("is_active", 1) != 1:
            raise AppError("房间已停用，无法下单")
        if data.status not in (schemas.OrderStatus.RESERVED, schemas.OrderStatus.CHECKED_IN):
            raise AppError("新订单状态只能是「已预订」或「已入住」")
        if room["status"] == "维修":
            raise AppError("房间处于维修状态，无法下单")
        if data.settle_mode not in ("once", "daily", "ondeparture"):
            raise AppError("结算方式只能是 once / daily / ondeparture")
        # 日租/钟点房：只有直接到账渠道（或未选渠道现金）才允许先付，避免进入回款等待流程
        if data.order_type in (schemas.OrderType.FULL_DAY, schemas.OrderType.HOURLY) and data.settle_mode == "once":
            _src = (data.guest_source or "").strip()
            if _src:
                _ch = conn.execute(
                    "SELECT repay_type FROM channels WHERE name = ? COLLATE NOCASE LIMIT 1", (_src,)
                ).fetchone()
                if _ch is not None and _ch["repay_type"] != "direct":
                    raise AppError("该渠道为延迟到账，日租/钟点房仅支持退房结算", status_code=400)

        start = data.start_timestamp
        if data.order_type in (schemas.OrderType.FULL_DAY, schemas.OrderType.LONG_TERM):
            end = data.end_timestamp
        else:
            end = start + int(round(data.rent_hours * 3600))
        if end <= start:
            raise AppError("结束时间必须晚于开始时间")

        # 通过 get_available_rooms 校验所选房间在该时段是否真正空闲
        available = get_available_rooms(conn, start, end)
        if data.room_id not in [r["id"] for r in available]:
            raise AppError("该房间在该时段已被预订/入住，请选择其他房间或时间", status_code=409)

        daily_price = data.daily_price if data.daily_price else 0
        total = data.total_price if data.total_price is not None else calculate_price(
            data.order_type.value, room["base_price"], start, end, data.rent_hours,
            hourly_price=room.get("hourly_price") or None,
            daily_price=daily_price,
        )
        now = now_ts()
        order_no = _next_order_no(conn, now)
        cur = conn.execute(
            "INSERT INTO orders (order_no, room_id, order_type, settle_mode, daily_discount, daily_price,"
            " guest_name, guest_phone, guest_source, remark, channel_id,"
            " start_timestamp, end_timestamp, rent_hours, total_price, status, created_at, updated_at)"
            " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (order_no, data.room_id, data.order_type.value, data.settle_mode, 0, daily_price,
             data.guest_name.strip(),
             data.guest_phone.strip(), data.guest_source.strip(), data.remark.strip(),
             data.channel_id or 0,
             start, end, data.rent_hours, total,
             data.status.value, now, now),
        )
        _sync_room_status(conn, data.room_id)
        # 先付订单：创建订单时即将金额计入收入（先付后住）
        if data.settle_mode == "once":
            # 补录订单（起始时间为过去日期）：收支备注标明补录与订单开始日期
            pay_remark = f"补录 {date_str(start)}" if start < day_start(now) else "先付"
            conn.execute(
                "INSERT INTO order_payments (order_id, amount, pay_date, remark, created_at)"
                " VALUES (?, ?, ?, ?, ?)",
                (cur.lastrowid, round(total, 2), day_start(now), pay_remark, now),
            )
            # 直接到账渠道 + 先付：创建订单即视为已回款
            if data.guest_source:
                ch = conn.execute(
                    "SELECT * FROM channels WHERE name = ? COLLATE NOCASE LIMIT 1", (data.guest_source,),
                ).fetchone()
                if ch is not None and ch["repay_type"] == "direct":
                    conn.execute(
                        "UPDATE orders SET repay_status = '已回款', actual_repay_date = ? WHERE id = ?",
                        (day_start(now), cur.lastrowid),
                    )
        conn.commit()
        return _order_joined(conn, cur.lastrowid)
    except Exception:
        conn.rollback()
        raise


def update_order(conn: sqlite3.Connection, order_id: int,
                 data: schemas.OrderUpdate) -> dict:
    """更新订单：排他事务内重新做归一化冲突检测，避免并发修改导致时间重叠。"""
    _begin_exclusive(conn)
    try:
        order = get_order(conn, order_id)
        if not order:
            raise AppError("订单不存在", 404)
        fields = data.model_dump(exclude_unset=True, mode="json")
        if "room_id" in fields and fields["room_id"] is None:
            raise AppError("房间不能为空")

        old_status = order["status"]
        new_status = fields.get("status", old_status)

        room_id = fields.get("room_id", order["room_id"])
        room = get_room(conn, room_id)
        if not room:
            raise AppError("房间不存在", 404)
        order_type = fields.get("order_type", order["order_type"])

        start = fields.get("start_timestamp", order["start_timestamp"])
        rent_hours = order.get("rent_hours")
        if order_type == "hourly":
            rent_hours = fields.get("rent_hours", rent_hours)
            if rent_hours is None:
                raise AppError("钟点房订单缺少租用时长")
            end = start + int(round(rent_hours * 3600))
        else:
            rent_hours = None
            end = fields.get("end_timestamp", order["end_timestamp"])
        if end <= start:
            raise AppError("结束时间必须晚于开始时间")

        if new_status in _ACTIVE and room["status"] == "维修":
            raise AppError("房间处于维修状态，无法办理入住")
        if new_status in _ACTIVE:
            conflicts = check_room_conflict(
                conn, room_id, start, end, exclude_order_id=order_id,
                order_type=order_type, rent_hours=rent_hours,
            )
            if conflicts:
                raise AppError("该房间在所选时间段内与已有订单冲突，请更换时间或房间", status_code=409)

        # 客人来源/渠道：订单已计入收入后禁止修改，避免收支与回款错乱
        old_source = (order.get("guest_source") or "").strip()
        new_source = (fields.get("guest_source", old_source) or "").strip()
        if ("guest_source" in fields or "channel_id" in fields) and (
                new_source != old_source
                or fields.get("channel_id", order.get("channel_id") or 0) != (order.get("channel_id") or 0)):
            has_pos = conn.execute(
                "SELECT 1 FROM order_payments WHERE order_id = ? AND amount > 0 LIMIT 1", (order_id,)
            ).fetchone()
            if has_pos:
                raise AppError("订单已计入收入，渠道/客人来源不可修改；如需更正请删除订单后重新创建", status_code=400)
        channel_id = (order.get("channel_id") or 0)
        if "guest_source" in fields or "channel_id" in fields:
            if fields.get("channel_id") not in (None, 0):
                ch_row = conn.execute(
                    "SELECT * FROM channels WHERE id = ?", (fields["channel_id"],)
                ).fetchone()
                if ch_row is None:
                    raise AppError("渠道不存在", status_code=400)
                channel_id = ch_row["id"]
                new_source = ch_row["name"]
            else:
                channel_id = 0
                if new_source:
                    ch_row = conn.execute(
                        "SELECT id FROM channels WHERE name = ? COLLATE NOCASE LIMIT 1", (new_source,)
                    ).fetchone()
                    if ch_row is not None:
                        channel_id = ch_row["id"]

        # 日租/钟点房转入先付：仅直接到账渠道允许（历史无变动编辑不误伤）
        _new_settle = fields.get("settle_mode", order.get("settle_mode", "once"))
        _source_changed = new_source != old_source
        if order_type in ("full_day", "hourly") and _new_settle == "once" and (
                order.get("settle_mode") != "once" or _source_changed):
            if new_source:
                _ch = conn.execute(
                    "SELECT repay_type FROM channels WHERE name = ? COLLATE NOCASE LIMIT 1", (new_source,)
                ).fetchone()
                if _ch is not None and _ch["repay_type"] != "direct":
                    raise AppError("该渠道为延迟到账，日租/钟点房仅支持退房结算", status_code=400)

        # 金额：手动指定优先；时间/房间/计费方式变更时按房间价格自动重算
        time_fields_changed = any(
            k in fields for k in ("start_timestamp", "end_timestamp", "rent_hours", "order_type")
        )
        extra_charge = order.get("extra_charge") or 0
        daily_price = fields.get("daily_price", order.get("daily_price") or 0)
        if "total_price" in fields:
            total = fields["total_price"]
        elif fields.get("room_id") is not None or time_fields_changed:
            total = calculate_price(
                order_type, room["base_price"], start, end, rent_hours,
                hourly_price=room.get("hourly_price") or None,
                daily_price=daily_price,
            )
        else:
            total = order["total_price"]

        conn.execute(
            "UPDATE orders SET room_id = ?, order_type = ?, settle_mode = ?, daily_discount = 0, daily_price = ?,"
            " guest_name = ?, guest_phone = ?,"
            " guest_source = ?, remark = ?, channel_id = ?, start_timestamp = ?, end_timestamp = ?, rent_hours = ?,"
            " total_price = ?, extra_charge = ?, status = ?, updated_at = ? WHERE id = ?",
            (room_id, order_type,
             fields.get("settle_mode", order.get("settle_mode", "once")),
             daily_price,
             fields.get("guest_name", order["guest_name"]).strip(),
             fields.get("guest_phone", order["guest_phone"]).strip(),
             new_source,
             fields.get("remark", order.get("remark", "")).strip(),
             channel_id,
             start, end, rent_hours, total, extra_charge, new_status, now_ts(), order_id),
        )
        # 编辑金额后：同步调整收款记录，使收支合计等于新的订单金额
        if "total_price" in fields and abs(total - order["total_price"]) > 0.001:
            pos_rows = conn.execute(
                "SELECT id FROM order_payments WHERE order_id = ? AND amount > 0 ORDER BY id",
                (order_id,),
            ).fetchall()
            if pos_rows:
                if len(pos_rows) == 1:
                    conn.execute(
                        "UPDATE order_payments SET amount = ? WHERE id = ?",
                        (round(total, 2), pos_rows[0]["id"]),
                    )
                else:
                    diff = round(total - order["total_price"], 2)
                    conn.execute(
                        "UPDATE order_payments SET amount = ROUND(amount + ?, 2) WHERE id = ?",
                        (diff, pos_rows[-1]["id"]),
                    )
        # 已退房改为未退房：撤销退房时计入的收支条目，重新退房时按动态差额重算
        if old_status == "已退房" and new_status != "已退房":
            conn.execute(
                "DELETE FROM order_payments WHERE order_id = ? AND"
                " (remark LIKE '退房%' OR remark LIKE '多收%' OR remark LIKE '少收%')",
                (order_id,),
            )
            conn.execute(
                "UPDATE orders SET adjust_amount = 0, refund_amount = 0 WHERE id = ?",
                (order_id,),
            )
        # 入住前收款（once）：编辑订单后若尚无收款记录，创建即入账
        if fields.get("settle_mode", order.get("settle_mode", "once")) == "once":
            has_income = conn.execute(
                "SELECT 1 FROM order_payments WHERE order_id = ? AND amount > 0 LIMIT 1",
                (order_id,),
            ).fetchone()
            if not has_income:
                pay_remark = f"补录 {date_str(start)}" if start < day_start(now_ts()) else "先付"
                conn.execute(
                    "INSERT INTO order_payments (order_id, amount, pay_date, remark, created_at)"
                    " VALUES (?, ?, ?, ?, ?)",
                    (order_id, round(total, 2), day_start(now_ts()), pay_remark, now_ts()),
                )
        _sync_room_status(conn, room_id)
        if room_id != order["room_id"]:
            _sync_room_status(conn, order["room_id"])
        conn.commit()
        return _order_joined(conn, order_id)
    except Exception:
        conn.rollback()
        raise


def checkin_order(conn: sqlite3.Connection, order_id: int) -> dict:
    """办理入住：将订单从「已预订」改为「已入住」（排他事务）。"""
    _begin_exclusive(conn)
    try:
        order = get_order(conn, order_id)
        if not order:
            raise AppError("订单不存在", 404)
        if order["status"] != "已预订":
            raise AppError("只有「已预订」状态的订单才能办理入住")
        room = get_room(conn, order["room_id"])
        if room["status"] == "维修":
            raise AppError("房间处于维修状态，无法入住")
        conn.execute(
            "UPDATE orders SET status = '已入住', updated_at = ? WHERE id = ?",
            (now_ts(), order_id),
        )
        # 一次性结算（先付后住）：办理入住时按入住日计入收入
        if order.get("settle_mode", "once") == "once":
            has_income = conn.execute(
                "SELECT 1 FROM order_payments WHERE order_id = ? AND amount > 0 LIMIT 1",
                (order_id,),
            ).fetchone()
            if not has_income:
                conn.execute(
                    "INSERT INTO order_payments (order_id, amount, pay_date, remark, created_at)"
                    " VALUES (?, ?, ?, '入住前实收', ?)",
                    (order_id, round(order["total_price"] or 0, 2), day_start(now_ts()), now_ts()),
                )
        _sync_room_status(conn, order["room_id"])
        conn.commit()
        return _order_joined(conn, order_id)
    except Exception:
        conn.rollback()
        raise


def checkout_order(conn: sqlite3.Connection, order_id: int,
                   end_timestamp: int | None = None,
                   total_price: float | None = None,
                   refund_amount: float | None = None,
                   confirm: bool = False) -> dict:
    """办理退房：改为「已退房」并生成收入/退款记录。
    - 退房结算（ondeparture）：退房时按实收金额记一笔收入；
    - 一次性（once）：入住时已入账（先付后住），退房不再入账（旧订单未入账时补记）；
    - 日结（daily）：收入已按日标记，退房仅结束订单；
    - 退回金额：记负收入，从收入中扣除。

    二次确认：必须显式传入 confirm=True，防止误触/误调用。
    """
    if not confirm:
        raise AppError("请先确认退房操作（confirm=true）")
    _begin_exclusive(conn)
    try:
        order = get_order(conn, order_id)
        if not order:
            raise AppError("订单不存在", 404)
        if order["status"] != "已入住":
            raise AppError("只有「已入住」状态的订单才能退房")
        end = end_timestamp if end_timestamp is not None else now_ts()
        if end <= order["start_timestamp"]:
            raise AppError("退房时间必须晚于入住时间")
        now = now_ts()
        refund = refund_amount or 0
        final_total = total_price if total_price is not None else order["total_price"]
        pay_date = day_start(end)

        # 动态差额入账：只补记已收与实收之间的差额，避免重复退房重复计算
        booked = round(order["total_price"] or 0, 2)
        received = round(final_total, 2)
        adjust = round(received - booked, 2)  # 多收为正、少收为负
        pos_sum = conn.execute(
            "SELECT COALESCE(SUM(amount), 0) FROM order_payments"
            " WHERE order_id = ? AND amount > 0",
            (order_id,),
        ).fetchone()[0] or 0
        diff = round(received - pos_sum, 2)
        marker = ''
        if abs(adjust) > 0.001:
            marker = f"多收{abs(adjust):g}" if adjust > 0 else f"少收{abs(adjust):g}"
        if diff > 0.001:
            remark = marker if marker else '退房结算'
            conn.execute(
                "INSERT INTO order_payments (order_id, amount, pay_date, remark, created_at)"
                " VALUES (?, ?, ?, ?, ?)",
                (order_id, diff, pay_date, remark, now),
            )
        elif diff < -0.001:
            remark = marker if marker else '退房退回'
            conn.execute(
                "INSERT INTO order_payments (order_id, amount, pay_date, remark, created_at)"
                " VALUES (?, ?, ?, ?, ?)",
                (order_id, diff, pay_date, remark, now),
            )
        if refund > 0:
            conn.execute(
                "INSERT INTO order_payments (order_id, amount, pay_date, remark, created_at)"
                " VALUES (?, ?, ?, '退房退回', ?)",
                (order_id, -round(refund, 2), pay_date, now),
            )

        # 回款：按订单渠道（guest_source 匹配渠道表）规则计算预计到账日期；
        # 日结订单已按日收款（现金到账），退房时不再重置为待回款
        repay_status = ""
        expected_repay = None
        channel_row = None
        daily_paid = order.get("settle_mode") == "daily" and conn.execute(
            "SELECT 1 FROM order_payments WHERE order_id = ? AND amount > 0 LIMIT 1", (order_id,)
        ).fetchone() is not None
        if daily_paid:
            repay_status = "已回款"
        if order.get("guest_source") and not daily_paid:
            channel_row = conn.execute(
                "SELECT * FROM channels WHERE name = ? COLLATE NOCASE LIMIT 1", (order["guest_source"],),
            ).fetchone()
        if channel_row is not None:
            ch = dict(channel_row)
            expected_repay = calculate_expected_repay_date(
                day_start(end), ch["repay_type"], ch["repay_days"], ch["repay_weekday"], ch["repay_monthday"],
            )
            repay_status = "已回款" if ch["repay_type"] == "direct" else "待回款"
        channel_id = order.get("channel_id") or (channel_row["id"] if channel_row is not None else 0)
        # 待回款：给最新正数收款记录备注预计回款日期
        if repay_status == "待回款" and expected_repay:
            lp = conn.execute(
                "SELECT id FROM order_payments WHERE order_id = ? AND amount > 0 ORDER BY id DESC LIMIT 1", (order_id,),
            ).fetchone()
            if lp is not None:
                conn.execute(
                    "UPDATE order_payments SET remark = remark || '·预计 ' || ? || ' 回款' WHERE id = ?",
                    (date_str(expected_repay), lp["id"]),
                )
        # settle segments: per-orig/extend independent repay schedule (extension special)
        seg_repay = repay_status
        ch_type = ch["repay_type"] if channel_row is not None else "direct"
        ch_days = ch["repay_days"] if channel_row is not None else 0
        ch_wd = ch["repay_weekday"] if channel_row is not None else 1
        ch_md = ch["repay_monthday"] if channel_row is not None else 1
        has_seg = conn.execute("SELECT 1 FROM order_settle_segments WHERE order_id = ? LIMIT 1", (order_id,)).fetchone()
        if order.get("orig_end_timestamp") or has_seg:
            if order.get("orig_end_timestamp"):
                exp_orig = calculate_expected_repay_date(
                    day_start(order["orig_end_timestamp"]), ch_type, ch_days, ch_wd, ch_md,
                )
                exists_orig = conn.execute(
                    "SELECT 1 FROM order_settle_segments WHERE order_id = ? AND kind = 'orig' LIMIT 1", (order_id,),
                ).fetchone()
                if not exists_orig:
                    remark_orig = "\u539f\u8ba2\u5355"  # 原订单
                    conn.execute(
                        "INSERT INTO order_settle_segments (order_id, kind, amount, settle_date, repay_status, expected_repay_date, remark, created_at)"
                        " VALUES (?, 'orig', ?, ?, ?, ?, ?, ?)",
                        (order_id, round(order.get("orig_total_price") or order["total_price"], 2),
                         day_start(order["orig_end_timestamp"]), seg_repay, exp_orig, remark_orig, now),
                    )
            for seg in conn.execute(
                "SELECT id, settle_date FROM order_settle_segments WHERE order_id = ? AND kind = 'extend' AND repay_status = ''",
                (order_id,),
            ).fetchall():
                exp_seg = calculate_expected_repay_date(
                    day_start(seg["settle_date"] or end), ch_type, ch_days, ch_wd, ch_md,
                )
                conn.execute(
                    "UPDATE order_settle_segments SET repay_status = ?, expected_repay_date = ? WHERE id = ?",
                    (seg_repay, exp_seg, seg["id"]),
                )
        conn.execute(

            "UPDATE orders SET status = '已退房', end_timestamp = ?,"
            " total_price = ?, adjust_amount = ?, refund_amount = ?, repay_status = ?,"
            " expected_repay_date = ?, channel_id = ?, updated_at = ? WHERE id = ?",
            (end, booked, adjust, round(refund, 2), repay_status, expected_repay, channel_id, now, order_id),
        )
        conn.execute("UPDATE rooms SET need_clean = 1 WHERE id = ?", (order["room_id"],))
        _sync_room_status(conn, order["room_id"])
        conn.commit()
        return _order_joined(conn, order_id)
    except Exception:
        conn.rollback()
        raise


def mark_order_repaid(conn: sqlite3.Connection, order_id: int,
                      actual_repay_date: int | None = None) -> dict:
    """标记订单已回款：写入实际到账日期。"""
    order = get_order(conn, order_id)
    if not order:
        raise AppError("订单不存在", 404)
    if order["status"] != "已退房":
        raise AppError("只有已退房订单才能标记回款")
    actual = actual_repay_date or day_start(now_ts())
    conn.execute(
        "UPDATE orders SET repay_status = '已回款', actual_repay_date = ?, updated_at = ? WHERE id = ?",
        (actual, now_ts(), order_id),
    )
    conn.commit()
    return _order_joined(conn, order_id)


def cancel_order(conn: sqlite3.Connection, order_id: int,
                 refund_amount: float | None = None,
                 confirm: bool = False) -> dict:
    """取消订单：状态改为「已取消」。
    已计入收入的订单可填退回金额（负收入记录，从收入中扣除）；
    未计入收入的订单无需退回。
    """
    if not confirm:
        raise AppError("请先确认取消操作（confirm=true）")
    _begin_exclusive(conn)
    try:
        order = get_order(conn, order_id)
        if not order:
            raise AppError("订单不存在", 404)
        if order["status"] in ("已退房", "已取消"):
            raise AppError("该订单已结束，无法取消")
        now = now_ts()
        refund = refund_amount or 0
        recorded = order.get("recorded_income") or 0
        if refund > 0 and recorded <= 0:
            raise AppError("该订单尚未计入收入，无需退回金额")
        if refund > 0:
            conn.execute(
                "INSERT INTO order_payments (order_id, amount, pay_date, remark, created_at)"
                " VALUES (?, ?, ?, '取消退回', ?)",
                (order_id, -round(refund, 2), day_start(now), now),
            )
        conn.execute(
            "UPDATE orders SET status = '已取消', refund_amount = ?, updated_at = ? WHERE id = ?",
            (round(refund, 2), now, order_id),
        )
        _sync_room_status(conn, order["room_id"])
        conn.commit()
        return _order_joined(conn, order_id)
    except Exception:
        conn.rollback()
        raise


def extend_order(conn: sqlite3.Connection, order_id: int, count: float,
                 amount: float | None = None,
                 confirm: bool = False) -> dict:
    """续住：全日租/长租按天续住，钟点房按小时续住。
    续住金额按当前计费方案计算（长租含每日优惠），并做冲突检测。
    """
    if not confirm:
        raise AppError("请先确认续住操作（confirm=true）")
    if count <= 0:
        raise AppError("续住数量必须大于 0")
    _begin_exclusive(conn)
    try:
        order = get_order(conn, order_id)
        if not order:
            raise AppError("订单不存在", 404)
        if order["status"] not in _ACTIVE:
            raise AppError("只有进行中的订单才能续住")
        room = get_room(conn, order["room_id"])
        if not room:
            raise AppError("房间不存在", 404)

        if order["order_type"] == "hourly":
            extra_hours = count
            rent_hours = (order.get("rent_hours") or 0) + extra_hours
            start = order["start_timestamp"]
            end = start + int(round(rent_hours * 3600))
            # 与创建订单一致：按日租价/24 折算小时单价
            rate = max(0.0, room["base_price"]) / 24.0
            extra_price = round(rate * extra_hours, 2)
        else:
            extra_days = int(math.ceil(count))
            start = order["start_timestamp"]
            end = order["end_timestamp"] + extra_days * 86400
            daily_price = order.get("daily_price") or 0
            rate = daily_price if daily_price > 0 else max(0.0, room["base_price"])
            extra_price = round(rate * extra_days, 2)
        if amount is not None:
            # 续住金额可手动调整
            extra_price = round(amount, 2)
        # extend snapshot: record original end/price on first extension
        first_extend = (order.get("orig_end_timestamp") is None) and order["order_type"] != "hourly"
        orig_end_snap = order["end_timestamp"]
        orig_total_snap = order["total_price"]

        if end <= start:
            raise AppError("结束时间必须晚于开始时间")
        conflicts = check_room_conflict(
            conn, order["room_id"], start, end,
            exclude_order_id=order_id, order_type=order["order_type"],
            rent_hours=order.get("rent_hours"),
        )
        if conflicts:
            raise AppError("续住时间段与已有订单冲突，无法续住", status_code=409)

        total = round((order["total_price"] or 0) + extra_price, 2)
        # 钟点房：计费上限随超时逐日上调（每超过一个次日 12:00 加一晚日租价）
        if order["order_type"] == "hourly":
            _nights = 1
            _boundary = day_start(order["start_timestamp"]) + 36 * 3600
            while end > _boundary:
                _nights += 1
                _boundary += 86400
            total = round(min(total, max(0.0, room["base_price"]) * _nights), 2)
        if order["order_type"] == "hourly":
            conn.execute(
                "UPDATE orders SET end_timestamp = ?, rent_hours = ?, total_price = ?, updated_at = ?"
                " WHERE id = ?",
                (end, rent_hours, total, now_ts(), order_id),
            )
        else:
            conn.execute(
                "UPDATE orders SET end_timestamp = ?, total_price = ?,"
                " orig_end_timestamp = CASE WHEN orig_end_timestamp IS NULL THEN ? ELSE orig_end_timestamp END,"
                " orig_total_price = CASE WHEN orig_total_price IS NULL THEN ? ELSE orig_total_price END,"
                " updated_at = ? WHERE id = ?",
                (end, total, orig_end_snap, orig_total_snap, now_ts(), order_id),
            )
        # 先付（once）且已入住的订单：续住金额按续住日计入收入（先付后住），
        # 避免续住收入不计入或延后到退房日
        if order.get("settle_mode", "once") == "once" and order["status"] == "已入住":
            conn.execute(
                "INSERT INTO order_payments (order_id, amount, pay_date, remark, created_at)"
                " VALUES (?, ?, ?, '续住收款', ?)",
                (order_id, extra_price, day_start(now_ts()), now_ts()),
            )
        # extend segment: independent settle/repay record per extension
        seg_remark = "\u7eed\u4f4f " + ("%g" % count) + ("\u5c0f\u65f6" if order["order_type"] == "hourly" else "\u5929") + "\uff08\u81f3 " + date_str(end) + "\uff09"
        conn.execute(
            "INSERT INTO order_settle_segments (order_id, kind, amount, settle_date, repay_status, remark, created_at)"
            " VALUES (?, 'extend', ?, ?, '', ?, ?)",
            (order_id, extra_price, day_start(end), seg_remark, now_ts()),
        )
        conn.commit()
        return _order_joined(conn, order_id)
    except Exception:
        conn.rollback()
        raise


def list_settle_segments(conn: sqlite3.Connection, order_id: int) -> list[dict]:
    """订单续住分段结算与回款记录（orig 原段 / extend 续住段）。"""
    rows = conn.execute(
        "SELECT * FROM order_settle_segments WHERE order_id = ? ORDER BY id", (order_id,),
    ).fetchall()
    return [_to_dict(r) for r in rows]


def list_order_payments(conn: sqlite3.Connection, order_id: int) -> list[dict]:
    """订单的收款记录（正数收入 / 负数退款）。"""
    order = get_order(conn, order_id)
    if not order:
        raise AppError("订单不存在", 404)
    rows = conn.execute(
        "SELECT * FROM order_payments WHERE order_id = ? ORDER BY pay_date, id",
        (order_id,),
    ).fetchall()
    return [_to_dict(r) for r in rows]


def upsert_order_payment(conn: sqlite3.Connection, order_id: int,
                         data: schemas.PaymentCreate) -> dict:
    """按日期标记已收当日款：同一天重复提交则更新金额（实收金额可修改）。"""
    order = get_order(conn, order_id)
    if not order:
        raise AppError("订单不存在", 404)
    if order["status"] not in _ACTIVE + ("已退房",):
        raise AppError("该订单状态不允许收款")
    amount = round(data.amount, 2)
    pay_date = day_start(data.pay_date)
    existing = conn.execute(
        "SELECT id FROM order_payments WHERE order_id = ? AND pay_date = ? AND amount > 0",
        (order_id, pay_date),
    ).fetchone()
    now = now_ts()
    if existing:
        conn.execute(
            "UPDATE order_payments SET amount = ?, remark = '日结收款', account_date = ?, created_at = ? WHERE id = ?",
            (amount, day_start(now), now, existing["id"]),
        )
        row = conn.execute(
            "SELECT * FROM order_payments WHERE id = ?", (existing["id"],)
        ).fetchone()
    else:
        cur = conn.execute(
            "INSERT INTO order_payments (order_id, amount, pay_date, account_date, remark, created_at)"
            " VALUES (?, ?, ?, ?, '日结收款', ?)",
            (order_id, amount, pay_date, day_start(now), now),
        )
        row = conn.execute(
            "SELECT * FROM order_payments WHERE id = ?", (cur.lastrowid,)
        ).fetchone()
    # 日结收款为现金到账：收款后直接标记已回款
    if amount > 0 and order.get("settle_mode") == "daily":
        conn.execute(
            "UPDATE orders SET repay_status = '已回款', actual_repay_date = ?, updated_at = ? WHERE id = ?",
            (day_start(now), now, order_id),
        )
    conn.commit()
    return _to_dict(row)


def delete_order(conn: sqlite3.Connection, order_id: int, confirm: bool = False) -> None:
    """删除订单（二次确认后执行，排他事务）。"""
    if not confirm:
        raise AppError("请先确认删除操作（confirm=true）")
    _begin_exclusive(conn)
    try:
        order = get_order(conn, order_id)
        if not order:
            raise AppError("订单不存在", 404)
        conn.execute("DELETE FROM orders WHERE id = ?", (order_id,))
        _sync_room_status(conn, order["room_id"])
        conn.commit()
    except Exception:
        conn.rollback()
        raise


# ---------------- 门店 ----------------

def list_stores(conn: sqlite3.Connection) -> list[dict]:
    rows = conn.execute("SELECT * FROM stores ORDER BY id").fetchall()
    return [_to_dict(r) for r in rows]


def create_store(conn: sqlite3.Connection, data: schemas.StoreCreate) -> dict:
    name = data.name.strip()
    if not name:
        raise AppError("门店名称不能为空")
    dup = conn.execute(
        "SELECT 1 FROM stores WHERE name = ? COLLATE NOCASE", (name,)
    ).fetchone()
    if dup:
        raise AppError("门店名称已存在")
    cur = conn.execute(
        "INSERT INTO stores (name, created_at) VALUES (?, ?)", (name, now_ts())
    )
    conn.commit()
    return _to_dict(conn.execute("SELECT * FROM stores WHERE id = ?", (cur.lastrowid,)).fetchone())


def update_store(conn: sqlite3.Connection, store_id: int,
                 data: schemas.StoreUpdate) -> dict:
    store = conn.execute("SELECT * FROM stores WHERE id = ?", (store_id,)).fetchone()
    if not store:
        raise AppError("门店不存在", 404)
    name = data.name.strip()
    if not name:
        raise AppError("门店名称不能为空")
    dup = conn.execute(
        "SELECT 1 FROM stores WHERE id != ? AND name = ? COLLATE NOCASE",
        (store_id, name),
    ).fetchone()
    if dup:
        raise AppError("门店名称已存在")
    conn.execute("UPDATE stores SET name = ? WHERE id = ?", (name, store_id))
    conn.commit()
    return _to_dict(conn.execute("SELECT * FROM stores WHERE id = ?", (store_id,)).fetchone())


def delete_store(conn: sqlite3.Connection, store_id: int, confirm: bool = False) -> None:
    """删除门店（二次确认；至少保留一个门店，且门店下不能有房间）。"""
    if not confirm:
        raise AppError("请先确认删除操作（confirm=true）")
    store = conn.execute("SELECT * FROM stores WHERE id = ?", (store_id,)).fetchone()
    if not store:
        raise AppError("门店不存在", 404)
    total = conn.execute("SELECT COUNT(*) AS c FROM stores").fetchone()["c"]
    if total <= 1:
        raise AppError("至少保留一个门店")
    room_count = conn.execute(
        "SELECT COUNT(*) AS c FROM rooms WHERE store_id = ?", (store_id,)
    ).fetchone()["c"]
    if room_count:
        raise AppError("该门店下还有房间，请先删除或转移房间")
    conn.execute("DELETE FROM stores WHERE id = ?", (store_id,))
    conn.commit()


# ---------------- 统计 / 房态 ----------------

def get_today_statistics(conn: sqlite3.Connection, date_ts: int | None = None) -> dict:
    """指定日期统计：应到人数、应退人数、当日收入；不传日期时按今天计算。"""
    day = day_start(date_ts) if date_ts is not None else day_start(now_ts())
    tomorrow = day + 86400
    expected_arrivals = conn.execute(
        "SELECT COUNT(*) AS c FROM orders WHERE status IN ('已预订', '已入住')"
        " AND start_timestamp >= ? AND start_timestamp < ?",
        (day, tomorrow),
    ).fetchone()["c"]
    expected_checkouts = conn.execute(
        "SELECT COUNT(*) AS c FROM orders WHERE status IN ('已预订', '已入住')"
        " AND end_timestamp >= ? AND end_timestamp < ?",
        (day, tomorrow),
    ).fetchone()["c"]
    pay_revenue = conn.execute(
        "SELECT COALESCE(SUM(amount), 0) AS s FROM order_payments"
        " WHERE COALESCE(account_date, pay_date) >= ? AND COALESCE(account_date, pay_date) < ? AND amount > 0",
        (day, tomorrow),
    ).fetchone()["s"]
    manual_revenue = conn.execute(
        "SELECT COALESCE(SUM(amount), 0) AS s FROM expenses"
        " WHERE kind = 'income' AND expense_date >= ? AND expense_date < ?",
        (day, tomorrow),
    ).fetchone()["s"]
    today_revenue = (pay_revenue or 0) + (manual_revenue or 0)
    # 总销售额：当日已退房订单金额合计
    total_sales = conn.execute(
        "SELECT COALESCE(SUM(total_price), 0) AS s FROM orders"
        " WHERE status = '已退房' AND end_timestamp >= ? AND end_timestamp < ?",
        (day, tomorrow),
    ).fetchone()["s"]
    # 今日回款：已回款订单中实际到账日期为当天的金额
    today_repay = conn.execute(
        "SELECT COALESCE(SUM(total_price), 0) AS s FROM orders"
        " WHERE repay_status = '已回款' AND actual_repay_date >= ? AND actual_repay_date < ?",
        (day, tomorrow),
    ).fetchone()["s"]
    # 待回款：所有待回款订单金额合计
    pending_repay = conn.execute(
        "SELECT COALESCE(SUM(total_price), 0) AS s FROM orders WHERE repay_status = '待回款'",
    ).fetchone()["s"]
    return {
        "expected_arrivals": expected_arrivals,
        "expected_checkouts": expected_checkouts,
        "today_revenue": round(today_revenue or 0, 2),
        "total_sales": round(total_sales or 0, 2),
        "today_repay": round(today_repay or 0, 2),
        "pending_repay": round(pending_repay or 0, 2),
    }


def get_room_status_by_date(conn: sqlite3.Connection, room_id: int, date_ts: int) -> str:
    """获取某房间在某天的状态：空闲 / 已预订 / 已入住 / 维修。"""
    room = get_room(conn, room_id)
    if not room:
        raise AppError("房间不存在", 404)
    if room["status"] == "维修":
        return "维修"
    start = day_start(date_ts)
    end = day_end(date_ts)
    rows = conn.execute(
        "SELECT status FROM orders WHERE room_id = ? AND status IN ('已预订', '已入住')"
        " AND start_timestamp < ? AND end_timestamp > ?",
        (room_id, end, start),
    ).fetchall()
    if any(r["status"] == "已入住" for r in rows):
        return "已入住"
    if rows:
        return "已预订"
    return "空闲"


def _day_segments(conn: sqlite3.Connection, room: dict, day_ts: int) -> list[dict]:
    """计算某房间在某自然日内的占用时间段（归一化后裁剪到当天，包含已退房订单）。"""
    day_start_ts = day_start(day_ts)
    day_end_ts = day_end(day_ts)
    rows = conn.execute(
        "SELECT id, order_no, order_type, settle_mode, daily_discount, daily_price, status,"
        " start_timestamp, end_timestamp, rent_hours,"
        " guest_name, guest_source, total_price"
        " FROM orders WHERE room_id = ? AND status IN ('已预订', '已入住', '已退房')"
        " AND start_timestamp < ? AND end_timestamp > ? ORDER BY start_timestamp",
        (room["id"], day_end_ts, day_start_ts),
    ).fetchall()
    # 已收款日期集合（日结订单按日标记）
    order_ids = [r["id"] for r in rows]
    paid_set: set[tuple[int, int]] = set()
    if order_ids:
        placeholders = ",".join("?" * len(order_ids))
        pay_rows = conn.execute(
            f"SELECT order_id, pay_date FROM order_payments"
            f" WHERE order_id IN ({placeholders}) AND amount > 0",
            order_ids,
        ).fetchall()
        paid_set = {(r["order_id"], r["pay_date"]) for r in pay_rows}
        auto_rows = conn.execute(
            f"SELECT DISTINCT order_id FROM automation_logs"
            f" WHERE order_id IN ({placeholders}) AND rolled_back = 0",
            order_ids,
        ).fetchall()
        auto_ids = {r["order_id"] for r in auto_rows}
    segments: list[dict] = []
    for row in rows:
        o_start, o_end = normalize_order_range(
            row["order_type"], row["start_timestamp"], row["end_timestamp"], row["rent_hours"]
        )
        seg_start = max(o_start, day_start_ts)
        seg_end = min(o_end, day_end_ts)
        if seg_end <= seg_start:
            continue
        # 收款日规则：只有过夜日才单独收款；退房日（不过夜）并入前一天
        is_checkout_day = False
        pay_ref_day = day_start_ts
        checkout_day = 0
        if row["order_type"] in ("full_day", "long_term"):
            checkout_day = day_start(row["end_timestamp"])
            if checkout_day > day_start(row["start_timestamp"]) and day_start_ts == checkout_day:
                is_checkout_day = True
                pay_ref_day = checkout_day - 86400
        paid = (row["id"], pay_ref_day) in paid_set
        if row["order_type"] == "hourly":
            rate = room.get("hourly_price") or (room["base_price"] / 24.0)
            daily_price = round(rate * (row["rent_hours"] or 1), 2)
        else:
            order_daily = row["daily_price"] or 0
            daily_price = round(
                order_daily if order_daily > 0
                else max(0.0, room["base_price"] - (row["daily_discount"] or 0)), 2
            )
        segments.append({
            "start": seg_start,
            "end": seg_end,
            "order_type": row["order_type"],
            "settle_mode": row["settle_mode"],
            "daily_discount": row["daily_discount"] or 0,
            "daily_price": daily_price,
            "paid": paid,
            "is_checkout_day": is_checkout_day,
            "checkout_day": checkout_day,
            "status": row["status"],
            "order_no": row["order_no"],
            "order_id": row["id"],
            "guest_name": row["guest_name"],
            "guest_source": row["guest_source"],
            "total_price": row["total_price"],
            "auto": row["id"] in auto_ids,
        })
    return segments


def get_room_status_by_date_range(conn: sqlite3.Connection, start_ts: int, end_ts: int,
                                  room_id: int | None = None,
                                  store_id: int | None = None) -> dict:
    """获取日期范围内所有房间的逐日状态与占用时间段（用于房态图），最多 93 天。

    每个房间每天返回 statuses（空闲/已预订/已入住/维修）与 segments（占用时间段列表），
    前端据此区分「全日占满（红）」与「钟点占用（橙）」，并标注时间段。
    """
    first = day_start(start_ts)
    last = day_start(end_ts)
    if last < first:
        raise AppError("开始日期不能晚于结束日期")
    days: list[int] = []
    t = first
    while t <= last:
        days.append(t)
        t += 86400
    if len(days) > 93:
        raise AppError("日期范围不能超过 93 天")

    rooms = [get_room(conn, room_id)] if room_id else get_all_rooms(conn, store_id=store_id)
    result_rooms = []
    for r in rooms:
        statuses: dict[str, str] = {}
        segments: dict[str, list[dict]] = {}
        for d in days:
            date_key = date_str(d)
            segs = _day_segments(conn, r, d)
            segments[date_key] = segs
            active_segs = [s for s in segs if s["status"] != "已退房"]
            if r["status"] == "维修":
                statuses[date_key] = "维修"
            elif not active_segs:
                statuses[date_key] = "空闲"
            else:
                full_days = [s for s in active_segs if s["order_type"] in ("full_day", "long_term")]
                if full_days:
                    statuses[date_key] = (
                        "已入住" if any(s["status"] == "已入住" for s in full_days) else "已预订"
                    )
                else:
                    statuses[date_key] = (
                        "已入住" if any(s["status"] == "已入住" for s in active_segs) else "已预订"
                    )
        result_rooms.append({
            "room_id": r["id"],
            "room_number": r["room_number"],
            "room_name": r["room_name"],
            "room_category": r["room_category"],
            "base_price": r["base_price"],
            "statuses": statuses,
            "segments": segments,
        })
    return {
        "start_date": date_str(first),
        "end_date": date_str(last),
        "days": [date_str(d) for d in days],
        "rooms": result_rooms,
    }


def get_stats(conn: sqlite3.Connection) -> dict:
    """工作台统计（房间状态分布、进行中订单、今日订单/退房/收入等）。"""
    now = now_ts()
    today_start = day_start(now)
    tomorrow_start = day_end(now)

    total_rooms = conn.execute("SELECT COUNT(*) AS c FROM rooms").fetchone()["c"]
    room_rows = conn.execute("SELECT status, COUNT(*) AS c FROM rooms GROUP BY status").fetchall()
    rooms_by_status = {r["status"]: r["c"] for r in room_rows}
    active_orders = conn.execute(
        "SELECT COUNT(*) AS c FROM orders WHERE status IN ('已预订', '已入住')"
    ).fetchone()["c"]
    today_new_orders = conn.execute(
        "SELECT COUNT(*) AS c FROM orders WHERE created_at >= ? AND created_at < ?",
        (today_start, tomorrow_start),
    ).fetchone()["c"]
    today_checkout_count = conn.execute(
        "SELECT COUNT(*) AS c FROM orders WHERE status = '已退房'"
        " AND end_timestamp >= ? AND end_timestamp < ?",
        (today_start, tomorrow_start),
    ).fetchone()["c"]
    today_revenue = conn.execute(
        "SELECT COALESCE(SUM(amount), 0) AS s FROM order_payments"
        " WHERE pay_date >= ? AND pay_date < ?",
        (today_start, tomorrow_start),
    ).fetchone()["s"]
    upcoming_arrivals = conn.execute(
        "SELECT COUNT(*) AS c FROM orders WHERE status = '已预订'"
        " AND start_timestamp >= ? AND start_timestamp < ?",
        (now, now + 86400),
    ).fetchone()["c"]
    return {
        "total_rooms": total_rooms,
        "rooms_by_status": rooms_by_status,
        "active_orders": active_orders,
        "today_new_orders": today_new_orders,
        "today_checkout_count": today_checkout_count,
        "today_revenue": round(today_revenue or 0, 2),
        "upcoming_arrivals": upcoming_arrivals,
    }


# ---------------- 设置 ----------------

def list_settings(conn: sqlite3.Connection) -> list[dict]:
    rows = conn.execute(
        "SELECT key, value, description FROM settings ORDER BY rowid"
    ).fetchall()
    return [_to_dict(r) for r in rows]


def update_settings(conn: sqlite3.Connection, items: dict[str, str]) -> list[dict]:
    for key, value in items.items():
        conn.execute(
            "INSERT INTO settings (key, value, description) VALUES (?, ?, '')"
            " ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (key, str(value)),
        )
    conn.commit()
    return list_settings(conn)


# ---------------- 入住渠道 ----------------

def list_channels(conn: sqlite3.Connection) -> list[dict]:
    rows = conn.execute("SELECT * FROM channels ORDER BY sort_order, id").fetchall()
    return [_to_dict(r) for r in rows]


def create_channel(conn: sqlite3.Connection, data: schemas.ChannelCreate) -> dict:
    name = data.name.strip()
    if not name:
        raise AppError("渠道名称不能为空")
    dup = conn.execute(
        "SELECT 1 FROM channels WHERE name = ? COLLATE NOCASE", (name,)
    ).fetchone()
    if dup:
        raise AppError("渠道名称已存在")
    cur = conn.execute(
        "INSERT INTO channels (name, color, sort_order, repay_type, repay_days, repay_weekday, repay_monthday)"
        " VALUES (?, ?, ?, ?, ?, ?, ?)",
        (name, data.color, data.sort_order, data.repay_type, data.repay_days,
         data.repay_weekday, data.repay_monthday),
        )
    return _to_dict(
        conn.execute("SELECT * FROM channels WHERE id = ?", (cur.lastrowid,)).fetchone()
    )


def update_channel(conn: sqlite3.Connection, channel_id: int,
                   data: schemas.ChannelUpdate) -> dict:
    channel = conn.execute("SELECT * FROM channels WHERE id = ?", (channel_id,)).fetchone()
    if not channel:
        raise AppError("渠道不存在", 404)
    fields = data.model_dump(exclude_unset=True, mode="json")
    if "name" in fields:
        name = fields["name"].strip()
        if not name:
            raise AppError("渠道名称不能为空")
        dup = conn.execute(
            "SELECT 1 FROM channels WHERE id != ? AND name = ? COLLATE NOCASE",
            (channel_id, name),
        ).fetchone()
        if dup:
            raise AppError("渠道名称已存在")
        fields["name"] = name
    sets = ", ".join(f"{k} = ?" for k in fields)
    conn.execute(
        f"UPDATE channels SET {sets} WHERE id = ?", (*fields.values(), channel_id)
    )
    conn.commit()
    return _to_dict(
        conn.execute("SELECT * FROM channels WHERE id = ?", (channel_id,)).fetchone()
    )


def delete_channel(conn: sqlite3.Connection, channel_id: int,
                   confirm: bool = False) -> None:
    """删除入住渠道（二次确认；至少保留一个渠道）。"""
    if not confirm:
        raise AppError("请先确认删除操作（confirm=true）")
    channel = conn.execute("SELECT * FROM channels WHERE id = ?", (channel_id,)).fetchone()
    if not channel:
        raise AppError("渠道不存在", 404)
    total = conn.execute("SELECT COUNT(*) AS c FROM channels").fetchone()["c"]
    if total <= 1:
        raise AppError("至少保留一个入住渠道")
    conn.execute("DELETE FROM channels WHERE id = ?", (channel_id,))
    conn.commit()


# ---------------- 收入统计 ----------------

def get_revenue_statistics(conn: sqlite3.Connection,
                           store_id: int | None = None,
                           start_ts: int | None = None,
                           end_ts: int | None = None,
                           repay: str = "",
                           gran: str = "month",
                           guest_source: str | None = None,
                           kind_filter: str = "",
                           keyword: str | None = None) -> dict:
    """收支统计：可按门店与时间范围筛选。
    收入 = 收款记录（正数，含退房入账/日结收款）；
    支出 = 退费（负数收款） + 手工支出；
    净收益 = 收入 - 支出。

    gran 决定明细粒度：
    - year   按月份汇总（YYYY-MM）
    - month  按日期汇总（YYYY-MM-DD）
    - day    具体到每一笔收入/支出
    - custom 按日期汇总（同 month）
    """
    where = " WHERE 1=1"
    params: list = []
    if store_id is not None:
        where += " AND r.store_id = ?"
        params.append(store_id)
    if start_ts is not None and end_ts is not None:
        where += " AND COALESCE(p.account_date, p.pay_date) >= ? AND COALESCE(p.account_date, p.pay_date) < ?"
        params.extend([start_ts, end_ts])
    if keyword:
        where += " AND (o.guest_name LIKE ? OR o.guest_phone LIKE ? OR r.room_number LIKE ? OR o.order_no LIKE ?)"
        kw = f"%{keyword.strip()}%"
        params.extend([kw, kw, kw, kw])
    if guest_source:
        where += " AND o.guest_source = ?"
        params.append(guest_source)
    # 回款/收支类型筛选只作用于列表明细，统计卡片保持当前周期全量
    repay_filter = repay if repay in ("待回款", "已回款") else ""

    sel = ("SELECT p.amount, p.pay_date, p.created_at, p.remark AS pay_remark, o.id AS order_id,"
           " COALESCE(p.account_date, p.pay_date) AS acc_date,"
           " o.order_no, o.guest_name,"
           " o.guest_source, o.repay_status, r.room_number"
           " FROM orders o JOIN rooms r ON r.id = o.room_id"
           " JOIN order_payments p ON p.order_id = o.id")
    income_all = conn.execute(sel + where + " AND p.amount > 0 ORDER BY acc_date", params).fetchall()
    refund_all = conn.execute(sel + where + " AND p.amount < 0 ORDER BY acc_date", params).fetchall()
    income_rows = [r for r in income_all
                   if (not repay_filter or r["repay_status"] == repay_filter)
                   and kind_filter != "expense"]
    refund_rows = [r for r in refund_all
                   if (not repay_filter or r["repay_status"] == repay_filter)
                   and kind_filter != "income"]

    exp_where = " WHERE 1=1"
    exp_params: list = []
    if store_id is not None:
        exp_where += " AND store_id = ?"
        exp_params.append(store_id)
    if start_ts is not None and end_ts is not None:
        exp_where += " AND expense_date >= ? AND expense_date < ?"
        exp_params.extend([start_ts, end_ts])
    exp_all = [] if keyword else conn.execute(
        "SELECT id, kind, reason, remark, guest_name, room_number, amount, expense_date, created_at FROM expenses"
        + exp_where + " ORDER BY expense_date", exp_params
    ).fetchall()
    exp_rows = exp_all
    if kind_filter == "income":
        exp_rows = [r for r in exp_rows if r["kind"] == "income"]
    elif kind_filter == "expense":
        exp_rows = [r for r in exp_rows if r["kind"] != "income"]

    manual_income = sum((r["amount"] or 0) for r in exp_all if r["kind"] == "income")
    manual_expense = sum((r["amount"] or 0) for r in exp_all if r["kind"] != "income")
    total_income = sum((r["amount"] or 0) for r in income_all) + manual_income
    repaid_income = sum((r["amount"] or 0) for r in income_all if r["repay_status"] == "已回款") + manual_income
    total_expense = sum(-(r["amount"] or 0) for r in refund_all) + manual_expense

    def period_key(ts: int) -> str:
        # 全部/年：按月份汇总；月/日/自定义按日期汇总
        return datetime.fromtimestamp(ts).strftime("%Y-%m") if gran in ("year", "all") else date_str(ts)

    def remark_with_room(remark: str, room_no: str) -> str:
        """订单关联条目的自动备注：收款备注 + 房号，如「先付·102」。"""
        parts = [p for p in (remark or "", room_no or "") if p]
        return "·".join(parts)

    if gran in ("day", "all"):
        items: list[dict] = []
        for row in income_rows:
            items.append({
                "period": row["order_no"] or f"订单{row['pay_date']}",
                "income": round(row["amount"], 2), "expense": 0.0,
                "net": round(row["amount"], 2), "count": 1, "kind": "income",
                "order_id": row["order_id"],
                "room_number": row["room_number"], "guest_name": row["guest_name"],
                "guest_source": row["guest_source"], "checkout_time": row["created_at"],
                "remark": remark_with_room(row["pay_remark"], row["room_number"]),
            })
        for row in refund_rows:
            items.append({
                "period": f"退费·{row['order_no']}",
                "income": 0.0, "expense": round(-(row["amount"]), 2),
                "net": round(row["amount"], 2), "count": 1, "kind": "expense",
                "reason": f"退费 {row['order_no']}",
                "order_id": row["order_id"],
                "room_number": row["room_number"], "guest_name": row["guest_name"],
                "guest_source": row["guest_source"], "checkout_time": row["created_at"],
                "remark": remark_with_room(row["pay_remark"], row["room_number"]),
            })
        for row in exp_rows:
            amount = round(row["amount"], 2)
            if row["kind"] == "income":
                items.append({
                    "period": row["reason"] or "收入",
                    "income": amount, "expense": 0.0, "net": amount,
                    "count": 1, "kind": "income", "expense_id": row["id"],
                    "reason": row["reason"], "guest_name": row["guest_name"],
                    "room_number": row["room_number"], "checkout_time": row["created_at"],
                    "remark": row["remark"] or "",
                })
            else:
                items.append({
                    "period": row["reason"] or "支出",
                    "income": 0.0, "expense": amount, "net": -amount,
                    "count": 1, "kind": "expense", "expense_id": row["id"],
                    "reason": row["reason"], "guest_name": row["guest_name"],
                    "room_number": row["room_number"], "checkout_time": row["created_at"],
                    "remark": row["remark"] or "",
                })
        items.sort(key=lambda x: x["checkout_time"] or 0)
    else:
        item_map: dict[str, dict] = {}
        for row in income_rows:
            key = period_key(row["acc_date"])
            bucket = item_map.setdefault(key, {"income": 0.0, "expense": 0.0, "count": 0})
            bucket["income"] += row["amount"] or 0
            bucket["count"] += 1
        for row in refund_rows:
            key = period_key(row["acc_date"])
            bucket = item_map.setdefault(key, {"income": 0.0, "expense": 0.0, "count": 0})
            bucket["expense"] += -(row["amount"] or 0)
        for row in exp_rows:
            key = period_key(row["expense_date"])
            bucket = item_map.setdefault(key, {"income": 0.0, "expense": 0.0, "count": 0})
            if row["kind"] == "income":
                bucket["income"] += row["amount"] or 0
            else:
                bucket["expense"] += row["amount"] or 0
        items = [
            {
                "period": k,
                "income": round(v["income"], 2),
                "expense": round(v["expense"], 2),
                "net": round(v["income"] - v["expense"], 2),
                "count": v["count"],
            }
            for k, v in sorted(item_map.items())
        ]
    return {
        "total_income": round(total_income, 2),
        "total_expense": round(total_expense, 2),
        "net": round(repaid_income - total_expense, 2),
        "repaid_amount": round(repaid_income, 2),
        "pending_amount": round(total_income - repaid_income, 2),
        "income_count": len(income_all) + sum(1 for r in exp_all if r["kind"] == "income"),
        "gran": gran,
        "items": items,
    }


def create_expense(conn: sqlite3.Connection, data: schemas.ExpenseCreate) -> dict:
    """新增手动收支（收入/支出，时间默认当日，含理由/金额/备注/客人/房号）。"""
    if data.kind not in ("income", "expense"):
        raise AppError("收支类型只能是 income 或 expense")
    store = conn.execute("SELECT id FROM stores WHERE id = ?", (data.store_id,)).fetchone()
    if not store:
        raise AppError("门店不存在")
    now = now_ts()
    cur = conn.execute(
        "INSERT INTO expenses (kind, reason, remark, guest_name, room_number, amount,"
        " expense_date, store_id, created_at, updated_at)"
        " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (data.kind, data.reason.strip(), data.remark.strip(),
         data.guest_name.strip(), data.room_number.strip(), round(data.amount, 2),
         day_start(data.expense_date), data.store_id, now, now),
    )
    conn.commit()
    return _to_dict(
        conn.execute("SELECT * FROM expenses WHERE id = ?", (cur.lastrowid,)).fetchone()
    )


def delete_expense(conn: sqlite3.Connection, expense_id: int,
                   confirm: bool = False) -> None:
    """删除支出条目（二次确认）。"""
    if not confirm:
        raise AppError("请先确认删除操作（confirm=true）")
    row = conn.execute("SELECT * FROM expenses WHERE id = ?", (expense_id,)).fetchone()
    if not row:
        raise AppError("支出记录不存在", 404)
    conn.execute("DELETE FROM expenses WHERE id = ?", (expense_id,))
    conn.commit()


def update_expense(conn: sqlite3.Connection, expense_id: int,
                   data: schemas.ExpenseUpdate) -> dict:
    """编辑手动收支条目。"""
    row = conn.execute("SELECT * FROM expenses WHERE id = ?", (expense_id,)).fetchone()
    if not row:
        raise AppError("收支记录不存在", 404)
    fields = data.model_dump(exclude_unset=True, mode="json")
    if "kind" in fields and fields["kind"] not in ("income", "expense"):
        raise AppError("收支类型只能是 income 或 expense")
    if "amount" in fields:
        fields["amount"] = round(fields["amount"], 2)
    if "expense_date" in fields:
        fields["expense_date"] = day_start(fields["expense_date"])
    for k in ("reason", "remark", "guest_name", "room_number"):
        if k in fields:
            fields[k] = str(fields[k] or "").strip()
    fields["updated_at"] = now_ts()
    sets = ", ".join(f"{k} = ?" for k in fields)
    conn.execute(
        f"UPDATE expenses SET {sets} WHERE id = ?", (*fields.values(), expense_id)
    )
    conn.commit()
    return _to_dict(
        conn.execute("SELECT * FROM expenses WHERE id = ?", (expense_id,)).fetchone()
    )



# ---------------- 房间模板 ----------------

def list_room_templates(conn: sqlite3.Connection) -> list[dict]:
    return [_to_dict(r) for r in conn.execute(
        "SELECT * FROM room_templates ORDER BY id DESC").fetchall()]


def create_room_template(conn: sqlite3.Connection, data: schemas.RoomTemplateCreate) -> dict:
    name = data.name.strip()
    dup = conn.execute(
        "SELECT 1 FROM room_templates WHERE name = ? COLLATE NOCASE", (name,)
    ).fetchone()
    if dup:
        raise AppError("模板名称已存在")
    hourly = min(data.hourly_price or 0, data.base_price or 0)
    cur = conn.execute(
        "INSERT INTO room_templates (name, room_category, base_price, hourly_price, created_at)"
        " VALUES (?, ?, ?, ?, ?)",
        (name, data.room_category, data.base_price, hourly, now_ts()),
    )
    conn.commit()
    return _to_dict(conn.execute(
        "SELECT * FROM room_templates WHERE id = ?", (cur.lastrowid,)
    ).fetchone())


def delete_room_template(conn: sqlite3.Connection, template_id: int, confirm: bool = False) -> None:
    if not confirm:
        raise AppError("请先确认删除操作（confirm=true）")
    conn.execute("DELETE FROM room_templates WHERE id = ?", (template_id,))
    conn.commit()


# ---------------- 自定义房型 ----------------

def list_room_categories(conn: sqlite3.Connection) -> list[dict]:
    return [_to_dict(r) for r in conn.execute(
        "SELECT * FROM room_categories ORDER BY sort_order, id").fetchall()]


def create_room_category(conn: sqlite3.Connection, data: schemas.RoomCategoryCreate) -> dict:
    name = data.name.strip()
    if not name:
        raise AppError("房型名称不能为空")
    dup = conn.execute(
        "SELECT 1 FROM room_categories WHERE name = ? COLLATE NOCASE", (name,)
    ).fetchone()
    if dup:
        raise AppError("房型已存在")
    max_order = conn.execute(
        "SELECT COALESCE(MAX(sort_order), 0) AS m FROM room_categories"
    ).fetchone()["m"]
    cur = conn.execute(
        "INSERT INTO room_categories (name, sort_order) VALUES (?, ?)", (name, max_order + 1)
    )
    conn.commit()
    return _to_dict(conn.execute(
        "SELECT * FROM room_categories WHERE id = ?", (cur.lastrowid,)
    ).fetchone())


def delete_room_category(conn: sqlite3.Connection, category_id: int, confirm: bool = False) -> None:
    if not confirm:
        raise AppError("请先确认删除操作（confirm=true）")
    row = conn.execute("SELECT name FROM room_categories WHERE id = ?", (category_id,)).fetchone()
    if not row:
        raise AppError("房型不存在", 404)
    used = conn.execute(
        "SELECT COUNT(*) AS c FROM rooms WHERE room_category = ?", (row["name"],)
    ).fetchone()["c"]
    if used:
        raise AppError(f"仍有 {used} 个房间使用该房型，无法删除")
    conn.execute("DELETE FROM room_categories WHERE id = ?", (category_id,))
    conn.commit()


# ---------------- 批量新建房间 ----------------

def batch_create_rooms(conn: sqlite3.Connection, data: schemas.RoomBatchCreate) -> dict:
    created: list[str] = []
    skipped: list[str] = []
    hourly = min(data.hourly_price or 0, data.base_price or 0)
    created_at = now_ts()
    for floor in range(data.floor_start, data.floor_end + 1):
        for seq in range(1, data.rooms_per_floor + 1):
            number = f"{floor}{seq:02d}"
            dup = conn.execute(
                "SELECT 1 FROM rooms WHERE store_id = ? AND room_number = ? COLLATE NOCASE",
                (data.store_id, number),
            ).fetchone()
            if dup:
                skipped.append(number)
                continue
            conn.execute(
                "INSERT INTO rooms (room_number, room_name, room_category, base_price, hourly_price,"
                " status, is_active, store_id, created_at) VALUES (?, ?, ?, ?, ?, '空闲', 1, ?, ?)",
                (number, number, data.room_category, data.base_price, hourly, data.store_id, created_at),
            )
            created.append(number)
    conn.commit()
    return {"created": created, "skipped": skipped}


# ---------------- 批量编辑房间 ----------------

def batch_edit_rooms(conn: sqlite3.Connection, data: schemas.RoomBatchEdit) -> dict:
    where = "WHERE is_active = 1"
    params: list = []
    if data.store_id is not None:
        where += " AND store_id = ?"
        params.append(data.store_id)
    if data.room_category:
        where += " AND room_category = ?"
        params.append(data.room_category)
    if data.floor is not None:
        where += " AND CAST(room_number AS INTEGER) BETWEEN ? AND ?"
        params.extend([data.floor * 100, data.floor * 100 + 99])
    rows = conn.execute(
        f"SELECT id, base_price, hourly_price FROM rooms {where}", params
    ).fetchall()
    for r in rows:
        base = r["base_price"]
        hour = r["hourly_price"]
        if data.set_base_price is not None:
            base = data.set_base_price
        else:
            base = max(0.0, base + data.delta_base_price)
        if data.set_hourly_price is not None:
            hour = data.set_hourly_price
        else:
            hour = max(0.0, hour + data.delta_hourly_price)
        hour = min(hour, base)
        conn.execute(
            "UPDATE rooms SET base_price = ?, hourly_price = ? WHERE id = ?",
            (round(base, 2), round(hour, 2), r["id"]),
        )
    conn.commit()
    return {"updated": len(rows)}


# ---------------- 自动维护 ----------------

def _setting_on(conn: sqlite3.Connection, key: str) -> bool:
    row = conn.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
    return bool(row and row["value"] == "1")


def _log_automation(conn: sqlite3.Connection, order_id: int, action: str,
                    note: str, before_data: str = "") -> int:
    mark = "【" + note + "】"
    conn.execute(
        "UPDATE orders SET remark = CASE WHEN remark = '' THEN ? ELSE remark || '；' || ? END WHERE id = ?",
        (mark, mark, order_id),
    )
    cur = conn.execute(
        "INSERT INTO automation_logs (order_id, action, note, before_data, created_at, rolled_back)"
        " VALUES (?, ?, ?, ?, ?, 0)",
        (order_id, action, note, before_data, now_ts()),
    )
    return cur.lastrowid


def _auto_conflict(conn: sqlite3.Connection, room_id: int, start: int,
                   end: int, exclude_order_id: int) -> bool:
    return bool(check_room_conflict(conn, room_id, start, end, exclude_order_id))


def _update_auto_extend_remark(conn: sqlite3.Connection, order_id: int) -> None:
    """自动续住备注：累计次数（【自动续住】×N）而非重复追加多条。"""
    import re
    row = conn.execute("SELECT remark FROM orders WHERE id = ?", (order_id,)).fetchone()
    remark = row["remark"] if row else ""
    remark = re.sub(r'；?【自动续住】(×\d+)?', "", remark or "").strip("；")
    cnt = conn.execute(
        "SELECT COUNT(*) AS c FROM automation_logs WHERE order_id = ? AND action = 'auto_extend' AND rolled_back = 0",
        (order_id,),
    ).fetchone()["c"]
    tag = "【自动续住】" if cnt <= 1 else "【自动续住】×" + str(cnt)
    new_remark = (remark + "；" + tag) if remark else tag
    conn.execute("UPDATE orders SET remark = ? WHERE id = ?", (new_remark, order_id))

def auto_settle_repay(conn: sqlite3.Connection) -> int:
    """自动回款：预计到账日期已到的待回款订单自动转为已回款。"""
    now = now_ts()
    rows = conn.execute(
        "SELECT id, expected_repay_date FROM orders"
        " WHERE repay_status = '待回款' AND expected_repay_date IS NOT NULL AND expected_repay_date <= ?",
        (now,),
    ).fetchall()
    for r in rows:
        conn.execute(
            "UPDATE orders SET repay_status = '已回款', actual_repay_date = expected_repay_date, updated_at = ? WHERE id = ?",
            (now, r["id"]),
        )
    conn.commit()
    return len(rows)


def run_auto_maintenance(conn: sqlite3.Connection) -> list[dict]:
    """执行一次自动维护，返回动作摘要：
    - 全局：自动入住 / 自动退房（冲突检查）/ 自动续住（冲突检查）
    - 单订单：详情页开启后到点自动退房或自动缴费
    """
    now = now_ts()
    actions: list[dict] = []
    master_on = _setting_on(conn, "auto_master")
    auto_checkin = master_on and _setting_on(conn, "auto_checkin")
    auto_checkout = master_on and _setting_on(conn, "auto_checkout")
    auto_extend = master_on and _setting_on(conn, "auto_extend")

    # 自动入住
    if auto_checkin:
        rows = conn.execute(
            "SELECT id FROM orders WHERE status = '已预订' AND start_timestamp <= ? AND order_type != 'long_term'", (now,)
        ).fetchall()
        for row in rows:
            oid = row["id"]
            try:
                order = get_order(conn, oid)
                room = get_room(conn, order["room_id"])
                if not room or room["status"] == "维修":
                    continue
                before = json.dumps({"status": "已预订"}, ensure_ascii=False)
                conn.execute("BEGIN EXCLUSIVE")
                conn.execute("UPDATE orders SET status = '已入住', updated_at = ? WHERE id = ?", (now, oid))
                if order.get("settle_mode", "once") == "once":
                    has_income = conn.execute(
                        "SELECT 1 FROM order_payments WHERE order_id = ? AND amount > 0 LIMIT 1", (oid,)
                    ).fetchone()
                    if not has_income:
                        conn.execute(
                            "INSERT INTO order_payments (order_id, amount, pay_date, remark, created_at)"
                            " VALUES (?, ?, ?, '自动入住·先付', ?)",
                            (oid, round(order["total_price"] or 0, 2), day_start(now), now),
                        )
                _sync_room_status(conn, order["room_id"])
                _log_automation(conn, oid, "auto_checkin", "自动入住", before)
                conn.commit()
                actions.append({"action": "auto_checkin", "order_id": oid, "note": "自动入住"})
            except Exception:
                try:
                    conn.rollback()
                except Exception:
                    pass

    # 自动退房（到期且有冲突时跳过）
    if auto_checkout:
        rows = conn.execute(
            "SELECT id, room_id, start_timestamp, end_timestamp FROM orders"
            " WHERE status = '已入住' AND end_timestamp <= ? AND order_type != 'long_term' AND automation_enabled = 0", (now,)
        ).fetchall()
        for row in rows:
            oid = row["id"]
            try:
                if _auto_conflict(conn, row["room_id"], row["start_timestamp"], row["end_timestamp"], oid):
                    continue
                order = get_order(conn, oid)
                before = json.dumps({
                    "status": "已入住",
                    "end_timestamp": order["end_timestamp"],
                    "total_price": order["total_price"],
                }, ensure_ascii=False)
                checkout_order(conn, oid, end_timestamp=row["end_timestamp"], confirm=True)
                conn.execute(
                    "INSERT INTO automation_logs (order_id, action, note, before_data, created_at, rolled_back)"
                    " VALUES (?, 'auto_checkout', '自动退房', ?, ?, 0)",
                    (oid, before, now),
                )
                conn.execute(
                    "UPDATE order_payments SET remark = '自动退房·结算' WHERE order_id = ? AND remark LIKE '退房%' AND created_at >= ?",
                    (oid, now),
                )
                conn.execute(
                    "UPDATE orders SET remark = CASE WHEN remark = '' THEN '【自动退房】' ELSE remark || '；【自动退房】' END WHERE id = ?",
                    (oid,),
                )
                conn.commit()
                actions.append({"action": "auto_checkout", "order_id": oid, "note": "自动退房"})
            except Exception:
                try:
                    conn.rollback()
                except Exception:
                    pass

    # 自动续住（长租到期自动续 1 天，冲突检查）
    if auto_extend:
        rows = conn.execute(
            "SELECT id, room_id, start_timestamp, end_timestamp FROM orders"
            " WHERE status = '已入住' AND order_type = 'full_day' AND automation_enabled = 0 AND end_timestamp <= ?", (now,)
        ).fetchall()
        for row in rows:
            oid = row["id"]
            try:
                new_end = row["end_timestamp"] + 86400
                if _auto_conflict(conn, row["room_id"], row["end_timestamp"], new_end, oid):
                    continue
                order = get_order(conn, oid)
                before = json.dumps({"end_timestamp": order["end_timestamp"]}, ensure_ascii=False)
                extend_order(conn, oid, count=1, amount=None, confirm=True)
                conn.execute(
                    "INSERT INTO automation_logs (order_id, action, note, before_data, created_at, rolled_back)"
                    " VALUES (?, 'auto_extend', '自动续住', ?, ?, 0)",
                    (oid, before, now),
                )
                _update_auto_extend_remark(conn, oid)
                conn.commit()
                actions.append({"action": "auto_extend", "order_id": oid, "note": "自动续住"})
            except Exception:
                try:
                    conn.rollback()
                except Exception:
                    pass

    # 单订单自动入住（到点自动办理入住）
    checkin_rows = conn.execute(
        "SELECT id, room_id, order_type, settle_mode, start_timestamp, status, auto_action"
        " FROM orders WHERE auto_checkin_enabled = 1 AND status = '已预订'"
        " AND start_timestamp <= ? AND order_type != 'long_term'", (now,),
    ).fetchall()
    for row in checkin_rows:
        oid = row["id"]
        try:
            order = get_order(conn, oid)
            room = get_room(conn, order["room_id"])
            if not room or room["status"] == "维修":
                continue
            before = json.dumps({"status": "已预订"}, ensure_ascii=False)
            conn.execute("BEGIN EXCLUSIVE")
            conn.execute("UPDATE orders SET status = '已入住', updated_at = ? WHERE id = ?", (now, oid))
            if order.get("settle_mode", "once") == "once":
                has_income = conn.execute(
                    "SELECT 1 FROM order_payments WHERE order_id = ? AND amount > 0 LIMIT 1", (oid,),
                ).fetchone()
                if not has_income:
                    conn.execute(
                        "INSERT INTO order_payments (order_id, amount, pay_date, remark, created_at)"
                        " VALUES (?, ?, ?, '自动入住·先付', ?)",
                        (oid, round(order["total_price"] or 0, 2), day_start(now), now),
                    )
            _sync_room_status(conn, order["room_id"])
            _log_automation(conn, oid, "auto_checkin", "自动入住（单订单）", before)
            conn.execute(
                "UPDATE orders SET remark = CASE WHEN remark = '' THEN '【自动入住】' ELSE remark || '；【自动入住】' END WHERE id = ?",
                (oid,),
            )
            conn.commit()
            actions.append({"action": "auto_checkin", "order_id": oid, "note": "自动入住（单订单）"})
        except Exception:
            try:
                conn.rollback()
            except Exception:
                pass

    # 单订单自动操作（自动退房 / 自动续住）
    rows = conn.execute(
        "SELECT id, room_id, order_type, settle_mode, end_timestamp, status, daily_price, auto_action"
        " FROM orders WHERE auto_depart_enabled = 1 AND status = '已入住' AND end_timestamp <= ? AND order_type != 'long_term'", (now,)
    ).fetchall()
    for row in rows:
        oid = row["id"]
        try:
            if row["auto_action"] == "extend":
                # 自动续住：到期自动续 1 天（含冲突检查）
                new_end = row["end_timestamp"] + 86400
                if _auto_conflict(conn, row["room_id"], row["end_timestamp"], new_end, oid):
                    continue
                order = get_order(conn, oid)
                before = json.dumps({"end_timestamp": order["end_timestamp"]}, ensure_ascii=False)
                extend_order(conn, oid, count=1, amount=None, confirm=True)
                conn.execute(
                    "INSERT INTO automation_logs (order_id, action, note, before_data, created_at, rolled_back)"
                    " VALUES (?, 'auto_extend', '自动续住（单订单）', ?, ?, 0)",
                    (oid, before, now),
                )
                _update_auto_extend_remark(conn, oid)
                conn.commit()
                actions.append({"action": "auto_extend", "order_id": oid, "note": "自动续住（单订单）"})
            else:
                order = get_order(conn, oid)
                before = json.dumps({
                    "status": "已入住",
                    "end_timestamp": order["end_timestamp"],
                    "total_price": order["total_price"],
                }, ensure_ascii=False)
                checkout_order(conn, oid, end_timestamp=row["end_timestamp"], confirm=True)
                conn.execute(
                    "INSERT INTO automation_logs (order_id, action, note, before_data, created_at, rolled_back)"
                    " VALUES (?, 'auto_checkout', '自动退房（单订单）', ?, ?, 0)",
                    (oid, before, now),
                )
                conn.execute(
                    "UPDATE order_payments SET remark = '自动退房·结算' WHERE order_id = ? AND remark LIKE '退房%' AND created_at >= ?",
                    (oid, now),
                )
                conn.execute(
                    "UPDATE orders SET remark = CASE WHEN remark = '' THEN '【自动退房】' ELSE remark || '；【自动退房】' END WHERE id = ?",
                    (oid,),
                )
                conn.commit()
                actions.append({"action": "auto_checkout", "order_id": oid, "note": "自动退房（单订单）"})
        except Exception:
            try:
                conn.rollback()
            except Exception:
                pass
    return actions


def list_automation_logs(conn: sqlite3.Connection, rolled_back: int | None = None,
                         order_id: int | None = None, limit: int = 200) -> list[dict]:
    sql = ("SELECT l.*, o.order_no, o.guest_name, o.start_timestamp, r.room_number FROM automation_logs l"
           " LEFT JOIN orders o ON o.id = l.order_id"
           " LEFT JOIN rooms r ON r.id = o.room_id WHERE 1=1")
    params: list = []
    if order_id:
        sql += " AND l.order_id = ?"
        params.append(order_id)
    if rolled_back is not None:
        sql += " AND l.rolled_back = ?"
        params.append(rolled_back)
    sql += " ORDER BY l.id DESC LIMIT ?"
    params.append(limit)
    return [_to_dict(r) for r in conn.execute(sql, params).fetchall()]


def _rollback_one(conn: sqlite3.Connection, log: dict) -> None:
    oid = log["order_id"]
    action = log["action"]
    try:
        data = json.loads(log["before_data"] or "{}")
    except Exception:
        data = {}
    if action == "auto_checkin":
        order = get_order(conn, oid)
        if order and order["status"] == "已入住":
            conn.execute(
                "UPDATE orders SET status = '已预订', updated_at = ? WHERE id = ?", (now_ts(), oid)
            )
            conn.execute(
                "DELETE FROM order_payments WHERE order_id = ? AND"
                " remark IN ('入住前实收', '先付') AND created_at >= ?",
                (oid, log["created_at"]),
            )
            _sync_room_status(conn, order["room_id"])
    elif action == "auto_checkout":
        order = get_order(conn, oid)
        if order and order["status"] == "已退房":
            end = data.get("end_timestamp") if data.get("end_timestamp") is not None else order["end_timestamp"]
            total = data.get("total_price") if data.get("total_price") is not None else order["total_price"]
            conn.execute(
                "UPDATE orders SET status = '已入住', end_timestamp = ?, total_price = ?,"
                " adjust_amount = 0, updated_at = ? WHERE id = ?",
                (end, total, now_ts(), oid),
            )
            conn.execute(
                "DELETE FROM order_payments WHERE order_id = ? AND"
                " (remark LIKE '退房%' OR remark LIKE '多收%' OR remark LIKE '少收%') AND created_at >= ?",
                (oid, log["created_at"]),
            )
            _sync_room_status(conn, order["room_id"])
    elif action == "auto_extend":
        end = data.get("end_timestamp")
        if end:
            conn.execute("UPDATE orders SET end_timestamp = ? WHERE id = ?", (end, oid))
    elif action == "auto_pay":
        pid = data.get("payment_id")
        if pid:
            conn.execute("DELETE FROM order_payments WHERE id = ?", (pid,))


def rollback_automation(conn: sqlite3.Connection, log_id: int | None = None,
                        order_id: int | None = None, confirm: bool = False) -> dict:
    """回滚自动维护操作：log_id 单笔、order_id 单订单、两者皆空则全局。"""
    if not confirm:
        raise AppError("请先确认回滚操作（confirm=true）")
    if log_id:
        logs = conn.execute(
            "SELECT * FROM automation_logs WHERE id = ? AND rolled_back = 0", (log_id,)
        ).fetchall()
    elif order_id:
        logs = conn.execute(
            "SELECT * FROM automation_logs WHERE order_id = ? AND rolled_back = 0 ORDER BY id DESC",
            (order_id,),
        ).fetchall()
    else:
        logs = conn.execute(
            "SELECT * FROM automation_logs WHERE rolled_back = 0 ORDER BY id DESC"
        ).fetchall()
    rolled = 0
    for log in logs:
        try:
            _rollback_one(conn, log)
            conn.execute("DELETE FROM automation_logs WHERE id = ?", (log["id"],))
            conn.commit()
            rolled += 1
        except Exception:
            try:
                conn.rollback()
            except Exception:
                pass
    # 回滚后自动关闭自动化功能
    if order_id:
        conn.execute("UPDATE orders SET automation_enabled = 0 WHERE id = ?", (order_id,))
    else:
        for key in ("auto_checkin", "auto_checkout", "auto_extend"):
            conn.execute("UPDATE settings SET value = '0' WHERE key = ?", (key,))
    conn.commit()
    return {"rolled": rolled}


def set_order_automation(conn: sqlite3.Connection, order_id: int,
                         checkin_enabled: bool = False,
                         depart_enabled: bool = False,
                         depart_action: str = "checkout") -> dict:
    """开启/关闭单订单自动维护：自动入住与自动离店（退房/续住）独立开关。"""
    order = get_order(conn, order_id)
    if not order:
        raise AppError("订单不存在", 404)
    if order["order_type"] == "long_term":
        raise AppError("长租订单不支持自动维护")
    enabled = 1 if (checkin_enabled or depart_enabled) else 0
    conn.execute(
        "UPDATE orders SET automation_enabled = ?, auto_action = ?, auto_checkin_enabled = ?,"
        " auto_depart_enabled = ?, updated_at = ? WHERE id = ?",
        (enabled, depart_action if depart_action in ("checkout", "extend") else "checkout",
         1 if checkin_enabled else 0, 1 if depart_enabled else 0, now_ts(), order_id),
    )
    conn.commit()
    return _order_joined(conn, order_id)


def get_alerts(conn: sqlite3.Connection, store_id: int | None = None) -> list[dict]:
    store_where = " AND r.store_id = ?" if store_id is not None else ""
    store_params = [store_id] if store_id is not None else []
    """超时未处理提醒：应入住未处理、应退房未处理、长租日结先前日期未收款。"""
    now = now_ts()
    today = day_start(now)
    alerts: list[dict] = []

    # 应入住未处理
    rows = conn.execute(
        "SELECT o.id, o.start_timestamp, r.room_number, r.room_category FROM orders o"
        " JOIN rooms r ON r.id = o.room_id"
        " WHERE o.status = '已预订' AND o.start_timestamp < ?" + store_where,
        (now, *store_params),
    ).fetchall()
    for r in rows:
        alerts.append({
            "type": "checkin", "order_id": r["id"], "room_number": r["room_number"],
            "message": f"房间 {r['room_number']} 应入住未处理（{date_str(r['start_timestamp'])}）",
        })

    # 应退房未处理
    rows = conn.execute(
        "SELECT o.id, o.end_timestamp, r.room_number FROM orders o"
        " JOIN rooms r ON r.id = o.room_id"
        " WHERE o.status = '已入住' AND o.end_timestamp < ?" + store_where,
        (now, *store_params),
    ).fetchall()
    for r in rows:
        alerts.append({
            "type": "checkout", "order_id": r["id"], "room_number": r["room_number"],
            "message": f"房间 {r['room_number']} 应退房未处理（{date_str(r['end_timestamp'])}）",
        })

    # 长租日结：先前日期未收款
    rows = conn.execute(
        "SELECT o.id, o.start_timestamp, o.end_timestamp, o.daily_price, r.room_number FROM orders o"
        " JOIN rooms r ON r.id = o.room_id"
        " WHERE o.settle_mode = 'daily' AND o.status IN ('已预订', '已入住')" + store_where + " AND o.order_type = 'long_term'",
        tuple(store_params),
    ).fetchall()
    for r in rows:
        # 跳过起始时间异常（2000 年以前）的脏数据，避免日期异常
        if r["start_timestamp"] < 946684800:
            continue
        paid = {x["pay_date"] for x in conn.execute(
            "SELECT pay_date FROM order_payments WHERE order_id = ? AND amount > 0",
            (r["id"],),
        ).fetchall()}
        missing: list[str] = []
        cur = day_start(r["start_timestamp"])
        end_limit = day_start(r["end_timestamp"])
        while cur < today and cur < end_limit and len(missing) < 366:
            if cur not in paid:
                missing.append(date_str(cur))
            cur += 86400
        if missing:
            msg = f"房间 {r['room_number']} 长租未收款：{missing[0]}"
            if len(missing) > 1:
                msg += f" 等 {len(missing)} 天"
            alerts.append({
                "type": "pay", "order_id": r["id"], "room_number": r["room_number"], "message": msg,
            })
    return alerts
