# -*- coding: utf-8 -*-
"""SQLite 数据库连接与初始化。"""

import os
import sqlite3
import sys
import time
from datetime import datetime
from pathlib import Path

from models import (
    CHANNELS_TABLE_DDL,
    EXPENSES_TABLE_DDL,
    INDEXES_DDL,
    ORDER_PAYMENTS_TABLE_DDL,
    ORDERS_TABLE_DDL,
    ORDER_SEQ_TABLE_DDL,
    ROOMS_TABLE_DDL,
    SETTINGS_TABLE_DDL,
    STORES_TABLE_DDL,
)

# 首次启动写入的默认设置：(key, value, description)
DEFAULT_SETTINGS = [
    ("hotel_name", "客房管理系统", "系统名称（显示在页面左上角）"),
    ("hotel_phone", "", "前台联系电话"),
    ("checkout_time", "12:00", "全日租默认退房时间（HH:MM）"),
    ("min_rent_hours", "1", "钟点房最短计费时长（小时）"),
    ("hourly_increment", "1", "钟点房计费递增单位（小时）"),
]

# 首次启动自动创建的示例房间：(room_number, room_name, room_category, base_price)
# 所有房间都是普通房间，base_price 为基础价（全日租按晚、钟点房按小时计费）
SAMPLE_ROOMS = [
    ("101", "101 舒适大床房", "大床房", 168.0),
]


def get_data_dir() -> Path:
    """返回数据目录：开发模式为项目根目录/data，打包后为 exe 同级目录/data。"""
    if getattr(sys, "frozen", False):
        base = Path(sys.executable).resolve().parent
    else:
        base = Path(__file__).resolve().parent.parent
    return base / "data"


def get_db_path() -> Path:
    """数据库文件路径，可通过环境变量 HOTEL_DB_PATH 覆盖。"""
    override = os.environ.get("HOTEL_DB_PATH")
    if override:
        return Path(override)
    return get_data_dir() / "hotel.db"


def get_connection(db_path=None) -> sqlite3.Connection:
    """创建 SQLite 连接：开启外键、WAL 模式、字典式行访问。"""
    path = Path(db_path) if db_path else get_db_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(path), timeout=10)
    conn.row_factory = sqlite3.Row
    # 关闭 Python 隐式事务，所有写操作由代码显式使用 BEGIN EXCLUSIVE / COMMIT / ROLLBACK 控制
    conn.isolation_level = None
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA busy_timeout = 5000")
    return conn


def init_db(db_path=None) -> Path:
    """创建数据表、索引，并写入默认设置与示例房间。"""
    path = Path(db_path) if db_path else get_db_path()
    conn = get_connection(path)
    try:
        conn.executescript(STORES_TABLE_DDL)
        conn.executescript(ROOMS_TABLE_DDL)
        conn.executescript(ORDERS_TABLE_DDL)
        conn.executescript(SETTINGS_TABLE_DDL)
        conn.executescript(ORDER_SEQ_TABLE_DDL)
        conn.executescript(EXPENSES_TABLE_DDL)
        _migrate_expenses(conn)        # 手工收支表补充字段
        _ensure_channels(conn)         # 渠道表首次创建时写入默认渠道
        _migrate_orders(conn)          # 补充 order_no/remark 列并回填
        _migrate_schema(conn)          # 旧房型/订单类型结构迁移（可能重建表）
        _migrate_rooms_number_per_store(conn)  # 房号唯一性改为门店内唯一
        _migrate_payments(conn)        # 订单结算字段与收款记录表（历史收入回填）
        _migrate_order_daily_price(conn)  # 订单新增日单价列（日结收款以订单日单价为准）
        _migrate_payment_account_date(conn)  # 收款记录新增入账日期列
        _migrate_order_adjust_amount(conn)  # 订单新增多收/少收差额列
        _ensure_indexes(conn)          # 重建索引（迁移重建表后会丢失）
        _seed_settings(conn)
        _seed_initial_data(conn)
        conn.commit()
    finally:
        conn.close()
    return path


def _seed_settings(conn: sqlite3.Connection) -> None:
    for key, value, desc in DEFAULT_SETTINGS:
        conn.execute(
            "INSERT OR IGNORE INTO settings (key, value, description) VALUES (?, ?, ?)",
            (key, value, desc),
        )
    # 项目改名迁移：旧名称自动更新为新名称
    conn.execute(
        "UPDATE settings SET value = '客房管理系统' WHERE key = 'hotel_name'"
        " AND value = '民宿客房管理系统'"
    )


