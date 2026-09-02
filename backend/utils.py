# -*- coding: utf-8 -*-
"""通用工具：时间、订单冲突检测、价格计算。"""

import io
import math
import os
import socket
import sqlite3
import time
import zipfile
from datetime import datetime, timedelta
from pathlib import Path

ACTIVE_ORDER_STATUSES = ("已预订", "已入住")

# 全日租标准化时间：入住日当天 14:00 入住，退房日当天 12:00 退房
FULL_DAY_CHECKIN_HOUR = 14
FULL_DAY_CHECKOUT_HOUR = 12

# 全日租归一化相对原始时间戳的最大偏移余量（用于 SQL 预过滤，保证不漏查）
_EXTEND_MARGIN_SECONDS = 14 * 3600


class AppError(Exception):
    """业务错误：携带面向用户的中文提示与 HTTP 状态码。"""

    def __init__(self, message: str, status_code: int = 400):
        super().__init__(message)
        self.message = message
        self.status_code = status_code


def now_ts() -> int:
    """当前 Unix 时间戳（秒）。"""
    return int(time.time())


def day_start(ts: int) -> int:
    """某时间戳所在自然日的零点（Unix 秒）。"""
    return int(
        datetime.fromtimestamp(ts).replace(hour=0, minute=0, second=0, microsecond=0).timestamp()
    )


def day_end(ts: int) -> int:
    """某时间戳所在自然日的次日零点（Unix 秒）。"""
    return day_start(ts) + 86400


def date_str(ts: int) -> str:
    """格式化为 YYYY-MM-DD。"""
    return datetime.fromtimestamp(ts).strftime("%Y-%m-%d")


def normalize_order_range(order_type: str, start_ts: int, end_ts: int,
                          rent_hours: float | None = None) -> tuple[int, int]:
    """返回订单在冲突检测中使用的实际占用时间段。

    - full_day（全日租）：入住日当天 14:00 → 退房日当天 12:00（跨多晚同样适用）；
      若退房日早于入住日（同日结束的退化场景），回退为原始时间范围。
    - hourly（钟点房）：start_timestamp → start_timestamp + rent_hours * 3600。
    """
    if order_type == "full_day":
        norm_start = day_start(start_ts) + FULL_DAY_CHECKIN_HOUR * 3600
        norm_end = day_start(end_ts) + FULL_DAY_CHECKOUT_HOUR * 3600
        # 迟退房：实际退房时间晚于 12:00 时，占用到实际退房时间
        if end_ts > norm_end:
            norm_end = end_ts
        if norm_end <= norm_start:
            return start_ts, end_ts
        return norm_start, norm_end
    hours = rent_hours if rent_hours and rent_hours > 0 else max(1.0, (end_ts - start_ts) / 3600.0)
    norm_end = start_ts + int(round(hours * 3600))
    # 钟点房迟退房：实际退房时间晚于下单时长时，占用到实际退房时刻
    if end_ts > norm_end:
        norm_end = end_ts
    return start_ts, norm_end


def check_room_conflict(conn, room_id: int, start_ts: int, end_ts: int,
                        exclude_order_id: int | None = None,
                        order_type: str | None = None,
                        rent_hours: float | None = None) -> list[dict]:
    """查询某房间与 [start_ts, end_ts) 冲突的进行中订单。

    时间重叠判定：新订单开始时间 < 已有订单结束时间
                   AND 新订单结束时间 > 已有订单开始时间
    即 start1 < end2 AND end1 > start2。

    参与比较的时间段会先按订单类型归一化（全日租 14:00→次日 12:00、钟点房按时长），
    因此全日租与钟点房之间的混合重叠也能被准确检出。

    只统计状态为「已预订」或「已入住」的订单，返回冲突订单列表（含房间号/房间名称）。
    """
    new_start, new_end = (
        normalize_order_range(order_type, start_ts, end_ts, rent_hours)
        if order_type
        else (start_ts, end_ts)
    )

    # 先用宽松的原始时间窗口做 SQL 预过滤（命中 (room_id, start_timestamp, end_timestamp) 索引），
    # 再在 Python 中按归一化时间段做精确判断，保证正确性。
    sql = (
        "SELECT o.*, r.room_number, r.room_name FROM orders o"
        " JOIN rooms r ON r.id = o.room_id"
        " WHERE o.room_id = ? AND o.status IN ('已预订', '已入住')"
        " AND o.start_timestamp < ? AND o.end_timestamp > ?"
    )
    params: list = [
        room_id,
        new_end + _EXTEND_MARGIN_SECONDS,
        new_start - _EXTEND_MARGIN_SECONDS,
    ]
    if exclude_order_id is not None:
        sql += " AND o.id != ?"
        params.append(exclude_order_id)
    sql += " ORDER BY o.start_timestamp"

    conflicts: list[dict] = []
    for row in conn.execute(sql, params).fetchall():
        order = dict(row)
        order_start, order_end = normalize_order_range(
            order["order_type"], order["start_timestamp"], order["end_timestamp"], order["rent_hours"]
        )
        if new_start < order_end and new_end > order_start:
            conflicts.append(order)
    return conflicts


