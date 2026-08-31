# -*- coding: utf-8 -*-
"""迁移脚本：将旧版「全日房 / 钟点房」数据结构迁移为「普通房间 + 计费方式」。

用法：
    python migrate_room_type.py [数据库路径]
    默认读取 data/hotel.db；也可通过环境变量 HOTEL_DB_PATH 指定。

迁移内容：
    1. rooms.room_type -> rooms.room_category（钟点 -> 标准间，全日 -> 大床房），保留 base_price；
    2. rooms 新增 is_active（默认 1，用于软删除）；
    3. orders.order_type 中文枚举 -> full_day / hourly（去掉枚举限制）；
    4. 历史订单的 room_id 不变，关联不受影响。
"""

import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / "backend"))

import database  # noqa: E402


def main() -> None:
    if len(sys.argv) > 1:
        db_path = Path(sys.argv[1])
    else:
        db_path = Path(os.environ.get("HOTEL_DB_PATH", str(database.get_db_path())))

    if not db_path.exists():
        print(f"未找到数据库文件：{db_path}（首次启动会自动创建新结构，无需迁移）")
        return

    conn = database.get_connection(db_path)
    try:
        old_rooms = conn.execute(
            "SELECT room_number, room_type FROM rooms WHERE room_type IS NOT NULL"
        ).fetchall()
        old_orders = conn.execute(
            "SELECT COUNT(*) AS c FROM orders WHERE order_type IN ('全日租', '钟点房')"
        ).fetchone()["c"]
    finally:
        conn.close()

    print(f"迁移前：{len(old_rooms)} 个房间含旧房型字段；{old_orders} 条订单为中文订单类型")

    database.init_db(db_path)

    conn = database.get_connection(db_path)
    try:
        rooms = conn.execute(
            "SELECT room_category, COUNT(*) AS c FROM rooms GROUP BY room_category"
        ).fetchall()
        orders = conn.execute(
            "SELECT order_type, COUNT(*) AS c FROM orders GROUP BY order_type"
        ).fetchall()
        columns = [r["name"] for r in conn.execute("PRAGMA table_info(rooms)").fetchall()]
    finally:
        conn.close()

    print("迁移完成：")
    print("  rooms 列：", ", ".join(columns))
    print("  房间品类分布：", {r["room_category"]: r["c"] for r in rooms})
    print("  订单类型分布：", {r["order_type"]: r["c"] for r in orders})


if __name__ == "__main__":
    main()
