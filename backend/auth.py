"""backend/auth.py

零外部依赖轻量多账号鉴权、SCRAM 挑战签名防明文传输与邀请码管理引擎
- 密码安全：采用类 SCRAM-SHA-256 协议（2048 轮加盐迭代 + 单次随机 Nonce 挑战异或证明），
  即使线上走 80 端口 HTTP，网络上也绝不传输明文密码或可重放凭据；磁盘仅存单向 storedKey。
- 会话签发：基于 HMAC-SHA256 签发 30 天长效令牌（内嵌 tokenVersion，改密/重置即刻吊销旧令牌）。
- 账号体系：首个初始化账号自动成为主理人 (owner) 并无缝接管原有 user_vault.json；
  后续成员必须凭有效邀请码注册，各自享有物理隔离的独立持仓与台账金库。
"""

from __future__ import annotations

import base64
import datetime
import hashlib
import hmac
import json
import os
import re
import secrets
import threading
import time
from typing import Any, Dict, List, Optional, Tuple

from backend.user_vault import (
    archive_deleted_user_vault,
    get_legacy_vault_info,
    initialize_fresh_user_vault,
    load_user_vault,
    migrate_legacy_vault_to_user,
)

_AUTH_LOCK = threading.Lock()

SCRAM_ROUNDS = 2048
NONCE_TTL_SECONDS = 90
SESSION_TTL_SECONDS = 30 * 86400  # 30 天手机/桌面免重复输入登录
COOKIE_NAME = "tstock_session"

USERNAME_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{1,23}$")
HEX64_RE = re.compile(r"^[0-9a-f]{64}$")
HEX32_RE = re.compile(r"^[0-9a-f]{32}$")

# 内存态一次性登录挑战池与防暴力破解窗口
_NONCE_STORE: Dict[str, Tuple[str, float]] = {}
_FAIL_TRACKER: Dict[str, List[float]] = {}
MAX_FAILS_WINDOW = 8
FAIL_WINDOW_SECONDS = 300
LOCKOUT_SECONDS = 60


def _default_data_dir() -> str:
    backend_dir = os.path.dirname(os.path.abspath(__file__))
    project_root = os.path.dirname(backend_dir)
    return os.path.join(project_root, "data")


def _auth_paths(data_dir: Optional[str] = None) -> Tuple[str, str]:
    base = data_dir or _default_data_dir()
    return (
        os.path.join(base, "auth_users.json"),
        os.path.join(base, "auth_secret.key"),
    )


def _now_str() -> str:
    return datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def normalize_username(username: str) -> str:
    u = str(username or "").strip().lower()
    if not USERNAME_RE.match(u):
        raise ValueError("账号名需为 2~24 位字母、数字、下划线或短横线，且以字母或数字开头")
    return u


def _atomic_write_json(path: str, payload: Dict[str, Any]) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = f"{path}.{os.getpid()}.{int(time.time() * 1000)}.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    os.replace(tmp, path)


def _get_or_create_secret(data_dir: Optional[str] = None) -> bytes:
    env_sec = os.getenv("TSTOCK_AUTH_SECRET", "").strip()
    if len(env_sec) >= 24:
        return env_sec.encode("utf-8")

    _, secret_path = _auth_paths(data_dir)
    os.makedirs(os.path.dirname(secret_path), exist_ok=True)
    if os.path.isfile(secret_path):
        with open(secret_path, "rb") as f:
            raw = f.read().strip()
            if len(raw) >= 32:
                return raw

    fresh = secrets.token_hex(32).encode("ascii")
    with open(secret_path, "wb") as f:
        f.write(fresh)
    try:
        os.chmod(secret_path, 0o600)
    except OSError:
        pass
    return fresh


def _load_db_unlocked(data_dir: Optional[str] = None) -> Dict[str, Any]:
    users_path, _ = _auth_paths(data_dir)
    if not os.path.isfile(users_path):
        return {"version": 1, "users": {}, "invites": []}
    try:
        with open(users_path, "r", encoding="utf-8") as f:
            data = json.load(f)
        if not isinstance(data, dict):
            return {"version": 1, "users": {}, "invites": []}
        data.setdefault("version", 1)
        if not isinstance(data.get("users"), dict):
            data["users"] = {}
        if not isinstance(data.get("invites"), list):
            data["invites"] = []
        return data
    except Exception:
        return {"version": 1, "users": {}, "invites": []}