def has_room_conflict(conn, room_id: int, start_ts: int, end_ts: int,
                      exclude_order_id: int | None = None,
                      order_type: str | None = None,
                      rent_hours: float | None = None) -> bool:
    """布尔形式的冲突检测，供内部逻辑快速判断。"""
    return bool(check_room_conflict(conn, room_id, start_ts, end_ts,
                                    exclude_order_id, order_type, rent_hours))


def calculate_price(order_type: str, base_price: float, start: int, end: int,
                    rent_hours: float | None = None,
                    min_rent_hours: float = 1.0,
                    hourly_increment: float = 1.0,
                    hourly_price: float | None = None,
                    daily_price: float = 0.0) -> float:
    """价格计算：
    - full_day（全日租）：按晚计费，不足一晚按一晚计；
    - long_term（长租）：按日计费，日租价 = 订单内日单价（未设置时用房间基础价）；
    - hourly（钟点房）：按日租原价计费，至少收一晚；订单时间每超过一个次日 12:00 即多收一晚。
    """
    if order_type in ("full_day", "long_term"):
        seconds = max(1, end - start)
        days = max(1, math.ceil(seconds / 86400))
        rate = daily_price if (daily_price or 0) > 0 else max(0.0, base_price)
        return round(rate * days, 2)
    # 钟点房按日租原价计费：至少收一晚日租价；
    # 计费上限随超时逐日上调：订单时间每超过一个次日 12:00 即多收一晚
    base = max(0.0, base_price)
    end_ts = start + int(round((rent_hours if rent_hours and rent_hours > 0 else max(1.0, (end - start) / 3600.0)) * 3600))
    nights = 1
    boundary = day_start(start) + 36 * 3600
    while end_ts > boundary:
        nights += 1
        boundary += 86400
    return round(base * nights, 2)
# ---------------- 数据备份 ----------------

def _pick_backup_dir() -> Path | None:
    """备份目标目录：优先环境变量，其次桌面/文档，最后返回 None（由调用方回退）。"""
    override = os.environ.get("HOTEL_BACKUP_DIR")
    if override:
        return Path(override)
    for candidate in (
        Path(os.path.expanduser("~/Desktop")),
        Path(os.path.expanduser("~/Documents")),
    ):
        try:
            candidate.mkdir(parents=True, exist_ok=True)
            if candidate.is_dir():
                return candidate
        except OSError:
            continue
    return None


def backup_database(db_path: str | Path | None = None,
                    target_dir: str | Path | None = None,
                    filename: str | None = None,
                    reason: str = "一键备份") -> Path:
    """安全备份 SQLite 数据库为 ZIP 文件，返回备份文件完整路径。

    备份过程：
    1. 使用 sqlite3 官方备份 API 将数据库复制到内存（不锁库、保证一致性）；
    2. 从内存写入临时 .db 文件；
    3. 将临时 .db 与备份说明压缩为 ZIP（文件名默认 backup_YYYYMMDD_HHMMSS.zip）。

    目标目录优先级：显式 target_dir > 环境变量 HOTEL_BACKUP_DIR > 桌面 > 文档 > 数据库同级 backups。
    """
    if db_path is None:
        from database import get_db_path  # 延迟导入避免循环依赖
        db_path = get_db_path()
    db_path = Path(db_path)
    if not db_path.exists():
        raise AppError("数据库文件不存在，无法备份", 404)

    if target_dir is None:
        target_dir = _pick_backup_dir() or db_path.parent / "backups"
    target_dir = Path(target_dir)
    target_dir.mkdir(parents=True, exist_ok=True)

    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    name = filename or f"{reason}_{stamp}.zip"
    zip_path = target_dir / name
    tmp_db = target_dir / f"_tmp_{stamp}.db"

    src = sqlite3.connect(str(db_path))
    mem = sqlite3.connect(":memory:")
    tmp_conn = None
    try:
        src.backup(mem)  # 数据库 → 内存
        mem.commit()
        tmp_conn = sqlite3.connect(str(tmp_db))
        mem.backup(tmp_conn)  # 内存 → 临时文件
        tmp_conn.commit()
    finally:
        src.close()
        if tmp_conn is not None:
            tmp_conn.close()
        mem.close()

    try:
        with zipfile.ZipFile(str(zip_path), "w", zipfile.ZIP_DEFLATED) as zf:
            zf.write(str(tmp_db), arcname="hotel.db")
            zf.writestr(
                "backup_info.txt",
                "客房管理系统数据备份\n"
                f"生成时间：{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n"
                f"备份原因：{reason}\n"
                f"来源数据库：{db_path}\n"
                f"备份文件：{zip_path}\n",
            )
    finally:
        try:
            tmp_db.unlink()
        except OSError:
            pass
    return zip_path