def _ensure_channels(conn: sqlite3.Connection) -> None:
    """渠道表首次创建时写入默认入住渠道；已存在的渠道列表不重复生成。"""
    existed = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'channels'"
    ).fetchone()
    conn.executescript(CHANNELS_TABLE_DDL)
    if not existed:
        conn.executemany(
            "INSERT INTO channels (name, color, sort_order) VALUES (?, ?, ?)",
            [
                ("美团", "#FFB800", 1),
                ("线下", "#36CFC9", 2),
                ("携程", "#409EFF", 3),
                ("其他", "#9254DE", 4),
            ],
        )


def _migrate_expenses(conn: sqlite3.Connection) -> None:
    """手工收支表补充字段：kind（收入/支出）、客人、房号。"""
    columns = [r["name"] for r in conn.execute("PRAGMA table_info(expenses)").fetchall()]
    if "kind" not in columns:
        conn.execute("ALTER TABLE expenses ADD COLUMN kind TEXT NOT NULL DEFAULT 'expense'")
    if "guest_name" not in columns:
        conn.execute("ALTER TABLE expenses ADD COLUMN guest_name TEXT NOT NULL DEFAULT ''")
    if "room_number" not in columns:
        conn.execute("ALTER TABLE expenses ADD COLUMN room_number TEXT NOT NULL DEFAULT ''")


def _seed_sample_rooms(conn: sqlite3.Connection) -> None:
    """写入示例房间（仅首次初始化全新空库时调用）。"""
    now = int(time.time())
    # 示例房间归属总店；若总店缺失则归属任一已存在的门店，避免外键约束失败
    row = conn.execute(
        "SELECT id FROM stores WHERE name = '总店' ORDER BY id LIMIT 1"
    ).fetchone()
    if not row:
        row = conn.execute("SELECT id FROM stores ORDER BY id LIMIT 1").fetchone()
    store_id = row["id"] if row else 1
    conn.executemany(
        "INSERT INTO rooms (room_number, room_name, room_category, base_price, status, is_active, store_id, created_at)"
        " VALUES (?, ?, ?, ?, '空闲', 1, ?, ?)",
        [(*room, store_id, now) for room in SAMPLE_ROOMS],
    )


def _seed_stores(conn: sqlite3.Connection) -> None:
    """写入默认门店「总店」（仅首次初始化全新空库时调用）。"""
    conn.execute(
        "INSERT INTO stores (name, created_at) VALUES (?, ?)",
        ("总店", int(time.time())),
    )


def _is_db_seeded(conn: sqlite3.Connection) -> bool:
    """是否已完成首次示例数据初始化。"""
    row = conn.execute(
        "SELECT value FROM settings WHERE key = 'db_seeded'"
    ).fetchone()
    return bool(row and row["value"] == "1")


def _mark_db_seeded(conn: sqlite3.Connection) -> None:
    """记录首次初始化已完成；之后删除示例房间/总店也不会再自动生成。"""
    conn.execute(
        "INSERT OR IGNORE INTO settings (key, value, description)"
        " VALUES ('db_seeded', '1', '是否已完成首次示例数据初始化')"
    )
    conn.execute("UPDATE settings SET value = '1' WHERE key = 'db_seeded'")


def _seed_initial_data(conn: sqlite3.Connection) -> None:
    """首次初始化：仅在全新空库（无门店且无房间）时写入示例门店与示例房间；
    之后无论它们是否被删除，都不再重新生成。"""
    if _is_db_seeded(conn):
        return
    store_count = conn.execute("SELECT COUNT(*) AS c FROM stores").fetchone()["c"]
    room_count = conn.execute("SELECT COUNT(*) AS c FROM rooms").fetchone()["c"]
    if store_count == 0 and room_count == 0:
        _seed_stores(conn)
        _seed_sample_rooms(conn)
    _mark_db_seeded(conn)


def _ensure_indexes(conn: sqlite3.Connection) -> None:
    """创建索引（迁移重建表后会丢失索引，需要重建）。"""
    conn.executescript(INDEXES_DDL)
    columns = [r["name"] for r in conn.execute("PRAGMA table_info(orders)").fetchall()]
    if "order_no" in columns:
        conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_order_no ON orders(order_no)")