def _save_db_unlocked(db: Dict[str, Any], data_dir: Optional[str] = None) -> None:
    users_path, _ = _auth_paths(data_dir)
    _atomic_write_json(users_path, db)


# ==================== SCRAM-SHA-256 兼容派生与校验 ====================

def derive_scram_credentials(
    username: str,
    password: str,
    salt_hex: Optional[str] = None,
    rounds: int = SCRAM_ROUNDS,
) -> Tuple[str, str, str]:
    """根据 (username, password, salt_hex) 计算 (salt_hex, client_key_hex, stored_key_hex)。
    与前端纯 JS 实现 (src/services/authCrypto.js) 逐字节严格一致。
    """
    u = normalize_username(username)
    if len(password or "") < 6:
        raise ValueError("密码长度至少需要 6 位")
    s_hex = (salt_hex or secrets.token_hex(16)).strip().lower()
    if not HEX32_RE.match(s_hex):
        raise ValueError("盐值格式不合法（需 32 位十六进制字符）")

    salt_bytes = bytes.fromhex(s_hex)
    seed = (
        b"tstock-scram-v1:"
        + u.encode("utf-8")
        + b":"
        + s_hex.encode("ascii")
        + b":"
        + password.encode("utf-8")
    )
    digest = hashlib.sha256(seed).digest()
    for _ in range(max(1, rounds) - 1):
        digest = hashlib.sha256(digest + salt_bytes).digest()

    client_key = hmac.new(digest, b"tstock-client-key", hashlib.sha256).digest()
    stored_key_hex = hashlib.sha256(client_key).hexdigest()
    return s_hex, client_key.hex(), stored_key_hex


def compute_scram_proof(client_key_hex: str, stored_key_hex: str, nonce: str) -> str:
    """客户端侧证明生成函数（供单元测试与服务端自检调用）"""
    ck = bytes.fromhex(client_key_hex)
    sk = bytes.fromhex(stored_key_hex)
    sig = hmac.new(sk, nonce.encode("ascii"), hashlib.sha256).digest()
    proof = bytes(a ^ b for a, b in zip(ck, sig))
    return proof.hex()


def verify_scram_proof(stored_key_hex: str, nonce: str, client_proof_hex: str) -> bool:
    """服务端单向校验：无需保存明文或 clientKey，仅凭 storedKey 与一次性 nonce 验证客户端身份"""
    c_hex = str(client_proof_hex or "").strip().lower()
    if not HEX64_RE.match(c_hex) or not HEX64_RE.match(stored_key_hex):
        return False
    sk = bytes.fromhex(stored_key_hex)
    proof = bytes.fromhex(c_hex)
    sig = hmac.new(sk, nonce.encode("ascii"), hashlib.sha256).digest()
    candidate_client_key = bytes(a ^ b for a, b in zip(proof, sig))
    candidate_stored_hex = hashlib.sha256(candidate_client_key).hexdigest()
    return hmac.compare_digest(candidate_stored_hex, stored_key_hex)


# ==================== 会话令牌签发与验证 ====================

