# -*- coding: utf-8 -*-
"""FastAPI 应用入口。

开发运行：python backend/main.py 或 uvicorn backend.main:app
浏览器访问：http://127.0.0.1:8000
"""

import os
import socket
import sys
import threading
import time
from contextlib import asynccontextmanager
from datetime import datetime
from pathlib import Path
from typing import Callable, Optional

# 确保后端模块（crud/database/utils 等）可导入：开发模式用源码目录，
# PyInstaller 打包后用 _MEIPASS/backend（该目录随 --add-data 一起打包）
if getattr(sys, "frozen", False):
    _BACKEND_DIR = Path(getattr(sys, "_MEIPASS", Path(sys.executable).parent)) / "backend"
else:
    _BACKEND_DIR = Path(__file__).resolve().parent
if str(_BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(_BACKEND_DIR))

import uvicorn
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles

import crud
import database
import logger as app_logger
import schemas
import tray
import utils
from utils import AppError

APP_VERSION = "1.1.0"

# 日志系统：控制台 + logs/app.log（10MB 滚动）
app_logger.setup()

# 局域网访问地址（/api/qrcode 与 db-info 使用；端口在 __main__ 中按实际绑定更新）
LAN_IP = utils.get_lan_ip() or "127.0.0.1"
ACTIVE_PORT = int(os.environ.get("HOTEL_PORT", "8000"))


def get_access_url() -> str:
    return f"http://{LAN_IP}:{ACTIVE_PORT}"


def _get_frontend_dir() -> Path:
    if getattr(sys, "frozen", False):
        bundle = Path(getattr(sys, "_MEIPASS", Path(sys.executable).parent))
        return bundle / "frontend"
    return Path(__file__).resolve().parent.parent / "frontend"


@asynccontextmanager
async def lifespan(_: FastAPI):
    database.init_db()
    _auto_backup_on_startup()
    yield


app = FastAPI(
    title="客房管理系统",
    description="Room Management System - 单机私有部署",
    version=APP_VERSION,
    lifespan=lifespan,
)


def _auto_backup_on_startup() -> None:
    """启动时自动备份：写入数据库同级 backups/ 目录，按日期命名，保留最近 7 份。"""
    try:
        backup_dir = database.get_db_path().parent / "backups"
        utils.backup_database(
            target_dir=backup_dir,
            filename=f"auto_{datetime.now().strftime('%Y%m%d')}.zip",
        )
        utils.cleanup_old_backups(backup_dir, keep=7, pattern="auto_*.zip")
    except Exception as exc:  # noqa: BLE001
        print(f"[备份] 启动自动备份失败：{exc}")


# 跨域配置：允许所有来源（方便本地开发调试）
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


def _with_conn(fn: Callable):
    """统一管理数据库连接，并把业务错误转换为 HTTP 异常。"""
    conn = database.get_connection()
    try:
        try:
            return fn(conn)
        except AppError as exc:
            raise HTTPException(status_code=exc.status_code, detail=exc.message) from exc
    finally:
        conn.close()


# ---------------- 统计 ----------------

@app.get("/api/db-info", tags=["系统"])
def api_db_info():
    """数据库概览：房间/订单记录数、系统版本、备份目录。"""
    return _with_conn(lambda c: {
        "version": APP_VERSION,
        "author": "ECHO4502",
        "rooms": c.execute(
            "SELECT COUNT(*) AS c FROM rooms WHERE is_active = 1"
        ).fetchone()["c"],
        "orders": c.execute("SELECT COUNT(*) AS c FROM orders").fetchone()["c"],
        "db_path": str(database.get_db_path()),
        "backups_dir": str(database.get_db_path().parent / "backups"),
        "access_url": get_access_url(),
    })


@app.get("/api/qrcode", tags=["系统"])
def api_qrcode():
    """返回包含局域网访问地址的二维码 PNG 图片。"""
    try:
        img_bytes = utils.build_qrcode_png(get_access_url())
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"二维码生成失败：{exc}") from exc
    return Response(content=img_bytes, media_type="image/png")