def _migrate_schema(conn: sqlite3.Connection) -> None:
    """旧库结构迁移：
    - rooms.room_type -> rooms.room_category（钟点->标准间、全日->大床房），新增 is_active
    - orders.order_type 取消中文枚举，值转为 full_day / hourly
    """
    order_sql = conn.execute(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'orders'"
    ).fetchone()
    if order_sql and ("全日租" in order_sql["sql"] or "钟点房" in order_sql["sql"]):
        _rebuild_orders(conn)

    room_columns = [r["name"] for r in conn.execute("PRAGMA table_info(rooms)").fetchall()]
    if "room_category" not in room_columns:
        _rebuild_rooms(conn)
        room_columns = [r["name"] for r in conn.execute("PRAGMA table_info(rooms)").fetchall()]
    if "store_id" not in room_columns:
        # SQLite 的 ALTER ADD COLUMN 不支持带非 NULL 默认值的 REFERENCES，门店存在性由应用层校验
        conn.execute("ALTER TABLE rooms ADD COLUMN store_id INTEGER NOT NULL DEFAULT 1")
    if "hourly_price" not in room_columns:
        # 钟点房价格字段：老库默认按全日价/24 折算，之后可在房间编辑中单独设置
        conn.execute("ALTER TABLE rooms ADD COLUMN hourly_price REAL NOT NULL DEFAULT 0")
        conn.execute(
            "UPDATE rooms SET hourly_price = ROUND(MAX(base_price / 24.0, 1), 2)"
        )

    # 兜底：残留中文订单类型统一转为英文
    conn.execute("UPDATE orders SET order_type = 'full_day' WHERE order_type = '全日租'")
    conn.execute("UPDATE orders SET order_type = 'hourly' WHERE order_type = '钟点房'")


def _rebuild_rooms(conn: sqlite3.Connection) -> None:
    """重建 rooms 表：room_type -> room_category，并新增 is_active=1。"""
    conn.execute("PRAGMA foreign_keys = OFF")
    try:
        conn.executescript("""
        CREATE TABLE rooms_new (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            room_number   TEXT    NOT NULL,
            room_name     TEXT    NOT NULL,
            room_category TEXT    NOT NULL DEFAULT '标准间'
                          CHECK (room_category IN ('标准间', '大床房', '套房', '双床房')),
            base_price    REAL    NOT NULL CHECK (base_price >= 0),
            hourly_price  REAL    NOT NULL DEFAULT 0 CHECK (hourly_price >= 0),
            status        TEXT    NOT NULL DEFAULT '空闲'
                          CHECK (status IN ('空闲', '已预订', '已入住', '维修')),
            is_active     INTEGER NOT NULL DEFAULT 1,
            store_id      INTEGER NOT NULL DEFAULT 1,
            created_at    INTEGER NOT NULL,
            UNIQUE (store_id, room_number)
        );
        INSERT INTO rooms_new (id, room_number, room_name, room_category, base_price, hourly_price, status, is_active, store_id, created_at)
        SELECT id, room_number, room_name,
               CASE room_type WHEN '钟点' THEN '标准间' ELSE '大床房' END,
               base_price, ROUND(MAX(base_price / 24.0, 1), 2), status, 1, 1, created_at
        FROM rooms;
        DROP TABLE rooms;
        ALTER TABLE rooms_new RENAME TO rooms;
        """)
    finally:
        conn.execute("PRAGMA foreign_keys = ON")


