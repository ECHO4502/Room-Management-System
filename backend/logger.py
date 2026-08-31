# -*- coding: utf-8 -*-
"""日志系统：同时输出到控制台与 logs/app.log（10MB 滚动）。"""

import logging
import os
import sys
from logging.handlers import RotatingFileHandler
from pathlib import Path


def get_log_dir() -> Path:
    """日志目录：开发模式为项目根目录 logs/，打包后为 exe 同级 logs/。"""
    if getattr(sys, "frozen", False):
        base = Path(sys.executable).resolve().parent
    else:
        base = Path(__file__).resolve().parent.parent
    return base / "logs"


def setup(log_dir: str | Path | None = None) -> logging.Logger:
    """初始化根日志：控制台 + 文件（10MB 滚动，保留 3 份）。"""
    # 无控制台模式（打包 --noconsole）下 stdout/stderr 为 None，改写为丢弃输出
    if sys.stdout is None:
        sys.stdout = open(os.devnull, "w", encoding="utf-8")
    if sys.stderr is None:
        sys.stderr = open(os.devnull, "w", encoding="utf-8")
    if log_dir is None:
        log_dir = get_log_dir()
    log_dir = Path(log_dir)
    log_dir.mkdir(parents=True, exist_ok=True)

    root = logging.getLogger()
    if root.handlers:
        return root

    fmt = logging.Formatter(
        "%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )

    console = logging.StreamHandler()
    console.setFormatter(fmt)
    root.addHandler(console)

    file_handler = RotatingFileHandler(
        str(log_dir / "app.log"),
        maxBytes=10 * 1024 * 1024,
        backupCount=3,
        encoding="utf-8",
    )
    file_handler.setFormatter(fmt)
    root.addHandler(file_handler)

    root.setLevel(logging.INFO)
    logging.getLogger("uvicorn").setLevel(logging.INFO)
    return root
