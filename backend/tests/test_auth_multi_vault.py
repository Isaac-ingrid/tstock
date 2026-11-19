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
    update_auth_settings,
    verify_session_token,
)
from backend.user_vault import load_user_vault, save_user_vault


class TestAuthAndMultiVault(unittest.TestCase):
    def test_legacy_migration_open_and_invite_registration_scram_login_and_vault_isolation(self) -> None:
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

            # 2. 初始状态应提示 needsSetup=True 且默认 allowOpenRegister=True
            st0 = get_auth_status(token=None, data_dir=tmpdir)
            self.assertTrue(st0["needsSetup"])
            self.assertTrue(st0["allowOpenRegister"])
            self.assertTrue(st0["hasLegacyVault"])

            # 3. 初始化主理人账号 isaac，自动接管旧金库
            salt_owner, ck_owner, sk_owner = derive_scram_credentials("isaac", "OwnerPass#2026")
            setup_res = setup_initial_owner(
                username="isaac",
                display_name="Isaac",
                salt=salt_owner,
                stored_key=sk_owner,
                data_dir=tmpdir,
            )
            self.assertTrue(setup_res["ok"])
            self.assertTrue(setup_res["allowOpenRegister"])
            invite_code = setup_res["defaultInviteCode"]

            # 4. 默认开启「免邀请码开放注册」时，朋友 bob 不填邀请码即可直接注册独立金库
            salt_bob, _, sk_bob = derive_scram_credentials("bob", "BobDirectPass77")
            reg_bob = register_with_invite(
                username="bob",
                display_name="Bob",
                invite_code="",
                salt=salt_bob,
                stored_key=sk_bob,
                client_ip="10.0.0.5",
                data_dir=tmpdir,
            )
            self.assertTrue(reg_bob["ok"])
            self.assertEqual(load_user_vault(data_dir=tmpdir, username="bob")["vault"]["availableCash"], 100000.0)
            self.assertEqual(load_user_vault(data_dir=tmpdir, username="isaac")["vault"]["availableCash"], 85600.0)

            # 5. 主理人一键关闭开放注册后，不填或填错邀请码均被拦截，填正确邀请码可通过
            update_auth_settings(allow_open_register=False, data_dir=tmpdir)
            self.assertFalse(get_auth_status(token=None, data_dir=tmpdir)["allowOpenRegister"])

            salt_alice, ck_alice, sk_alice = derive_scram_credentials("alice", "AliceSecret88")
            with self.assertRaises(ValueError):
                register_with_invite(
                    username="alice",
                    invite_code="",
                    salt=salt_alice,
                    stored_key=sk_alice,
                    client_ip="10.0.0.2",
                    data_dir=tmpdir,
                )
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

            # Alice 写入自己的持仓，绝不影响 Isaac 与 Bob 的金库
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

            # 6. 测试 SCRAM 单次挑战登录与防重放攻击
            chal = create_login_challenge("isaac", data_dir=tmpdir)
            proof = compute_scram_proof(ck_owner, sk_owner, chal["nonce"])
            login_ok = login_with_challenge(
                username="isaac",
                nonce=chal["nonce"],
                client_proof=proof,
                client_ip="10.0.0.1",
                data_dir=tmpdir,
            )
            self.assertTrue(login_ok["ok"])
            with self.assertRaises(PermissionError):
                login_with_challenge(
                    username="isaac",
                    nonce=chal["nonce"],
                    client_proof=proof,
                    client_ip="10.0.0.1",
                    data_dir=tmpdir,
                )

            # 7. 修改密码后旧会话失效 & 成员清理
            old_alice_token = reg_alice["token"]
            chal_a = create_login_challenge("alice", data_dir=tmpdir)
            proof_a = compute_scram_proof(ck_alice, sk_alice, chal_a["nonce"])
            new_salt_a, _, new_sk_a = derive_scram_credentials("alice", "AliceNewPass99")
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

            inv_created = mutate_invite(action="create", note="周末测试", max_uses=1, data_dir=tmpdir)
            self.assertEqual(len(list_invites(data_dir=tmpdir)), 2)
            mutate_invite(action="revoke", code=inv_created["invite"]["code"], data_dir=tmpdir)
            self.assertEqual(len(list_users_with_vault_stats(data_dir=tmpdir)), 3)

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