def _rebuild_orders(conn: sqlite3.Connection) -> None:
    """重建 orders 表：去掉 order_type 中文枚举限制，值转为 full_day / hourly。"""
    conn.execute("PRAGMA foreign_keys = OFF")
    try:
        conn.executescript("""
        CREATE TABLE orders_new (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            order_no        TEXT    NOT NULL DEFAULT '',
            room_id         INTEGER NOT NULL REFERENCES rooms(id) ON DELETE RESTRICT,
            order_type      TEXT    NOT NULL,
            guest_name      TEXT    NOT NULL,
            guest_phone     TEXT    NOT NULL DEFAULT '',
            guest_source    TEXT    NOT NULL DEFAULT '',
            remark          TEXT    NOT NULL DEFAULT '',
            start_timestamp INTEGER NOT NULL,
            end_timestamp   INTEGER NOT NULL,
            rent_hours      REAL,
            total_price     REAL    NOT NULL CHECK (total_price >= 0),
            extra_charge    REAL    NOT NULL DEFAULT 0,
            status          TEXT    NOT NULL DEFAULT '已预订'
                            CHECK (status IN ('已预订', '已入住', '已退房', '已取消')),
            created_at      INTEGER NOT NULL,
            updated_at      INTEGER NOT NULL
        );
        INSERT INTO orders_new (id, order_no, room_id, order_type, guest_name, guest_phone, guest_source, remark,
            start_timestamp, end_timestamp, rent_hours, total_price, extra_charge, status, created_at, updated_at)
        SELECT id, order_no, room_id,
               CASE order_type WHEN '全日租' THEN 'full_day' WHEN '钟点房' THEN 'hourly' ELSE order_type END,
               guest_name, guest_phone, '', remark,
               start_timestamp, end_timestamp, rent_hours, total_price, 0, status, created_at, updated_at
        FROM orders;
        DROP TABLE orders;
        ALTER TABLE orders_new RENAME TO orders;
        """)
    finally:
        conn.execute("PRAGMA foreign_keys = ON")


def _migrate_orders(conn: sqlite3.Connection) -> None:
    """兼容旧库：为 orders 表补充 order_no 列、回填历史订单号并创建唯一索引。"""
    columns = [row["name"] for row in conn.execute("PRAGMA table_info(orders)").fetchall()]
    if "order_no" not in columns:
        conn.execute("ALTER TABLE orders ADD COLUMN order_no TEXT NOT NULL DEFAULT ''")
    if "remark" not in columns:
        conn.execute("ALTER TABLE orders ADD COLUMN remark TEXT NOT NULL DEFAULT ''")
    if "extra_charge" not in columns:
        conn.execute("ALTER TABLE orders ADD COLUMN extra_charge REAL NOT NULL DEFAULT 0")
    if "guest_source" not in columns:
        conn.execute("ALTER TABLE orders ADD COLUMN guest_source TEXT NOT NULL DEFAULT ''")

    rows = conn.execute(
        "SELECT id, created_at FROM orders WHERE order_no = '' ORDER BY id"
    ).fetchall()
    for row in rows:
        date_key = datetime.fromtimestamp(row["created_at"]).strftime("%Y%m%d")
        max_seq = conn.execute(
            "SELECT COALESCE(MAX(CAST(SUBSTR(order_no, 11) AS INTEGER)), 0) AS m"
            " FROM orders WHERE order_no LIKE ?",
            (f"YD{date_key}%",),
        ).fetchone()["m"]
        conn.execute(
            "UPDATE orders SET order_no = ? WHERE id = ?",
            (f"YD{date_key}{max_seq + 1:04d}", row["id"]),
        )

    # 回填完成后才能安全创建唯一索引
    conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_order_no ON orders(order_no)")


def _migrate_rooms_number_per_store(conn: sqlite3.Connection) -> None:
    """房号唯一性改为「同一门店内唯一」：允许不同门店使用相同房号。
    旧表 room_number 带列级 UNIQUE 时重建为 (store_id, room_number) 唯一。
    """
    row = conn.execute(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'rooms'"
    ).fetchone()
    if not row:
        return
    ddl = row["sql"]
    has_per_store = "UNIQUE (store_id, room_number)" in ddl or "UNIQUE(store_id, room_number)" in ddl
    if not has_per_store:
        conn.execute("PRAGMA foreign_keys = OFF")
        try:
            conn.executescript("""
            CREATE TABLE rooms_new (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                room_number   TEXT    NOT NULL,
                room_name     TEXT    NOT NULL,
                room_category TEXT    NOT NULL DEFAULT '标准间'
                              CHECK (room_category IN ('标准间', '大床房', '套房', '双床房')),
                base_price    REAL    NOT NULL CHECK (base_price >= 0),
                hourly_price  REAL    NOT NULL DEFAULT 0 CHECK (hourly_price >= 0),
                status        TEXT    NOT NULL DEFAULT '空闲'
                              CHECK (status IN ('空闲', '已预订', '已入住', '维修')),
                is_active     INTEGER NOT NULL DEFAULT 1,
                store_id      INTEGER NOT NULL DEFAULT 1,
                created_at    INTEGER NOT NULL,
                UNIQUE (store_id, room_number)
            );
            INSERT INTO rooms_new (id, room_number, room_name, room_category, base_price,
                hourly_price, status, is_active, store_id, created_at)
            SELECT id, room_number, room_name, room_category, base_price,
                hourly_price, status, is_active, store_id, created_at FROM rooms;
            DROP TABLE rooms;
            ALTER TABLE rooms_new RENAME TO rooms;
            """)
        finally:
            conn.execute("PRAGMA foreign_keys = ON")
    conn.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_rooms_store_number ON rooms(store_id, room_number)"
    )


