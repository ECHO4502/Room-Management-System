# -*- coding: utf-8 -*-
"""登录鉴权（预留）。

默认关闭： settings.auth_enabled=0 时所有 API 开放；
启用后（auth_enabled=1）除 /api/auth/* 外所有 /api 请求均需
登录（基于 HttpOnly Cookie 会话，无需客户端保存 token）。
第一次启用时（已启用但未设置账号）接口允许设置管理员账号与密码。
会话不自动过期，登出、修改密码或清除会话后才失效。
"""
import hashlib
import hmac
import secrets
import time

PBKDF2_ITER = 240_000
COOKIE_MAX_AGE = 10 * 365 * 86400  # 浏览器 Cookie 持久保留；服务端会话不自动过期，登出或修改密码后才失效
SESSION_COOKIE = "rms_session"
_LOGIN_WINDOW = 15 * 60
_LOGIN_MAX_FAIL = 8
_failures: dict[str, list[int]] = {}


def now() -> int:
    return int(time.time())


def is_enabled(conn) -> bool:
    row = conn.execute("SELECT value FROM settings WHERE key = 'auth_enabled'").fetchone()
    return bool(row and row["value"] == "1")


def get_username(conn) -> str:
    row = conn.execute("SELECT value FROM settings WHERE key = 'auth_username'").fetchone()
    return (row["value"] if row else "") or ""


def get_password_hash(conn) -> str:
    row = conn.execute("SELECT value FROM settings WHERE key = 'auth_password_hash'").fetchone()
    return (row["value"] if row else "") or ""


def has_account(conn) -> bool:
    return bool(get_username(conn))


def needs_setup(conn) -> bool:
    return is_enabled(conn) and not has_account(conn)


def validate_username(username: str) -> None:
    if not username or len(username) < 2 or len(username) > 32:
        raise ValueError("账号长度需为 2-32 位")
    for ch in username:
        if not (ch.isalnum() or ch in "_-"):
            raise ValueError("账号仅可包含字母、数字、下划线与中文")


def validate_password(password: str) -> None:
    if not password or len(password) < 8 or len(password) > 128:
        raise ValueError("密码长度需为 8-128 位")
    if not any(ch.isalpha() for ch in password) or not any(ch.isdigit() for ch in password):
        raise ValueError("密码需同时包含字母与数字")


def hash_password(password: str) -> str:
    salt = secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), bytes.fromhex(salt), PBKDF2_ITER)
    return "pbkdf2_sha256$%d$%s$%s" % (PBKDF2_ITER, salt, digest.hex())


def verify_password(password: str, stored: str) -> bool:
    try:
        _, iters, salt, digest = stored.split("$", 3)
        calc = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"),
                                   bytes.fromhex(salt), int(iters))
        return hmac.compare_digest(calc.hex(), digest)
    except Exception:
        return False


def _write_credentials(conn, username: str, password: str) -> None:
    conn.execute(
        "INSERT INTO settings (key, value, description) VALUES ('auth_username', ?, '')"
        " ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (username,),
    )
    conn.execute(
        "INSERT INTO settings (key, value, description) VALUES ('auth_password_hash', ?, '')"
        " ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (hash_password(password),),
    )


def setup_account(conn, username: str, password: str) -> None:
    validate_username(username)
    validate_password(password)
    _write_credentials(conn, username, password)
    conn.commit()


def setup_initial_account(conn, username: str, password: str) -> None:
    """首次启用设置账号：排他事务内确认未设置，防止并发覆盖。"""
    conn.execute("BEGIN EXCLUSIVE")
    try:
        if get_username(conn):
            raise ValueError("账号已设置，请直接登录")
        validate_username(username)
        validate_password(password)
        _write_credentials(conn, username, password)
        conn.commit()
    except Exception:
        try:
            conn.rollback()
        except Exception:
            pass
        raise


def clear_sessions(conn) -> None:
    conn.execute("DELETE FROM auth_sessions")
    conn.commit()


def _token_digest(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def create_session(conn) -> str:
    token = secrets.token_urlsafe(32)
    conn.execute(
        "INSERT INTO auth_sessions (token_hash, created_at, expires_at) VALUES (?, ?, ?)",
        (_token_digest(token), now(), now() + COOKIE_MAX_AGE),
    )
    conn.commit()
    return token


def session_valid(conn, token: str | None) -> bool:
    if not token:
        return False
    # 会话不设过期：只要未登出/未改密/未清除即持续有效
    row = conn.execute(
        "SELECT id FROM auth_sessions WHERE token_hash = ?",
        (_token_digest(token),),
    ).fetchone()
    if row:
        conn.execute("UPDATE auth_sessions SET last_used_at = ? WHERE id = ?", (now(), row["id"]))
        conn.commit()
    return bool(row)


def revoke_session(conn, token: str | None) -> None:
    if not token:
        return
    conn.execute("DELETE FROM auth_sessions WHERE token_hash = ?", (_token_digest(token),))
    conn.commit()


def _prune(ip: str) -> None:
    ts = now()
    _failures[ip] = [x for x in _failures.get(ip, []) if x > ts - _LOGIN_WINDOW]
    if not _failures[ip]:
        _failures.pop(ip, None)


def login_blocked(ip: str) -> int:
    _prune(ip)
    if len(_failures.get(ip, [])) >= _LOGIN_MAX_FAIL:
        oldest = min(_failures[ip])
        return max(1, oldest + _LOGIN_WINDOW - now())
    return 0


def record_failure(ip: str) -> None:
    _prune(ip)
    _failures.setdefault(ip, []).append(now())


def reset_failures(ip: str) -> None:
    _failures.pop(ip, None)
