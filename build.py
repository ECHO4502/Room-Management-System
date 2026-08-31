# -*- coding: utf-8 -*-
"""PyInstaller 打包脚本。

用法（在项目根目录执行）：
    pip install -r requirements.txt
    python build.py

打包完成后，exe 位于 dist/ 目录；运行 exe 时数据库自动生成在 exe 同级目录 data/ 下。
"""

import os
import subprocess
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent
APP_NAME = "客房管理系统"

# 前端离线依赖（本地 vendor 目录缺失时自动下载，保证打包后无网络也可使用）
VENDOR_FILES = {
    "frontend/vendor/vue/vue.global.prod.js":
        "https://unpkg.com/vue@3.4.38/dist/vue.global.prod.js",
    "frontend/vendor/element-plus/index.css":
        "https://unpkg.com/element-plus@2.8.4/dist/index.css",
    "frontend/vendor/element-plus/index.full.min.js":
        "https://unpkg.com/element-plus@2.8.4/dist/index.full.min.js",
    "frontend/vendor/element-plus/zh-cn.min.js":
        "https://unpkg.com/element-plus@2.8.4/dist/locale/zh-cn.min.js",
}


def ensure_vendor_assets() -> None:
    """确保前端离线依赖存在，缺失时尝试下载。"""
    for rel, url in VENDOR_FILES.items():
        target = ROOT / rel
        if target.exists() and target.stat().st_size > 0:
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        print(f"下载前端依赖：{url}")
        try:
            urllib.request.urlretrieve(url, target)
            print(f"  已保存到 {target}")
        except Exception as exc:  # noqa: BLE001
            print(f"警告：下载失败（{exc}）")
            print(f"  请在有网络的环境下重新运行，或手动下载并放置到 {target}")


def build() -> None:
    ensure_vendor_assets()
    sep = os.pathsep
    # 只打包前端构建产物 frontend/dist，避免把 node_modules 等开发依赖打进 exe
    dist_dir = ROOT / "frontend" / "dist"
    if not (dist_dir / "index.html").is_file():
        raise SystemExit(
            f"[打包中止] 未找到 {dist_dir / 'index.html'}，请先构建前端再打包。"
        )
    cmd = [
        sys.executable, "-m", "PyInstaller",
        "--noconfirm", "--clean",
        "--onefile",
        "--noconsole",
        "--name", APP_NAME,
        # 让 PyInstaller 分析 backend 模块的导入依赖（sqlite3/qrcode/PIL 等）
        "--paths", str(ROOT / "backend"),
        f"--add-data={dist_dir}{sep}frontend/dist",
        f"--add-data={ROOT / 'backend'}{sep}backend",
        "--hidden-import", "uvicorn.logging",
        "--hidden-import", "uvicorn.loops.auto",
        "--hidden-import", "uvicorn.protocols.http.auto",
        "--hidden-import", "uvicorn.protocols.http.h11_impl",
        "--hidden-import", "uvicorn.protocols.websockets.auto",
        "--hidden-import", "uvicorn.protocols.websockets.wsproto_impl",
        "--hidden-import", "uvicorn.lifespan.on",
        "--hidden-import", "uvicorn.lifespan.off",
        str(ROOT / "backend" / "main.py"),
    ]
    subprocess.check_call(cmd, cwd=str(ROOT))
    exe_path = ROOT / "dist" / (APP_NAME + ".exe")
    print(f"\n打包完成：{exe_path}")
    print("运行 exe 后将自动打开本机浏览器访问 http://127.0.0.1:8000")
    print("服务默认绑定 0.0.0.0：同一 Wi-Fi 下的手机可访问控制台打印的局域网地址，")
    print("或打开设置页扫描二维码快速访问；数据库生成在 exe 同级目录 data/ 下。")


if __name__ == "__main__":
    build()
