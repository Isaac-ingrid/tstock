from __future__ import annotations

import os
import tempfile
import unittest

from backend.auth import (
    change_user_password,
    compute_scram_proof,
    create_login_challenge,
    derive_scram_credentials,
    get_auth_status,
    list_invites,
    list_users_with_vault_stats,
    login_with_challenge,
    mutate_invite,
    owner_mutate_user,
    register_with_invite,
    setup_initial_owner,
    verify_session_token,
)
from backend.user_vault import load_user_vault, save_user_vault


class TestAuthAndMultiVault(unittest.TestCase):
    def test_legacy_migration_invite_registration_scram_login_and_vault_isolation(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            # 1. 先模拟旧版单机时代在根目录已有一份实盘 user_vault.json 与备份
            legacy_save = save_user_vault(
                payload={
                    "pool": [{"code": "605128", "name": "上海沿浦", "shares": 2000, "cost": 31.2}],
                    "logs": [
                        {
                            "id": 9001,
                            "date": "2026-11-18",
                            "stock": "上海沿浦 (605128)",
                            "dir": "正T",
                            "buy": 30.8,
                            "sell": 31.6,
                            "qty": 500,
                            "net": 382.0,
                        }
                    ],
                    "snapshots": [{"date": "2026-11-18", "total": 148000}],
                    "initialCapital": 150000,
                    "availableCash": 85600,
                },
                data_dir=tmpdir,
            )
            self.assertTrue(legacy_save["ok"])
            self.assertTrue(os.path.isfile(os.path.join(tmpdir, "user_vault.json")))

            # 2. 初始状态应提示 needsSetup=True 且检测到旧版金库摘要
            st0 = get_auth_status(token=None, data_dir=tmpdir)
            self.assertTrue(st0["needsSetup"])
            self.assertFalse(st0["authenticated"])
            self.assertTrue(st0["hasLegacyVault"])
            self.assertEqual(st0["legacySummary"]["holdingCount"], 1)
            self.assertEqual(st0["legacySummary"]["logCount"], 1)

            # 3. 客户端侧派生 SCRAM 凭证并初始化主理人账号 isaac，自动接管旧金库
            salt_owner, ck_owner, sk_owner = derive_scram_credentials("isaac", "OwnerPass#2026")
            setup_res = setup_initial_owner(
                username="isaac",
                display_name="Isaac",
                salt=salt_owner,
                stored_key=sk_owner,
                data_dir=tmpdir,
            )
            self.assertTrue(setup_res["ok"])
            self.assertEqual(setup_res["user"]["role"], "owner")
            self.assertTrue(setup_res["migratedVault"]["migrated"])
            invite_code = setup_res["defaultInviteCode"]
            self.assertTrue(invite_code.startswith("TS-"))

            # 原根目录 user_vault.json 已归档为 .migrated.bak，并生成 data/vaults/isaac.json
            self.assertFalse(os.path.isfile(os.path.join(tmpdir, "user_vault.json")))
            self.assertTrue(os.path.isfile(os.path.join(tmpdir, "user_vault.json.migrated.bak")))
            owner_vault = load_user_vault(data_dir=tmpdir, username="isaac")
            self.assertTrue(owner_vault["exists"])
            self.assertEqual(owner_vault["vault"]["availableCash"], 85600.0)
            self.assertEqual(owner_vault["summary"]["logCount"], 1)
            self.assertGreaterEqual(len(owner_vault["backups"]), 1)

            # 再次调用 setup_initial_owner 应被拒绝
            with self.assertRaises(ValueError):
                setup_initial_owner(username="hacker", password="Password123", data_dir=tmpdir)

            # 4. 错误邀请码无法注册；正确邀请码成功注册好友账号 alice，且金库完全物理隔离
            salt_alice, ck_alice, sk_alice = derive_scram_credentials("alice", "AliceSecret88")
            with self.assertRaises(PermissionError):
                register_with_invite(
                    username="alice",
                    invite_code="TS-WRONG-CODE",
                    salt=salt_alice,
                    stored_key=sk_alice,
                    client_ip="10.0.0.2",
                    data_dir=tmpdir,
                )

            reg_alice = register_with_invite(
                username="alice",
                display_name="Alice",
                invite_code=invite_code,
                salt=salt_alice,
                stored_key=sk_alice,
                client_ip="10.0.0.2",
                data_dir=tmpdir,
            )
            self.assertTrue(reg_alice["ok"])
            self.assertEqual(reg_alice["user"]["role"], "member")

            alice_vault = load_user_vault(data_dir=tmpdir, username="alice")
            self.assertTrue(alice_vault["exists"])
            self.assertEqual(alice_vault["summary"]["holdingCount"], 0)
            self.assertEqual(alice_vault["summary"]["logCount"], 0)
            self.assertEqual(alice_vault["vault"]["availableCash"], 100000.0)

            # Alice 写入自己的持仓，绝不影响 Isaac 的金库
            save_user_vault(
                payload={
                    "pool": [{"code": "300308", "name": "中际旭创", "shares": 400, "cost": 120.0}],
                    "logs": [],
                    "initialCapital": 100000,
                    "availableCash": 52000,
                },
                data_dir=tmpdir,
                username="alice",
            )
            self.assertEqual(load_user_vault(data_dir=tmpdir, username="alice")["vault"]["availableCash"], 52000.0)
            self.assertEqual(load_user_vault(data_dir=tmpdir, username="isaac")["vault"]["availableCash"], 85600.0)

            # 5. 测试 SCRAM 单次挑战登录与防重放攻击
            chal = create_login_challenge("isaac", data_dir=tmpdir)
            self.assertEqual(chal["salt"], salt_owner)
            proof = compute_scram_proof(ck_owner, sk_owner, chal["nonce"])

            login_ok = login_with_challenge(
                username="isaac",
                nonce=chal["nonce"],
                client_proof=proof,
                client_ip="10.0.0.1",
                data_dir=tmpdir,
            )
            self.assertTrue(login_ok["ok"])
            verified = verify_session_token(login_ok["token"], data_dir=tmpdir)
            self.assertIsNotNone(verified)
            self.assertEqual(verified["username"], "isaac")

            # 抓包重放完全相同的 nonce + proof 必须立即失败
            with self.assertRaises(PermissionError):
                login_with_challenge(
                    username="isaac",
                    nonce=chal["nonce"],
                    client_proof=proof,
                    client_ip="10.0.0.1",
                    data_dir=tmpdir,
                )

            # 6. 修改密码后旧会话令牌立即失效 (tokenVersion 自增)
            old_alice_token = reg_alice["token"]
            self.assertIsNotNone(verify_session_token(old_alice_token, data_dir=tmpdir))
            chal_a = create_login_challenge("alice", data_dir=tmpdir)
            proof_a = compute_scram_proof(ck_alice, sk_alice, chal_a["nonce"])
            new_salt_a, new_ck_a, new_sk_a = derive_scram_credentials("alice", "AliceNewPass99")
            pwd_res = change_user_password(
                username="alice",
                nonce=chal_a["nonce"],
                current_proof=proof_a,
                new_salt=new_salt_a,
                new_stored_key=new_sk_a,
                data_dir=tmpdir,
            )
            self.assertIsNone(verify_session_token(old_alice_token, data_dir=tmpdir))
            self.assertIsNotNone(verify_session_token(pwd_res["token"], data_dir=tmpdir))

            # 7. 主理人管理邀请码与成员列表
            inv_created = mutate_invite(action="create", note="周末测试", max_uses=1, data_dir=tmpdir)
            self.assertEqual(len(list_invites(data_dir=tmpdir)), 2)
            mutate_invite(action="revoke", code=inv_created["invite"]["code"], data_dir=tmpdir)

            users = list_users_with_vault_stats(data_dir=tmpdir)
            self.assertEqual(len(users), 2)

            del_res = owner_mutate_user(
                owner_username="isaac",
                action="delete",
                target_username="alice",
                data_dir=tmpdir,
            )
            self.assertTrue(del_res["ok"])
            self.assertIsNone(verify_session_token(pwd_res["token"], data_dir=tmpdir))


if __name__ == "__main__":
    unittest.main()