def cleanup_old_backups(backup_dir: str | Path, keep: int = 7,
                        pattern: str = "backup_*.zip") -> None:
    """清理备份目录中过旧的 ZIP 备份，默认保留最近 7 份。"""
    backup_dir = Path(backup_dir)
    if not backup_dir.is_dir():
        return
    files = sorted(
        backup_dir.glob(pattern),
        key=lambda p: p.stat().st_mtime,
        reverse=True,
    )
    for old in files[keep:]:
        try:
            old.unlink()
        except OSError:
            pass


# ---------------- 局域网 / 二维码 ----------------

def get_lan_ip() -> str | None:
    """获取本机局域网 IP（如 192.168.x.x）；失败返回 None。"""
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.settimeout(0.5)
        # UDP connect 只选定出口路由，不实际发包
        sock.connect(("8.8.8.8", 80))
        ip = sock.getsockname()[0]
        sock.close()
        if ip and not ip.startswith("127."):
            return ip
    except OSError:
        pass
    try:
        return socket.gethostbyname(socket.gethostname())
    except OSError:
        return None


def build_qrcode_png(data: str) -> bytes:
    """把字符串编码为二维码 PNG 图片字节。"""
    import qrcode

    qr = qrcode.QRCode(version=None, box_size=10, border=2)
    qr.add_data(data)
    qr.make(fit=True)
    img = qr.make_image(fill_color="black", back_color="white")
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()

def restore_database(zip_path: str | Path, db_path: str | Path | None = None) -> Path:
    """从备份 ZIP 恢复数据库：把压缩包内的 hotel.db 替换当前数据库文件。

    调用方需先备份当前数据（读取备份前保留）；本函数只做替换。
    """
    zip_path = Path(zip_path)
    if not zip_path.exists():
        raise AppError("备份文件不存在", 404)
    if db_path is None:
        from database import get_db_path  # 延迟导入避免循环依赖
        db_path = get_db_path()
    db_path = Path(db_path)
    db_path.parent.mkdir(parents=True, exist_ok=True)

    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    tmp_db = db_path.parent / f"_restore_tmp_{stamp}.db"
    try:
        with zipfile.ZipFile(str(zip_path)) as zf:
            names = zf.namelist()
            member = "hotel.db" if "hotel.db" in names else next(
                (n for n in names if n.endswith(".db")), None
            )
            if not member:
                raise AppError("备份文件中未找到数据库（hotel.db）")
            with zf.open(member) as src, open(str(tmp_db), "wb") as dst:
                dst.write(src.read())
        for attempt in range(5):
            try:
                os.replace(str(tmp_db), str(db_path))
                break
            except OSError:
                if attempt == 4:
                    raise
                time.sleep(0.3)
    finally:
        try:
            tmp_db.unlink()
        except OSError:
            pass
    return db_path

def calculate_expected_repay_date(settle_date: int, repay_type: str,
                                  repay_days: int = 0, repay_weekday: int = 1,
                                  repay_monthday: int = 1) -> int:
    """按渠道回款规则计算预计到账日期（返回该日零点 Unix 秒）。

    - direct：结算当日到账；
    - days：结算日 + N 天；
    - week：结算日所在周的指定星期（周一=1..周日=7），已过则下周；
    - month：结算日所在月的指定日，已过则下月。
    """
    base_day = day_start(settle_date)
    d = datetime.fromtimestamp(base_day)
    if repay_type == "days":
        return int(day_start(base_day + max(0, int(repay_days)) * 86400))
    if repay_type == "week":
        weekday = max(1, min(7, int(repay_weekday or 1)))
        monday = d - timedelta(days=d.weekday())
        target = monday + timedelta(days=weekday - 1)
        if target <= d:
            target += timedelta(days=7)
        return int(day_start(target.timestamp()))
    if repay_type == "month":
        mday = max(1, min(28, int(repay_monthday or 1)))
        try:
            target = d.replace(day=mday)
        except ValueError:
            target = d.replace(day=28)
        if target <= d:
            if d.month == 12:
                target = d.replace(year=d.year + 1, month=1, day=min(mday, 28))
            else:
                target = d.replace(month=d.month + 1, day=min(mday, 28))
        return int(day_start(target.timestamp()))
    return base_day  # direct：结算当日到账
