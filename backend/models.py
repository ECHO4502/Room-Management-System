# -*- coding: utf-8 -*-
"""数据表结构定义（SQL DDL）。

所有建表语句集中在此文件中，database.py 负责执行。
"""

STORES_TABLE_DDL = """
CREATE TABLE IF NOT EXISTS stores (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT    NOT NULL UNIQUE,
    created_at INTEGER NOT NULL
);
"""

ROOMS_TABLE_DDL = """
CREATE TABLE IF NOT EXISTS rooms (
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
    store_id      INTEGER NOT NULL DEFAULT 1 REFERENCES stores(id),
    created_at    INTEGER NOT NULL,
    UNIQUE (store_id, room_number)
);
"""

ORDERS_TABLE_DDL = """
CREATE TABLE IF NOT EXISTS orders (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    order_no        TEXT    NOT NULL DEFAULT '',
    room_id         INTEGER NOT NULL REFERENCES rooms(id) ON DELETE RESTRICT,
    order_type      TEXT    NOT NULL,
    settle_mode     TEXT    NOT NULL DEFAULT 'once',
    daily_discount  REAL    NOT NULL DEFAULT 0 CHECK (daily_discount >= 0),
    daily_price     REAL    NOT NULL DEFAULT 0 CHECK (daily_price >= 0),
    refund_amount   REAL    NOT NULL DEFAULT 0 CHECK (refund_amount >= 0),
    adjust_amount   REAL    NOT NULL DEFAULT 0,
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
"""

# 收款记录：正数为收入，负数为退款/扣减；日结订单按日标记，一次性订单退房时入账
ORDER_PAYMENTS_TABLE_DDL = """
CREATE TABLE IF NOT EXISTS order_payments (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id   INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    amount     REAL    NOT NULL,
    pay_date   INTEGER NOT NULL,
    account_date INTEGER,
    remark     TEXT    NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_order_payments_order ON order_payments(order_id);
CREATE INDEX IF NOT EXISTS idx_order_payments_date ON order_payments(pay_date);
"""

# 手动收支（收入/支出均可录入，可与订单收支合并展示）
EXPENSES_TABLE_DDL = """
CREATE TABLE IF NOT EXISTS expenses (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    kind         TEXT    NOT NULL DEFAULT 'expense',
    reason       TEXT    NOT NULL DEFAULT '',
    remark       TEXT    NOT NULL DEFAULT '',
    guest_name   TEXT    NOT NULL DEFAULT '',
    room_number  TEXT    NOT NULL DEFAULT '',
    amount       REAL    NOT NULL CHECK (amount >= 0),
    expense_date INTEGER NOT NULL,
    store_id     INTEGER NOT NULL DEFAULT 1,
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses(expense_date);
CREATE INDEX IF NOT EXISTS idx_expenses_store ON expenses(store_id);
"""

SETTINGS_TABLE_DDL = """
CREATE TABLE IF NOT EXISTS settings (
    key         TEXT PRIMARY KEY,
    value       TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT ''
);
"""

# 入住渠道（客人来源）：名称 + 颜色，用于下单选择与房态图着色
CHANNELS_TABLE_DDL = """
CREATE TABLE IF NOT EXISTS channels (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT    NOT NULL UNIQUE,
    color      TEXT    NOT NULL DEFAULT '#909399',
    sort_order INTEGER NOT NULL DEFAULT 0
);
"""

# 订单号序列（每天一个计数键，保证订单号不重复、不因删除而复用）
ORDER_SEQ_TABLE_DDL = """
CREATE TABLE IF NOT EXISTS order_seq (
    date_key TEXT PRIMARY KEY,
    last_seq INTEGER NOT NULL
);
"""

INDEXES_DDL = """
CREATE INDEX IF NOT EXISTS idx_orders_room_id  ON orders (room_id);
CREATE INDEX IF NOT EXISTS idx_orders_status   ON orders (status);
CREATE INDEX IF NOT EXISTS idx_orders_start    ON orders (start_timestamp);
CREATE INDEX IF NOT EXISTS idx_orders_end      ON orders (end_timestamp);
-- 冲突检测复合索引：(room_id, start_timestamp, end_timestamp, status)
CREATE INDEX IF NOT EXISTS idx_orders_room_time_status
    ON orders (room_id, start_timestamp, end_timestamp, status);
-- 订单号唯一索引在 database._migrate_orders 中回填后创建（旧库需先补列）
"""
