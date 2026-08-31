# -*- coding: utf-8 -*-
"""Windows 系统托盘：后台守护、菜单操作、退出确认。"""

import os
import re
import socket
import subprocess
import sys
import webbrowser
import winreg
from pathlib import Path
from tkinter import messagebox

import pystray
from PIL import Image, ImageDraw

from logger import get_log_dir

# 服务是否已正常启动（默认视为正常，由 main 在启动失败时置 False；失败时菜单点击提示查看日志）
SERVER_OK = True
# 实际端口（由 main 在启动前设置）
PORT = 8000


def make_house_icon(size: int = 64) -> Image.Image:
    """用 Pillow 在内存中绘制一个简单的房屋图标（64x64）。"""
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    # 屋顶
    draw.polygon([(4, 30), (32, 6), (60, 30)], fill=(255, 152, 0, 255))
    # 房身
    draw.rectangle([10, 28, 54, 58], fill=(64, 158, 255, 255))
    # 门
    draw.rectangle([26, 40, 38, 58], fill=(255, 255, 255, 255))
    return img


def get_all_ipv4() -> list[str]:
    """枚举本机所有 IPv4 地址（排除回环地址）。"""
    ips: set[str] = set()
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ip = info[4][0]
            if not ip.startswith("127."):
                ips.add(ip)
    except OSError:
        pass
    # 默认出口 IP 兜底
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.settimeout(0.5)
        sock.connect(("8.8.8.8", 80))
        ip = sock.getsockname()[0]
        sock.close()
        if not ip.startswith("127."):
            ips.add(ip)
    except OSError:
        pass
    # ipconfig 兜底（可枚举全部网卡 IPv4）
    if not ips:
        try:
            out = subprocess.check_output(
                ["ipconfig"], text=True, errors="replace", creationflags=0x08000000
            )
            for line in out.splitlines():
                if "IPv4" in line:
                    m = re.search(r"(\d+\.\d+\.\d+\.\d+)", line)
                    if m and not m.group(1).startswith("127."):
                        ips.add(m.group(1))
        except Exception:
            pass
    return sorted(ips)


def _service_down_hint() -> None:
    messagebox.showinfo("提示", "服务未启动，请检查日志")


def _open_system(icon, item) -> None:
    if not SERVER_OK:
        _service_down_hint()
        return
    webbrowser.open(f"http://127.0.0.1:{PORT}")


def _show_lan(icon, item) -> None:
    ips = get_all_ipv4()
    if not ips:
        ips = ["127.0.0.1"]
    text = "本机 IP 地址：\n\n" + "\n".join(f"http://{ip}:{PORT}" for ip in ips)
    text += "\n\n手机连接本店 Wi-Fi 后，访问以上任一地址即可打开系统。"
    messagebox.showinfo("局域网地址", text)


def _open_logs(icon, item) -> None:
    logs_dir = get_log_dir()
    logs_dir.mkdir(parents=True, exist_ok=True)
    os.startfile(str(logs_dir))


_AUTOSTART_NAME = "客房管理系统"


def _autostart_command() -> str:
    """开机自启动命令：打包后为 exe 本身；开发模式为 python backend/main.py。"""
    if getattr(sys, "frozen", False):
        return f'"{sys.executable}"'
    main_py = str(Path(__file__).resolve().parent / "main.py")
    return f'"{sys.executable}" "{main_py}"'


def is_autostart_enabled() -> bool:
    try:
        key = winreg.OpenKey(
            winreg.HKEY_CURRENT_USER,
            r"Software\Microsoft\Windows\CurrentVersion\Run",
            0,
            winreg.KEY_READ,
        )
        try:
            value, _ = winreg.QueryValueEx(key, _AUTOSTART_NAME)
            return bool(value)
        finally:
            key.Close()
    except OSError:
        return False


def set_autostart(enabled: bool) -> None:
    try:
        key = winreg.OpenKey(
            winreg.HKEY_CURRENT_USER,
            r"Software\Microsoft\Windows\CurrentVersion\Run",
            0,
            winreg.KEY_SET_VALUE,
        )
        try:
            if enabled:
                winreg.SetValueEx(key, _AUTOSTART_NAME, 0, winreg.REG_SZ, _autostart_command())
            else:
                try:
                    winreg.DeleteValue(key, _AUTOSTART_NAME)
                except FileNotFoundError:
                    pass
        finally:
            key.Close()
    except OSError as exc:
        messagebox.showerror("开机自启动", f"设置失败：{exc}")


def _toggle_autostart(icon, item) -> None:
    enabled = not is_autostart_enabled()
    set_autostart(enabled)
    messagebox.showinfo("开机自启动", "已开启开机自启动" if enabled else "已关闭开机自启动")


def _exit_app(icon, item) -> None:
    if messagebox.askyesno("退出系统", "确定要退出客房管理系统吗？"):
        icon.stop()
        os._exit(0)


def run(port: int = 8000, server_ok: bool = True) -> None:
    """启动托盘（阻塞主线程）。"""
    global PORT, SERVER_OK
    PORT = port
    SERVER_OK = server_ok

    icon = pystray.Icon(
        "room_management_system",
        make_house_icon(),
        "客房管理系统",
        menu=pystray.Menu(
            pystray.MenuItem("打开管理系统", _open_system, default=True),
            pystray.MenuItem("局域网地址", _show_lan),
            pystray.MenuItem("查看日志", _open_logs),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem("开机自启动", _toggle_autostart,
                             checked=lambda item: is_autostart_enabled()),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem("退出系统", _exit_app),
        ),
    )

    # 托盘启动成功提示：控制台可见（打包为无控制台程序时仅托盘，不额外弹窗）
    print(f"[托盘] 系统托盘已启动，端口 {PORT}。右键托盘图标可操作。", flush=True)

    try:
        icon.run()
    except Exception as exc:  # noqa: BLE001
        # 托盘启动失败（例如无桌面环境）：退回控制台驻留，便于调试
        print(f"[托盘] 托盘启动失败：{exc}", flush=True)
        print("[托盘] 已切换为控制台驻留模式，按 Ctrl+C 退出。", flush=True)
        import time

        while True:
            time.sleep(3600)