@app.get("/api/backup/download", tags=["系统"])
def api_backup_download():
    """触发备份并返回 ZIP 文件流供浏览器下载。"""
    try:
        zip_path = utils.backup_database()
    except AppError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.message) from exc
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"备份失败：{exc}") from exc
    return FileResponse(
        path=str(zip_path),
        media_type="application/zip",
        filename=zip_path.name,
    )

@app.get("/api/statistics/today", response_model=schemas.TodayStatisticsOut, tags=["统计"])
def api_statistics_today(date_ts: Optional[int] = None):
    """指定日期（默认今天）应到人数、应退人数、当日收入。"""
    return _with_conn(lambda c: crud.get_today_statistics(c, date_ts))


@app.get("/api/stats", response_model=schemas.StatsOut, tags=["统计"])
def api_stats():
    """工作台统计（房间分布、今日订单等）。"""
    return _with_conn(crud.get_stats)


@app.get("/api/room-status", response_model=schemas.RoomStatusRangeOut, tags=["统计"])
def api_room_status(start_date: int, end_date: int, room_id: Optional[int] = None,
                    store_id: Optional[int] = None):
    """指定日期范围内所有房间的逐日状态（用于房态图）。"""
    return _with_conn(
        lambda c: crud.get_room_status_by_date_range(c, start_date, end_date, room_id, store_id)
    )


@app.get("/api/statistics/revenue", response_model=schemas.RevenueOut, tags=["统计"])
def api_statistics_revenue(start_ts: Optional[int] = None, end_ts: Optional[int] = None,
                           store_id: Optional[int] = None,
                           gran: str = Query("month"),
                           keyword: Optional[str] = None):
    """收支统计：按门店与时间范围筛选；gran=year/month/day/custom；keyword 匹配客人姓名/手机号/房号/订单号。"""
    return _with_conn(
        lambda c: crud.get_revenue_statistics(c, store_id, start_ts, end_ts, gran, keyword)
    )


@app.post("/api/expenses", response_model=schemas.ExpenseResponse, status_code=201, tags=["统计"])
def api_create_expense(data: schemas.ExpenseCreate):
    """新增支出：支出时间（默认当日）、理由、金额、备注。"""
    return _with_conn(lambda c: crud.create_expense(c, data))


@app.delete("/api/expenses/{expense_id}", status_code=204, tags=["统计"])
def api_delete_expense(expense_id: int, confirm: bool = Query(False)):
    """删除支出条目。"""
    _with_conn(lambda c: crud.delete_expense(c, expense_id, confirm))


@app.put("/api/expenses/{expense_id}", response_model=schemas.ExpenseResponse, tags=["统计"])
def api_update_expense(expense_id: int, data: schemas.ExpenseUpdate):
    """编辑手动收支条目。"""
    return _with_conn(lambda c: crud.update_expense(c, expense_id, data))


# ---------------- 入住渠道 ----------------

@app.get("/api/channels", response_model=list[schemas.ChannelResponse], tags=["渠道"])
def api_list_channels():
    return _with_conn(crud.list_channels)


@app.post("/api/channels", response_model=schemas.ChannelResponse, status_code=201, tags=["渠道"])
def api_create_channel(data: schemas.ChannelCreate):
    return _with_conn(lambda c: crud.create_channel(c, data))


@app.put("/api/channels/{channel_id}", response_model=schemas.ChannelResponse, tags=["渠道"])
def api_update_channel(channel_id: int, data: schemas.ChannelUpdate):
    return _with_conn(lambda c: crud.update_channel(c, channel_id, data))


@app.delete("/api/channels/{channel_id}", status_code=204, tags=["渠道"])
def api_delete_channel(channel_id: int, confirm: bool = Query(False)):
    _with_conn(lambda c: crud.delete_channel(c, channel_id, confirm))