def _migrate_payments(conn: sqlite3.Connection) -> None:
    """订单结算字段与收款记录表：
    - orders 增加 settle_mode（once 一次性 / daily 日结）、daily_discount（每日优惠）、refund_amount（退回金额）
    - 创建 order_payments 收款记录表
    - 历史已退房订单按一次性结算回填一条收入记录，保证原收入数据不丢失
    """
    columns = [r["name"] for r in conn.execute("PRAGMA table_info(orders)").fetchall()]
    if "settle_mode" not in columns:
        conn.execute("ALTER TABLE orders ADD COLUMN settle_mode TEXT NOT NULL DEFAULT 'once'")
    if "daily_discount" not in columns:
        conn.execute("ALTER TABLE orders ADD COLUMN daily_discount REAL NOT NULL DEFAULT 0")
    if "refund_amount" not in columns:
        conn.execute("ALTER TABLE orders ADD COLUMN refund_amount REAL NOT NULL DEFAULT 0")
    conn.executescript(ORDER_PAYMENTS_TABLE_DDL)

    count = conn.execute("SELECT COUNT(*) AS c FROM order_payments").fetchone()["c"]
    if count == 0:
        rows = conn.execute(
            "SELECT id, total_price, end_timestamp, created_at FROM orders WHERE status = '已退房'"
        ).fetchall()
        for row in rows:
            pay_date = int(
                datetime.fromtimestamp(row["end_timestamp"])
                .replace(hour=0, minute=0, second=0, microsecond=0).timestamp()
            )
            conn.execute(
                "INSERT INTO order_payments (order_id, amount, pay_date, remark, created_at)"
                " VALUES (?, ?, ?, '历史订单回填', ?)",
                (row["id"], row["total_price"] or 0, pay_date, row["created_at"]),
            )


def _migrate_order_daily_price(conn: sqlite3.Connection) -> None:
    """orders 表新增 daily_price（订单内日单价）列并回填历史数据。

    日结收款以订单内的日单价为准；历史订单回填：
    - 长租：日单价 = 房间基础价 - 每日优惠（保持旧口径）；
    - 全日租：日单价 = 房间基础价。
    """
    columns = [r["name"] for r in conn.execute("PRAGMA table_info(orders)").fetchall()]
    if "daily_price" in columns:
        return
    conn.execute("ALTER TABLE orders ADD COLUMN daily_price REAL NOT NULL DEFAULT 0")
    conn.execute(
        "UPDATE orders SET daily_price = ROUND(MAX("
        "  (SELECT base_price FROM rooms WHERE id = orders.room_id) - COALESCE(daily_discount, 0), 0), 2)"
        " WHERE order_type = 'long_term'"
    )
    conn.execute(
        "UPDATE orders SET daily_price = "
        "  (SELECT base_price FROM rooms WHERE id = orders.room_id)"
        " WHERE order_type = 'full_day'"
    )


def _migrate_payment_account_date(conn: sqlite3.Connection) -> None:
    """order_payments 新增 account_date（入账日期）列。

    日结收款按“执行标记收款操作的当天”计入收入，而 pay_date 仍保留订单
    对应日期用于网格已收/未收标记；历史数据回填为 pay_date。
    """
    columns = [r["name"] for r in conn.execute("PRAGMA table_info(order_payments)").fetchall()]
    if "account_date" in columns:
        return
    conn.execute("ALTER TABLE order_payments ADD COLUMN account_date INTEGER")
    conn.execute("UPDATE order_payments SET account_date = pay_date")


def _migrate_order_adjust_amount(conn: sqlite3.Connection) -> None:
    """orders 新增 adjust_amount（退房实收与下单总额的多收/少收差额，负数为少收）。"""
    columns = [r["name"] for r in conn.execute("PRAGMA table_info(orders)").fetchall()]
    if "adjust_amount" in columns:
        return
    conn.execute("ALTER TABLE orders ADD COLUMN adjust_amount REAL NOT NULL DEFAULT 0")