def _b64u_encode(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _b64u_decode(txt: str) -> bytes:
    pad = "=" * ((4 - len(txt) % 4) % 4)
    return base64.urlsafe_b64decode((txt + pad).encode("ascii"))


def issue_session_token(
    user: Dict[str, Any],
    data_dir: Optional[str] = None,
    ttl_seconds: int = SESSION_TTL_SECONDS,
) -> str:
    secret = _get_or_create_secret(data_dir)
    payload = {
        "u": user["username"],
        "r": user.get("role") or "member",
        "v": int(user.get("tokenVersion") or 1),
        "exp": int(time.time()) + ttl_seconds,
    }
    body_b64 = _b64u_encode(json.dumps(payload, separators=(",", ":")).encode("utf-8"))
    sig = hmac.new(secret, body_b64.encode("ascii"), hashlib.sha256).digest()
    return f"{body_b64}.{_b64u_encode(sig)}"


def verify_session_token(
    token: Optional[str],
    data_dir: Optional[str] = None,
) -> Optional[Dict[str, Any]]:
    if not token or "." not in token:
        return None
    parts = token.strip().split(".")
    if len(parts) != 2:
        return None
    body_b64, sig_b64 = parts
    secret = _get_or_create_secret(data_dir)
    expected_sig = _b64u_encode(
        hmac.new(secret, body_b64.encode("ascii"), hashlib.sha256).digest()
    )
    if not hmac.compare_digest(sig_b64, expected_sig):
        return None

    try:
        payload = json.loads(_b64u_decode(body_b64).decode("utf-8"))
    except Exception:
        return None

    if int(payload.get("exp") or 0) < int(time.time()):
        return None

    username = str(payload.get("u") or "").strip().lower()
    if not username:
        return None

    with _AUTH_LOCK:
        db = _load_db_unlocked(data_dir)
        user = db["users"].get(username)
        if not user or user.get("disabled"):
            return None
        if int(user.get("tokenVersion") or 1) != int(payload.get("v") or 0):
            return None
        return _public_user(user)


def _public_user(user: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "username": user["username"],
        "displayName": user.get("displayName") or user["username"],
        "role": user.get("role") or "member",
        "createdAt": user.get("createdAt") or "",
        "lastLoginAt": user.get("lastLoginAt") or "",
    }


# ==================== 防爆破限速与一次性挑战签发 ====================

def _check_rate_limit_unlocked(client_ip: str) -> None:
    now = time.time()
    key = client_ip or "unknown"
    history = [ts for ts in _FAIL_TRACKER.get(key, []) if now - ts < FAIL_WINDOW_SECONDS]
    _FAIL_TRACKER[key] = history
    if len(history) >= MAX_FAILS_WINDOW:
        elapsed = now - history[-1]
        if elapsed < LOCKOUT_SECONDS:
            wait_sec = max(1, int(LOCKOUT_SECONDS - elapsed))
            raise PermissionError(f"登录尝试过于频繁，请等待 {wait_sec} 秒后再试")


def _record_failure_unlocked(client_ip: str) -> None:
    key = client_ip or "unknown"
    now = time.time()
    history = [ts for ts in _FAIL_TRACKER.get(key, []) if now - ts < FAIL_WINDOW_SECONDS]
    history.append(now)
    _FAIL_TRACKER[key] = history


def _clear_failures_unlocked(client_ip: str) -> None:
    _FAIL_TRACKER.pop(client_ip or "unknown", None)


def is_setup_needed(data_dir: Optional[str] = None) -> bool:
    with _AUTH_LOCK:
        db = _load_db_unlocked(data_dir)
        return len(db["users"]) == 0


def get_auth_status(
    token: Optional[str] = None,
    data_dir: Optional[str] = None,
) -> Dict[str, Any]:
    needs_setup = is_setup_needed(data_dir)
    user = None if needs_setup else verify_session_token(token, data_dir=data_dir)
    legacy = get_legacy_vault_info(data_dir=data_dir) if needs_setup else {"exists": False, "summary": None}
    return {
        "ok": True,
        "authenticated": user is not None,
        "needsSetup": needs_setup,
        "user": user,
        "hasLegacyVault": bool(legacy.get("exists")),
        "legacySummary": legacy.get("summary"),
        "rounds": SCRAM_ROUNDS,
    }


def create_login_challenge(
    username: str,
    data_dir: Optional[str] = None,
) -> Dict[str, Any]:
    u = normalize_username(username)
    secret = _get_or_create_secret(data_dir)
    now = time.time()

    with _AUTH_LOCK:
        # 清理过期挑战
        expired = [k for k, (_, exp) in _NONCE_STORE.items() if exp < now]
        for k in expired:
            _NONCE_STORE.pop(k, None)
        if len(_NONCE_STORE) > 1024:
            _NONCE_STORE.pop(next(iter(_NONCE_STORE)))

        db = _load_db_unlocked(data_dir)
        user = db["users"].get(u)
        if user and HEX32_RE.match(str(user.get("salt") or "")):
            salt_hex = str(user["salt"]).lower()
        else:
            # 对不存在的账号返回确定性伪盐，防止通过挑战接口枚举账号是否存在
            salt_hex = hmac.new(secret, f"dummy-salt:{u}".encode("utf-8"), hashlib.sha256).hexdigest()[:32]

        nonce = secrets.token_hex(24)
        _NONCE_STORE[nonce] = (u, now + NONCE_TTL_SECONDS)

    return {
        "ok": True,
        "username": u,
        "salt": salt_hex,
        "nonce": nonce,
        "rounds": SCRAM_ROUNDS,
    }


# ==================== 主账号初始化、邀请码注册与登录 ====================

def _generate_invite_code() -> str:
    alphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"
    p1 = "".join(secrets.choice(alphabet) for _ in range(4))
    p2 = "".join(secrets.choice(alphabet) for _ in range(4))
    return f"TS-{p1}-{p2}"


def _prepare_stored_credentials(
    username: str,
    salt: Optional[str] = None,
    stored_key: Optional[str] = None,
    password: Optional[str] = None,
) -> Tuple[str, str]:
    s_hex = str(salt or "").strip().lower()
    sk_hex = str(stored_key or "").strip().lower()
    if s_hex and sk_hex:
        if not HEX32_RE.match(s_hex):
            raise ValueError("盐值格式无效")
        if not HEX64_RE.match(sk_hex):
            raise ValueError("密钥摘要格式无效")
        return s_hex, sk_hex
    if password:
        s_out, _, sk_out = derive_scram_credentials(username=username, password=password)
        return s_out, sk_out
    raise ValueError("缺少有效的密码凭证参数")


def setup_initial_owner(
    username: str,
    display_name: str = "",
    salt: Optional[str] = None,
    stored_key: Optional[str] = None,
    password: Optional[str] = None,
    data_dir: Optional[str] = None,
) -> Dict[str, Any]:
    """初始化首任主理人账号，并自动将原有 data/user_vault.json 迁移至该主账号名下"""
    u = normalize_username(username)
    s_hex, sk_hex = _prepare_stored_credentials(u, salt=salt, stored_key=stored_key, password=password)
    disp = str(display_name or "").strip()[:24] or u
    now_s = _now_str()

    with _AUTH_LOCK:
        db = _load_db_unlocked(data_dir)
        if len(db["users"]) > 0:
            raise ValueError("系统已完成主理人初始化，请直接登录或使用邀请码注册")

        owner_rec = {
            "username": u,
            "displayName": disp,
            "role": "owner",
            "salt": s_hex,
            "storedKey": sk_hex,
            "tokenVersion": 1,
            "createdAt": now_s,
            "lastLoginAt": now_s,
        }
        default_invite = {
            "code": _generate_invite_code(),
            "note": "默认好友邀请码",
            "maxUses": 5,
            "usedCount": 0,
            "usedBy": [],
            "createdAt": now_s,
            "revoked": False,
        }
        db["users"][u] = owner_rec
        db["invites"].append(default_invite)
        _save_db_unlocked(db, data_dir)

    migration = migrate_legacy_vault_to_user(username=u, data_dir=data_dir)
    token = issue_session_token(owner_rec, data_dir=data_dir)
    return {
        "ok": True,
        "token": token,
        "user": _public_user(owner_rec),
        "migratedVault": migration,
        "defaultInviteCode": default_invite["code"],
    }


def register_with_invite(
    username: str,
    invite_code: str,
    display_name: str = "",
    salt: Optional[str] = None,
    stored_key: Optional[str] = None,
    password: Optional[str] = None,
    client_ip: str = "",
    data_dir: Optional[str] = None,
) -> Dict[str, Any]:
    """凭有效邀请码注册独立子账号，并自动创建干净隔离的专属金库"""
    u = normalize_username(username)
    code_norm = str(invite_code or "").strip().upper()
    if not code_norm:
        raise ValueError("请输入邀请码")

    s_hex, sk_hex = _prepare_stored_credentials(u, salt=salt, stored_key=stored_key, password=password)
    disp = str(display_name or "").strip()[:24] or u
    now_s = _now_str()
    env_master_invite = os.getenv("TSTOCK_INVITE_CODE", "").strip().upper()

    with _AUTH_LOCK:
        _check_rate_limit_unlocked(client_ip)
        db = _load_db_unlocked(data_dir)
        if len(db["users"]) == 0:
            raise ValueError("系统尚未创建主理人账号，请先完成主账号初始化")
        if u in db["users"]:
            raise ValueError(f"账号名「{u}」已被占用，请换一个名称")

        matched_invite = None
        for inv in db["invites"]:
            if not inv.get("revoked") and str(inv.get("code") or "").upper() == code_norm:
                max_u = int(inv.get("maxUses") or 0)
                used_u = int(inv.get("usedCount") or 0)
                if max_u == 0 or used_u < max_u:
                    matched_invite = inv
                    break

        env_matched = bool(env_master_invite and hmac.compare_digest(code_norm, env_master_invite))
        if not matched_invite and not env_matched:
            _record_failure_unlocked(client_ip)
            raise PermissionError("邀请码无效、已过期或已达使用次数上限")

        if matched_invite is not None:
            matched_invite["usedCount"] = int(matched_invite.get("usedCount") or 0) + 1
            used_by = matched_invite.get("usedBy") if isinstance(matched_invite.get("usedBy"), list) else []
            used_by.append({"username": u, "at": now_s})
            matched_invite["usedBy"] = used_by

        user_rec = {
            "username": u,
            "displayName": disp,
            "role": "member",
            "salt": s_hex,
            "storedKey": sk_hex,
            "invitedByCode": code_norm,
            "tokenVersion": 1,
            "createdAt": now_s,
            "lastLoginAt": now_s,
        }
        db["users"][u] = user_rec
        _save_db_unlocked(db, data_dir)
        _clear_failures_unlocked(client_ip)

    vault_summary = initialize_fresh_user_vault(username=u, initial_capital=100000.0, data_dir=data_dir)
    token = issue_session_token(user_rec, data_dir=data_dir)
    return {
        "ok": True,
        "token": token,
        "user": _public_user(user_rec),
        "vaultSummary": vault_summary,
    }


def login_with_challenge(
    username: str,
    nonce: str,
    client_proof: str,
    client_ip: str = "",
    data_dir: Optional[str] = None,
) -> Dict[str, Any]:
    u = normalize_username(username)
    nonce_clean = str(nonce or "").strip()

    with _AUTH_LOCK:
        _check_rate_limit_unlocked(client_ip)

        entry = _NONCE_STORE.pop(nonce_clean, None)
        if not entry:
            _record_failure_unlocked(client_ip)
            raise PermissionError("登录挑战已过期或已失效，请重试")
        nonce_user, exp_ts = entry
        if nonce_user != u or time.time() > exp_ts:
            _record_failure_unlocked(client_ip)
            raise PermissionError("登录挑战已超时，请重新点击登录")

        db = _load_db_unlocked(data_dir)
        user = db["users"].get(u)
        if not user or user.get("disabled"):
            _record_failure_unlocked(client_ip)
            raise PermissionError("账号或密码不正确")

        if not verify_scram_proof(
            stored_key_hex=str(user.get("storedKey") or ""),
            nonce=nonce_clean,
            client_proof_hex=client_proof,
        ):
            _record_failure_unlocked(client_ip)
            raise PermissionError("账号或密码不正确")

        _clear_failures_unlocked(client_ip)
        user["lastLoginAt"] = _now_str()
        _save_db_unlocked(db, data_dir)
        pub = _public_user(user)
        tok = issue_session_token(user, data_dir=data_dir)

    return {
        "ok": True,
        "token": tok,
        "user": pub,
    }


def change_user_password(
    username: str,
    nonce: str,
    current_proof: str,
    new_salt: Optional[str] = None,
    new_stored_key: Optional[str] = None,
    new_password: Optional[str] = None,
    data_dir: Optional[str] = None,
) -> Dict[str, Any]:
    u = normalize_username(username)
    s_hex, sk_hex = _prepare_stored_credentials(
        u, salt=new_salt, stored_key=new_stored_key, password=new_password
    )

    with _AUTH_LOCK:
        entry = _NONCE_STORE.pop(str(nonce or "").strip(), None)
        if not entry or entry[0] != u or time.time() > entry[1]:
            raise PermissionError("安全验证挑战已过期，请重试")

        db = _load_db_unlocked(data_dir)
        user = db["users"].get(u)
        if not user:
            raise ValueError("账号不存在")

        if not verify_scram_proof(str(user.get("storedKey") or ""), str(nonce).strip(), current_proof):
            raise PermissionError("当前密码不正确")

        user["salt"] = s_hex
        user["storedKey"] = sk_hex
        user["tokenVersion"] = int(user.get("tokenVersion") or 1) + 1
        user["passwordUpdatedAt"] = _now_str()
        _save_db_unlocked(db, data_dir)
        tok = issue_session_token(user, data_dir=data_dir)
        pub = _public_user(user)

    return {"ok": True, "token": tok, "user": pub}


# ==================== 主理人专属：邀请码与成员管理 ====================

def list_invites(data_dir: Optional[str] = None) -> List[Dict[str, Any]]:
    with _AUTH_LOCK:
        db = _load_db_unlocked(data_dir)
        return list(reversed(db["invites"]))


def mutate_invite(
    action: str,
    code: str = "",
    note: str = "",
    max_uses: int = 5,
    data_dir: Optional[str] = None,
) -> Dict[str, Any]:
    act = str(action or "").strip().lower()
    with _AUTH_LOCK:
        db = _load_db_unlocked(data_dir)
        if act == "create":
            new_inv = {
                "code": _generate_invite_code(),
                "note": str(note or "好友邀请码").strip()[:32],
                "maxUses": max(0, min(1000, int(max_uses))),
                "usedCount": 0,
                "usedBy": [],
                "createdAt": _now_str(),
                "revoked": False,
            }
            db["invites"].append(new_inv)
            _save_db_unlocked(db, data_dir)
            return {"ok": True, "invite": new_inv, "invites": list(reversed(db["invites"]))}

        target = str(code or "").strip().upper()
        if act == "revoke":
            for inv in db["invites"]:
                if str(inv.get("code") or "").upper() == target:
                    inv["revoked"] = True
            _save_db_unlocked(db, data_dir)
            return {"ok": True, "invites": list(reversed(db["invites"]))}

        if act == "delete":
            db["invites"] = [
                inv for inv in db["invites"] if str(inv.get("code") or "").upper() != target
            ]
            _save_db_unlocked(db, data_dir)
            return {"ok": True, "invites": list(reversed(db["invites"]))}

        raise ValueError(f"不支持的邀请码操作: {act}")


def list_users_with_vault_stats(data_dir: Optional[str] = None) -> List[Dict[str, Any]]:
    with _AUTH_LOCK:
        db = _load_db_unlocked(data_dir)
        users = list(db["users"].values())

    out: List[Dict[str, Any]] = []
    for u in users:
        uname = u["username"]
        v_info = load_user_vault(data_dir=data_dir, username=uname)
        s = v_info.get("summary") or {}
        out.append({
            **_public_user(u),
            "holdingCount": s.get("holdingCount", 0),
            "poolCount": s.get("poolCount", 0),
            "logCount": s.get("logCount", 0),
            "vaultUpdatedAt": s.get("updatedAt") or "",
        })
    return out


def owner_mutate_user(
    owner_username: str,
    action: str,
    target_username: str,
    new_salt: Optional[str] = None,
    new_stored_key: Optional[str] = None,
    new_password: Optional[str] = None,
    data_dir: Optional[str] = None,
) -> Dict[str, Any]:
    act = str(action or "").strip().lower()
    target = normalize_username(target_username)

    with _AUTH_LOCK:
        db = _load_db_unlocked(data_dir)
        user = db["users"].get(target)
        if not user:
            raise ValueError(f"未找到账号「{target}」")

        if act == "reset_password":
            s_hex, sk_hex = _prepare_stored_credentials(
                target, salt=new_salt, stored_key=new_stored_key, password=new_password
            )
            user["salt"] = s_hex
            user["storedKey"] = sk_hex
            user["tokenVersion"] = int(user.get("tokenVersion") or 1) + 1
            user["passwordUpdatedAt"] = _now_str()
            _save_db_unlocked(db, data_dir)
            return {"ok": True, "message": f"已重置账号 {target} 的密码并吊销旧会话"}

        if act == "delete":
            if target == owner_username or user.get("role") == "owner":
                raise ValueError("不能删除主理人主账号")
            db["users"].pop(target, None)
            _save_db_unlocked(db, data_dir)

    if act == "delete":
        archive_deleted_user_vault(username=target, data_dir=data_dir)
        return {"ok": True, "message": f"已移除账号 {target}（其历史金库已归档留底）"}

    raise ValueError(f"不支持的成员管理操作: {act}")