# ---------------- 门店 ----------------

@app.get("/api/stores", response_model=list[schemas.StoreResponse], tags=["门店"])
def api_list_stores():
    return _with_conn(crud.list_stores)


@app.post("/api/stores", response_model=schemas.StoreResponse, status_code=201, tags=["门店"])
def api_create_store(data: schemas.StoreCreate):
    return _with_conn(lambda c: crud.create_store(c, data))


@app.put("/api/stores/{store_id}", response_model=schemas.StoreResponse, tags=["门店"])
def api_update_store(store_id: int, data: schemas.StoreUpdate):
    return _with_conn(lambda c: crud.update_store(c, store_id, data))


@app.delete("/api/stores/{store_id}", status_code=204, tags=["门店"])
def api_delete_store(store_id: int, confirm: bool = Query(False)):
    _with_conn(lambda c: crud.delete_store(c, store_id, confirm))


# ---------------- 房间 ----------------

@app.get("/api/rooms", response_model=list[schemas.RoomResponse], tags=["房间"])
def api_list_rooms(status: Optional[str] = None, keyword: Optional[str] = None,
                   include_inactive: bool = False, store_id: Optional[int] = None,
                   active: Optional[int] = None):
    return _with_conn(lambda c: crud.get_all_rooms(c, status, keyword, include_inactive, store_id, active))


@app.get("/api/available-rooms", response_model=list[schemas.RoomResponse], tags=["房间"])
def api_available_rooms(start_ts: int, end_ts: int, store_id: Optional[int] = None):
    """返回指定时间段内可预订的房间列表（供前端预订弹窗动态加载）。"""
    return _with_conn(lambda c: crud.get_available_rooms(c, start_ts, end_ts, store_id))


@app.post("/api/rooms", response_model=schemas.RoomResponse, status_code=201, tags=["房间"])
def api_create_room(data: schemas.RoomCreate):
    return _with_conn(lambda c: crud.create_room(c, data))


@app.put("/api/rooms/{room_id}", response_model=schemas.RoomResponse, tags=["房间"])
def api_update_room(room_id: int, data: schemas.RoomUpdate):
    return _with_conn(lambda c: crud.update_room(c, room_id, data))


@app.delete("/api/rooms/{room_id}", status_code=204, tags=["房间"])
def api_delete_room(room_id: int, confirm: bool = Query(False), hard: bool = Query(False)):
    """删除房间：confirm 为二次确认；hard=true 时彻底删除（无订单的房间）。"""
    _with_conn(lambda c: crud.delete_room(c, room_id, confirm, hard))


# ---------------- 订单 ----------------

@app.get("/api/orders", response_model=list[schemas.OrderResponse], tags=["订单"])
def api_list_orders(status: Optional[str] = None, room_id: Optional[int] = None,
                    room_number: Optional[str] = None,
                    order_type: Optional[str] = None,
                    guest_name: Optional[str] = None, guest_phone: Optional[str] = None,
                    keyword: Optional[str] = None,
                    date_from: Optional[int] = None, date_to: Optional[int] = None,
                    store_id: Optional[int] = None,
                    date_mode: str = Query("overlap")):
    return _with_conn(
        lambda c: crud.get_all_orders(c, status, room_id, room_number, guest_name,
                                      guest_phone, keyword, date_from, date_to, store_id,
                                      order_type, date_mode)
    )


@app.post("/api/orders/check-conflict", response_model=list[schemas.OrderResponse],
          tags=["订单"])
def api_check_conflict(data: schemas.ConflictCheckRequest):
    """冲突检测：返回与指定时间段重叠的进行中订单列表。"""
    order_type = data.order_type.value if data.order_type else None
    return _with_conn(
        lambda c: utils.check_room_conflict(
            c, data.room_id, data.start_timestamp, data.end_timestamp,
            data.exclude_order_id, order_type, data.rent_hours,
        )
    )


