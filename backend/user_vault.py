"""backend/user_vault.py

本地磁盘自动双写金库 (Local User Vault)
将浏览器端易失的持仓池 (pool)、成交流水 (logs)、尾盘持仓 (tailActives)、
每日净值快照 (snapshots)、风控铁律 (posRules) 与现金总账原子落盘至 data/user_vault.json，
并按自然日自动滚动留存近 15 天的历史备份快照 (data/vault_backups/vault_YYYY-MM-DD.json)。
"""

from __future__ import annotations

import datetime
import json
import os
import threading
import time
from typing import Any, Dict, List, Optional

_VAULT_LOCK = threading.Lock()
MAX_DAILY_BACKUPS = 15

# 默认示例自选池代码集合（用于识别全新未初始化的浏览器默认状态，防误覆盖真实磁盘记录）
DEFAULT_DEMO_CODES = {"605128", "002050", "002384", "300308"}


def _default_data_dir() -> str:
    backend_dir = os.path.dirname(os.path.abspath(__file__))
    project_root = os.path.dirname(backend_dir)
    return os.path.join(project_root, "data")


def _vault_paths(data_dir: Optional[str] = None) -> tuple[str, str]:
    base = data_dir or _default_data_dir()
    vault_file = os.path.join(base, "user_vault.json")
    backup_dir = os.path.join(base, "vault_backups")
    return vault_file, backup_dir


def _slim_stock_item(raw: Any) -> Optional[Dict[str, Any]]:
    if not isinstance(raw, dict):
        return None
    out: Dict[str, Any] = {}
    for k, v in raw.items():
        if isinstance(k, str) and not k.startswith("_"):
            out[k] = v
    return out


