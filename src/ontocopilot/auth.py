"""鉴权原语 —— 口令散列、登录令牌、用户名规范化。

纪律沿用 :mod:`kernel.config`：**明文永不落库、永不进日志**。口令只存 scrypt
自描述散列，登录令牌只存 sha256（明文令牌只活在浏览器的 HttpOnly cookie 里）。

本模块只提供**纯函数**。``scrypt`` 是 CPU 密集（N=2^14 约 16 MB、几十毫秒），
直接在 async 路由里调会卡住整个事件循环、冻住所有 SSE 流；所以 P2 的中间件/
路由必须用 ``anyio.to_thread.run_sync`` 把 :func:`hash_password` /
:func:`verify_password` 丢进线程池，本模块不替调用方决定并发模型。
"""

from __future__ import annotations

import hashlib
import hmac
import secrets

# scrypt 参数。内存 ≈ 128·N·r ≈ 16 MB —— 对交互式登录足够硬，又不至于拖垮机器。
# 参数写进散列串本身，日后调参不影响旧散列的校验。
_SCRYPT_N = 2 ** 14
_SCRYPT_R = 8
_SCRYPT_P = 1
_SCRYPT_DKLEN = 32
# 给足 maxmem（默认上限在某些 OpenSSL 上会顶到 N=2^14 的边界而抛错）。
_SCRYPT_MAXMEM = 64 * 1024 * 1024


def normalize_username(username: str) -> str:
    """登录标识统一 ``strip().lower()`` —— 唯一约束与查找都基于规范化后的值。"""
    return username.strip().lower()


def hash_password(password: str) -> str:
    """返回自描述散列串 ``scrypt$N$r$p$salt_hex$hash_hex``。

    Raises:
        ValueError: 口令为空。空口令永远不该产生一个"看起来有效"的散列。
    """
    if not password:
        raise ValueError("口令不能为空")
    salt = secrets.token_bytes(16)
    dk = _scrypt(password, salt, _SCRYPT_N, _SCRYPT_R, _SCRYPT_P, _SCRYPT_DKLEN)
    return f"scrypt${_SCRYPT_N}${_SCRYPT_R}${_SCRYPT_P}${salt.hex()}${dk.hex()}"


def verify_password(password: str, encoded: str) -> bool:
    """常数时间比对。散列串损坏 / 方案不认识一律返回 ``False``，不抛。"""
    try:
        scheme, n, r, p, salt_hex, hash_hex = encoded.split("$")
        if scheme != "scrypt":
            return False
        salt = bytes.fromhex(salt_hex)
        expected = bytes.fromhex(hash_hex)
        dk = _scrypt(password, salt, int(n), int(r), int(p), len(expected))
    except (ValueError, TypeError):
        return False
    return hmac.compare_digest(dk, expected)


def _scrypt(password: str, salt: bytes, n: int, r: int, p: int, dklen: int) -> bytes:
    return hashlib.scrypt(password.encode("utf-8"), salt=salt, n=n, r=r, p=p,
                          dklen=dklen, maxmem=_SCRYPT_MAXMEM)


def mint_token() -> tuple[str, str]:
    """铸一个登录令牌。返回 ``(明文令牌, token_hash)``。

    明文进 cookie，只有 :func:`token_hash` 入库 —— 库泄了也换不出 cookie。
    """
    token = secrets.token_urlsafe(32)
    return token, token_hash(token)


def token_hash(token: str) -> str:
    """cookie 明文令牌 → 入库主键（sha256 十六进制）。"""
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


__all__ = ["normalize_username", "hash_password", "verify_password",
           "mint_token", "token_hash"]