@app.post("/api/orders", response_model=schemas.OrderResponse, status_code=201, tags=["订单"])
def api_create_order(data: schemas.OrderCreate):
    """创建订单（自动冲突检测，冲突时返回 409）。"""
    return _with_conn(lambda c: crud.create_order(c, data))


@app.get("/api/orders/{order_id}", response_model=schemas.OrderResponse, tags=["订单"])
def api_get_order(order_id: int):
    return _with_conn(lambda c: crud.get_order(c, order_id))


@app.put("/api/orders/{order_id}", response_model=schemas.OrderResponse, tags=["订单"])
def api_update_order(order_id: int, data: schemas.OrderUpdate):
    return _with_conn(lambda c: crud.update_order(c, order_id, data))


@app.delete("/api/orders/{order_id}", status_code=204, tags=["订单"])
def api_delete_order(order_id: int, confirm: bool = Query(False)):
    _with_conn(lambda c: crud.delete_order(c, order_id, confirm))


@app.post("/api/orders/{order_id}/checkin", response_model=schemas.OrderResponse, tags=["订单"])
def api_checkin(order_id: int):
    """办理入住：已预订 -> 已入住。"""
    return _with_conn(lambda c: crud.checkin_order(c, order_id))


@app.post("/api/orders/{order_id}/checkout", response_model=schemas.OrderResponse, tags=["订单"])
def api_checkout(order_id: int, data: Optional[schemas.CheckoutRequest] = None):
    """办理退房：改为已退房；可修改实收金额、输入退回金额（从收入中扣除）。"""
    end = data.end_timestamp if data else None
    confirm = bool(data and data.confirm)
    total = data.total_price if data else None
    refund = data.refund_amount if data else None
    return _with_conn(lambda c: crud.checkout_order(c, order_id, end, total, refund, confirm))


@app.post("/api/orders/{order_id}/cancel", response_model=schemas.OrderResponse, tags=["订单"])
def api_cancel_order(order_id: int, data: Optional[schemas.CancelRequest] = None):
    """取消订单：已计入收入的订单可填退回金额，从收入中扣除。"""
    refund = data.refund_amount if data else None
    confirm = bool(data and data.confirm)
    return _with_conn(lambda c: crud.cancel_order(c, order_id, refund, confirm))


@app.post("/api/orders/{order_id}/extend", response_model=schemas.OrderResponse, tags=["订单"])
def api_extend_order(order_id: int, data: schemas.ExtendRequest,
                     confirm: bool = Query(False)):
    """续住：全日租/长租按天，钟点房按小时；金额按当前计费方案计算。"""
    return _with_conn(lambda c: crud.extend_order(c, order_id, data.count, data.amount, confirm))


@app.get("/api/orders/{order_id}/payments", response_model=list[schemas.PaymentResponse],
         tags=["订单"])
def api_list_order_payments(order_id: int):
    return _with_conn(lambda c: crud.list_order_payments(c, order_id))


@app.post("/api/orders/{order_id}/payments", response_model=schemas.PaymentResponse,
          status_code=201, tags=["订单"])
def api_upsert_order_payment(order_id: int, data: schemas.PaymentCreate):
    """标记已收当日款（日结）：同一天重复提交为更新实收金额。"""
    return _with_conn(lambda c: crud.upsert_order_payment(c, order_id, data))


# ---------------- 设置 ----------------

@app.get("/api/settings", response_model=list[schemas.SettingsItem], tags=["设置"])
def api_list_settings():
    return _with_conn(crud.list_settings)


@app.put("/api/settings", response_model=list[schemas.SettingsItem], tags=["设置"])
def api_update_settings(data: schemas.SettingsUpdate):
    return _with_conn(lambda c: crud.update_settings(c, data.items))


# ---------------- 前端静态页面 ----------------

FRONTEND_DIR = _get_frontend_dir()
DIST_DIR = FRONTEND_DIR / "dist"
STATIC_DIR = DIST_DIR if DIST_DIR.is_dir() else FRONTEND_DIR
if STATIC_DIR.is_dir():
    app.mount("/", StaticFiles(directory=str(STATIC_DIR), html=True), name="frontend")