def _compute_vault_summary(vault: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    if not isinstance(vault, dict):
        return {
            "poolCount": 0,
            "holdingCount": 0,
            "logCount": 0,
            "tailCount": 0,
            "snapshotCount": 0,
            "availableCash": 0.0,
            "initialCapital": 0.0,
            "updatedAt": "",
            "updatedTs": 0,
            "isDefaultLike": True,
        }

    pool = vault.get("pool") if isinstance(vault.get("pool"), list) else []
    logs = vault.get("logs") if isinstance(vault.get("logs"), list) else []
    tail = vault.get("tailActives") if isinstance(vault.get("tailActives"), list) else []
    snaps = vault.get("snapshots") if isinstance(vault.get("snapshots"), list) else []

    holding_count = sum(1 for s in pool if isinstance(s, dict) and float(s.get("shares") or 0) > 0)
    pool_codes = {str(s.get("code") or "").zfill(6) for s in pool if isinstance(s, dict) and s.get("code")}
    is_default_like = (
        len(logs) == 0
        and len(tail) == 0
        and len(snaps) == 0
        and (len(pool_codes) == 0 or pool_codes.issubset(DEFAULT_DEMO_CODES))
    )

    return {
        "poolCount": len(pool),
        "holdingCount": holding_count,
        "logCount": len(logs),
        "tailCount": len(tail),
        "snapshotCount": len(snaps),
        "availableCash": round(float(vault.get("availableCash") or 0), 2),
        "initialCapital": round(float(vault.get("initialCapital") or 100000), 2),
        "updatedAt": str(vault.get("updatedAt") or ""),
        "updatedTs": int(vault.get("updatedTs") or 0),
        "isDefaultLike": is_default_like,
    }


def _atomic_write_json(path: str, payload: Dict[str, Any]) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp_path = f"{path}.{os.getpid()}.tmp"
    with open(tmp_path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    os.replace(tmp_path, path)


def _prune_old_backups(backup_dir: str, keep: int = MAX_DAILY_BACKUPS) -> List[str]:
    if not os.path.isdir(backup_dir):
        return []
    files = sorted(
        f for f in os.listdir(backup_dir) if f.startswith("vault_") and f.endswith(".json")
    )
    while len(files) > keep:
        oldest = files.pop(0)
        try:
            os.remove(os.path.join(backup_dir, oldest))
        except OSError:
            pass
    return list(reversed(files))


def load_user_vault(data_dir: Optional[str] = None) -> Dict[str, Any]:
    """读取本地磁盘金库数据与历史备份清单"""
    vault_file, backup_dir = _vault_paths(data_dir)
    with _VAULT_LOCK:
        backups: List[str] = []
        if os.path.isdir(backup_dir):
            backups = sorted(
                (f for f in os.listdir(backup_dir) if f.startswith("vault_") and f.endswith(".json")),
                reverse=True,
            )[:MAX_DAILY_BACKUPS]

        if not os.path.isfile(vault_file):
            return {
                "ok": True,
                "exists": False,
                "summary": _compute_vault_summary(None),
                "vault": None,
                "backups": backups,
            }

        try:
            with open(vault_file, "r", encoding="utf-8") as f:
                vault = json.load(f)
        except Exception as exc:
            return {
                "ok": False,
                "exists": True,
                "error": f"读取本地金库文件失败: {exc}",
                "summary": _compute_vault_summary(None),
                "vault": None,
                "backups": backups,
            }

        return {
            "ok": True,
            "exists": True,
            "summary": _compute_vault_summary(vault),
            "vault": vault,
            "backups": backups,
        }


def save_user_vault(
    payload: Dict[str, Any],
    force: bool = False,
    data_dir: Optional[str] = None,
) -> Dict[str, Any]:
    """原子双写用户金库至本地磁盘，并自动生成按日归档备份"""
    vault_file, backup_dir = _vault_paths(data_dir)

    raw_pool = payload.get("pool") if isinstance(payload.get("pool"), list) else []
    slim_pool = [item for item in (_slim_stock_item(x) for x in raw_pool) if item is not None]
    logs = payload.get("logs") if isinstance(payload.get("logs"), list) else []
    tail_actives = payload.get("tailActives") if isinstance(payload.get("tailActives"), list) else []
    snapshots = payload.get("snapshots") if isinstance(payload.get("snapshots"), list) else []
    eod_archives = payload.get("eodArchives") if isinstance(payload.get("eodArchives"), list) else []
    pos_rules = payload.get("posRules") if isinstance(payload.get("posRules"), dict) else {}

    initial_capital = max(0.0, round(float(payload.get("initialCapital") or 100000.0), 2))
    available_cash = max(0.0, round(float(payload.get("availableCash") or 0.0), 2))

    now_dt = datetime.datetime.now()
    now_str = now_dt.strftime("%Y-%m-%d %H:%M:%S")
    now_ts = int(time.time() * 1000)

    next_vault: Dict[str, Any] = {
        "version": 2,
        "updatedAt": now_str,
        "updatedTs": now_ts,
        "pool": slim_pool,
        "logs": logs,
        "tailActives": tail_actives,
        "snapshots": snapshots,
        "eodArchives": eod_archives[:30],
        "posRules": pos_rules,
        "initialCapital": initial_capital,
        "availableCash": available_cash,
    }
    next_summary = _compute_vault_summary(next_vault)

    with _VAULT_LOCK:
        if os.path.isfile(vault_file) and not force:
            try:
                with open(vault_file, "r", encoding="utf-8") as f:
                    existing = json.load(f)
                existing_summary = _compute_vault_summary(existing)
                # 防误清空保护：若磁盘已有实盘流水或非默认快照，而新请求处于空白/初始默认态，则拒绝静默覆盖
                if (
                    existing_summary["logCount"] > 0 or existing_summary["snapshotCount"] > 0
                ) and next_summary["isDefaultLike"]:
                    return {
                        "ok": False,
                        "guarded": True,
                        "reason": "检测到本地磁盘金库含有历史实盘台账/快照，已自动拦截空白浏览器状态的覆盖写入",
                        "existingSummary": existing_summary,
                        "vault": existing,
                    }
            except Exception:
                pass

        _atomic_write_json(vault_file, next_vault)

        today_tag = now_dt.strftime("%Y-%m-%d")
        daily_backup = os.path.join(backup_dir, f"vault_{today_tag}.json")
        _atomic_write_json(daily_backup, next_vault)
        backups = _prune_old_backups(backup_dir, keep=MAX_DAILY_BACKUPS)

    return {
        "ok": True,
        "guarded": False,
        "updatedAt": now_str,
        "updatedTs": now_ts,
        "summary": next_summary,
        "backups": backups,
    }
