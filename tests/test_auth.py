"""鉴权原语单测（散列 / 令牌 / 规范化）。

HTTP 登录流程、中间件门禁、账号 CRUD 的端到端测试在 P2 一并补上；这里只钉住
纯函数的性质：加盐、常数时间校验、损坏输入不抛、令牌高熵且哈希可复算。
"""

from __future__ import annotations

import pytest

from ontocopilot.auth import (
    hash_password,
    mint_token,
    normalize_username,
    token_hash,
    verify_password,
)


def test_hash_is_salted_and_verifies():
    h1 = hash_password("hunter2")
    h2 = hash_password("hunter2")
    assert h1 != h2                       # 每次不同盐 → 同口令不同散列
    assert h1.startswith("scrypt$")
    assert verify_password("hunter2", h1)
    assert verify_password("hunter2", h2)


def test_wrong_password_fails():
    h = hash_password("correct horse")
    assert not verify_password("Correct Horse", h)   # 大小写敏感
    assert not verify_password("", h)


def test_malformed_hash_is_false_not_error():
    assert not verify_password("x", "not-a-hash")
    assert not verify_password("x", "bcrypt$whatever")
    assert not verify_password("x", "scrypt$bad")


def test_empty_password_rejected():
    with pytest.raises(ValueError):
        hash_password("")


def test_normalize_username():
    assert normalize_username("  Alice ") == "alice"
    assert normalize_username("BOB@Example.com") == "bob@example.com"


def test_mint_token_hash_matches():
    tok, th = mint_token()
    assert token_hash(tok) == th
    assert len(th) == 64                  # sha256 十六进制
    tok2, th2 = mint_token()
    assert tok != tok2 and th != th2      # 高熵、不重复