else:
    @app.get("/", include_in_schema=False)
    def no_frontend():
        return JSONResponse({"message": "未找到前端目录，请确认 frontend/ 或 frontend/dist 存在"})


if __name__ == "__main__":
    # Windows 控制台默认 GBK，切换为 UTF-8 以便正常显示中文与 emoji
    for stream in (sys.stdout, sys.stderr):
        if stream and hasattr(stream, "reconfigure"):
            try:
                stream.reconfigure(encoding="utf-8", errors="replace")
            except Exception:
                pass

    host = os.environ.get("HOTEL_HOST", "0.0.0.0")  # 默认绑定所有网卡，允许局域网访问
    port = int(os.environ.get("HOTEL_PORT", "8000"))
    ACTIVE_PORT = port
    LAN_IP = utils.get_lan_ip() or "127.0.0.1"

    def _port_in_use(check_port: int) -> bool:
        """检查端口是否已被占用（避免重复运行）。"""
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
            try:
                probe.bind(("0.0.0.0", check_port))
                return False
            except OSError:
                return True

    # 端口占用检查：占用则打印错误并退出，避免重复运行
    if _port_in_use(port):
        msg = (
            f"端口 {port} 已被占用，可能系统已在运行。\n"
            "请先通过托盘图标退出，或关闭占用该端口的程序后重试。"
        )
        if getattr(sys, "frozen", False):
            try:
                import win32api

                win32api.MessageBox(0, msg, "客房管理系统", 0x10)
            except Exception:
                pass
        print(f"[启动失败] {msg}", flush=True)
        raise SystemExit(1)

    def start_server() -> None:
        """在子线程中运行 uvicorn 服务。"""
        try:
            uvicorn.run(app, host=host, port=port, log_config=None)
        except SystemExit:
            tray.SERVER_OK = False
            raise
        except Exception as exc:  # noqa: BLE001
            tray.SERVER_OK = False
            print(f"[服务] 服务启动失败：{exc}", flush=True)
            raise

    # 服务放子线程，主线程负责托盘
    threading.Thread(target=start_server, daemon=True).start()

    # 等待服务就绪（最多约 15 秒）；失败不影响托盘显示
    ready = False
    for _ in range(150):
        if tray.SERVER_OK is False:
            break
        if _port_in_use(port):
            ready = True
            break
        time.sleep(0.1)

    url = get_access_url()
    if ready:
        print("=" * 48, flush=True)
        print("✅ 系统已启动！", flush=True)
        print(f"📱 手机端请访问: {url}", flush=True)
        print("📷 打开设置页面扫描二维码快速访问", flush=True)
        print(f"💻 本机访问: http://127.0.0.1:{ACTIVE_PORT}", flush=True)
        print("=" * 48, flush=True)
    else:
        print("[警告] 服务可能未正常启动，托盘仍会显示；可点击托盘“查看日志”检查 logs/app.log。", flush=True)

    # 打包后的 exe：自动打开本机浏览器（PC 走回环地址；手机端用局域网地址扫码）
    if getattr(sys, "frozen", False) and not os.environ.get("HOTEL_NO_BROWSER") and ready:
        import webbrowser

        threading.Timer(1.5, lambda: webbrowser.open(f"http://127.0.0.1:{ACTIVE_PORT}")).start()

    # 全局异常捕获：托盘异常不影响服务运行；服务异常托盘仍显示
    try:
        tray.run(port=port, server_ok=ready)
    except KeyboardInterrupt:
        print("[退出] 已收到退出信号。", flush=True)
    except Exception as exc:  # noqa: BLE001
        print(f"[托盘] 托盘异常：{exc}", flush=True)
        print("[托盘] 服务仍在后台运行，按 Ctrl+C 退出。", flush=True)
        while True:
            time.sleep(3600)
