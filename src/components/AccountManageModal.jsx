'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { deriveScramCredentials, computeScramProof } from '../services/authCrypto.js';
import {
  fetchAuthChallenge,
  postChangePassword,
  fetchAuthInvites,
  postUpdateAuthSettings,
  postMutateInvite,
  fetchAuthUsers,
  postMutateAuthUser,
} from '../services/api.js';
import { copyPlain, toastOk, toastErr } from '../services/utils.js';
import DirectMoneyInput from './DirectMoneyInput.jsx';

export default function AccountManageModal({
  open,
  onClose,
  currentUser,
  totalAssets = 100000,
  cash = 0,
  initialCapital = 100000,
  onUpdateTotalAssets,
  onUpdateCash,
  onUpdateInitialCapital,
  allowOpenRegister = true,
  onUpdateOpenRegister,
  vaultStatus,
  onSyncVaultNow,
  onPullVaultNow,
  onPasswordChanged,
  onLogout,
}) {
  const isOwner = currentUser?.role === 'owner';
  const [tab, setTab] = useState('profile'); // 'profile' | 'invites' | 'users'
  const [openReg, setOpenReg] = useState(Boolean(allowOpenRegister));
  const [settingBusy, setSettingBusy] = useState(false);

  // 修改密码表单
  const [curPwd, setCurPwd] = useState('');
  const [newPwd, setNewPwd] = useState('');
  const [confirmPwd, setConfirmPwd] = useState('');
  const [pwdBusy, setPwdBusy] = useState(false);

  // 主理人邀请码与成员管理
  const [invites, setInvites] = useState([]);
  const [invNote, setInvNote] = useState('好友实盘体验');
  const [invMaxUses, setInvMaxUses] = useState(5);
  const [invLoading, setInvLoading] = useState(false);

  const [users, setUsers] = useState([]);
  const [usersLoading, setUsersLoading] = useState(false);
  const [resetTarget, setResetTarget] = useState('');
  const [resetNewPwd, setResetNewPwd] = useState('');

  useEffect(() => {
    setOpenReg(Boolean(allowOpenRegister));
  }, [allowOpenRegister]);

  const loadOwnerInvites = useCallback(async () => {
    if (!isOwner) return;
    setInvLoading(true);
    try {
      const res = await fetchAuthInvites();
      if (res?.invites) setInvites(res.invites);
      if (res?.settings && typeof res.settings.allowOpenRegister === 'boolean') {
        setOpenReg(res.settings.allowOpenRegister);
        if (onUpdateOpenRegister) onUpdateOpenRegister(res.settings.allowOpenRegister);
      }
    } catch (err) {
      toastErr(err?.message || '读取注册设置失败');
    } finally {
      setInvLoading(false);
    }
  }, [isOwner, onUpdateOpenRegister]);

  const loadOwnerUsers = useCallback(async () => {
    if (!isOwner) return;
    setUsersLoading(true);
    try {
      const res = await fetchAuthUsers();
      if (res?.users) setUsers(res.users);
    } catch (err) {
      toastErr(err?.message || '读取成员列表失败');
    } finally {
      setUsersLoading(false);
    }
  }, [isOwner]);

  useEffect(() => {
    if (!open) return;
    if (tab === 'invites' && isOwner) loadOwnerInvites();
    if (tab === 'users' && isOwner) loadOwnerUsers();
  }, [open, tab, isOwner, loadOwnerInvites, loadOwnerUsers]);

  if (!open || !currentUser) return null;

  const handleToggleOpenRegister = async () => {
    const nextVal = !openReg;
    setSettingBusy(true);
    try {
      const res = await postUpdateAuthSettings({ allowOpenRegister: nextVal });
      const confirmed = Boolean(res?.settings?.allowOpenRegister ?? nextVal);
      setOpenReg(confirmed);
      if (onUpdateOpenRegister) onUpdateOpenRegister(confirmed);
      toastOk(
        confirmed
          ? '🟢 已开启「免邀请码开放注册」，朋友可直接输入账号密码注册独立金库'
          : '🔒 已关闭自由注册，现在新用户必须凭有效邀请码才能注册'
      );
    } catch (err) {
      toastErr(err?.message || '更新注册开关失败');
    } finally {
      setSettingBusy(false);
    }
  };

  const handleChangePwd = async (e) => {
    e.preventDefault();
    if (!curPwd || !newPwd || newPwd.length < 6) {
      toastErr('新密码长度至少需要 6 位');
      return;
    }
    if (newPwd !== confirmPwd) {
      toastErr('两次输入的新密码不一致');
      return;
    }
    setPwdBusy(true);
    try {
      const u = currentUser.username;
      const chal = await fetchAuthChallenge(u);
      const oldCreds = deriveScramCredentials(u, curPwd, chal.salt, chal.rounds || 2048);
      const currentProof = computeScramProof(oldCreds.clientKey, oldCreds.storedKey, chal.nonce);
      const nextCreds = deriveScramCredentials(u, newPwd);
      const res = await postChangePassword({
        nonce: chal.nonce,
        currentProof,
        newSalt: nextCreds.salt,
        newStoredKey: nextCreds.storedKey,
      });
      setCurPwd('');
      setNewPwd('');
      setConfirmPwd('');
      if (onPasswordChanged) onPasswordChanged(res);
      toastOk('✓ 密码已修改成功，其他设备上的旧会话已自动失效');
    } catch (err) {
      toastErr(err?.message || '修改密码失败');
    } finally {
      setPwdBusy(false);
    }
  };

  const handleCreateInvite = async () => {
    try {
      const res = await postMutateInvite({
        action: 'create',
        note: invNote.trim() || '好友邀请码',
        maxUses: Number(invMaxUses),
      });
      if (res?.invites) setInvites(res.invites);
      if (res?.invite?.code) {
        const origin = typeof window !== 'undefined' ? window.location.origin : '';
        copyPlain(
          `邀你使用「智策战情室」A股做T与多维选股终端：${origin}/?invite=${res.invite.code} （注册邀请码：${res.invite.code}，每个账号持仓与台账完全独立隔离）`,
          `✓ 已生成邀请码 ${res.invite.code} 并复制邀请链接！`
        );
      }
    } catch (err) {
      toastErr(err?.message || '生成邀请码失败');
    }
  };

  const handleCopyInviteLink = (code) => {
    const origin = typeof window !== 'undefined' ? window.location.origin : '';
    copyPlain(
      `邀你使用「智策战情室」A股做T终端：${origin}/?invite=${code} （邀请码：${code}）`,
      `✓ 已复制邀请码 ${code} 及直达注册链接！`
    );
  };

  const handleRevokeOrDeleteInvite = async (action, code) => {
    try {
      const res = await postMutateInvite({ action, code });
      if (res?.invites) setInvites(res.invites);
      toastOk(action === 'revoke' ? `已作废邀请码 ${code}` : `已删除邀请码 ${code}`);
    } catch (err) {
      toastErr(err?.message || '操作失败');
    }
  };

  const handleOwnerResetPwd = async (targetUser) => {
    if (!resetNewPwd || resetNewPwd.length < 6) {
      toastErr('请输入至少 6 位的新临时密码');
      return;
    }
    try {
      const creds = deriveScramCredentials(targetUser, resetNewPwd);
      const res = await postMutateAuthUser({
        action: 'reset_password',
        username: targetUser,
        newSalt: creds.salt,
        newStoredKey: creds.storedKey,
      });
      if (res?.users) setUsers(res.users);
      setResetTarget('');
      setResetNewPwd('');
      toastOk(`✓ 已重置 ${targetUser} 的密码`);
    } catch (err) {
      toastErr(err?.message || '重置密码失败');
    }
  };

  const handleOwnerDeleteUser = async (targetUser) => {
    if (!window.confirm(`确定移除成员账号「${targetUser}」吗？（其历史金库将在服务器自动归档留底）`)) {
      return;
    }
    try {
      const res = await postMutateAuthUser({
        action: 'delete',
        username: targetUser,
      });
      if (res?.users) setUsers(res.users);
      toastOk(`已移除成员 ${targetUser}`);
    } catch (err) {
      toastErr(err?.message || '移除成员失败');
    }
  };

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal-box" style={{ maxWidth: '580px' }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-hd">
          <b>
            {isOwner ? '👑' : '👤'} 账号与独立金库管理 · {currentUser.displayName || currentUser.username}
          </b>
          <button type="button" className="modal-close" onClick={onClose}>✕</button>
        </div>

        <div className="modal-bd" style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
          {isOwner && (
            <div className="auth-tabs" style={{ marginBottom: 0 }}>
              <button
                type="button"
                className={`auth-tab ${tab === 'profile' ? 'active' : ''}`}
                onClick={() => setTab('profile')}
              >
                👤 我的金库
              </button>
              <button
                type="button"
                className={`auth-tab ${tab === 'invites' ? 'active' : ''}`}
                onClick={() => setTab('invites')}
              >
                🎟️ 注册与邀请码
              </button>
              <button
                type="button"
                className={`auth-tab ${tab === 'users' ? 'active' : ''}`}
                onClick={() => setTab('users')}
              >
                👥 成员列表
              </button>
            </div>
          )}

          {tab === 'profile' && (
            <>
              <div style={{
                padding: '12px 14px',
                borderRadius: '10px',
                background: 'var(--surface)',
                border: '1px solid var(--line)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                flexWrap: 'wrap',
                gap: '10px',
              }}>
                <div>
                  <div style={{ fontSize: '14px', fontWeight: 800 }}>
                    {currentUser.displayName || currentUser.username}{' '}
                    <span style={{ fontFamily: 'monospace', fontSize: '12px', color: 'var(--mute)' }}>
                      @{currentUser.username}
                    </span>{' '}
                    <span style={{
                      fontSize: '11px',
                      padding: '1px 7px',
                      borderRadius: '99px',
                      background: isOwner ? 'var(--warn-bg)' : 'var(--info-bg)',
                      color: isOwner ? 'var(--warn-d)' : 'var(--accent-d)',
                      fontWeight: 700,
                    }}>
                      {isOwner ? '主理人' : '独立成员'}
                    </span>
                  </div>
                  <div style={{ fontSize: '12px', color: 'var(--sub)', marginTop: '4px' }}>
                    专属云金库：<code style={{ fontSize: '11.5px' }}>data/vaults/{currentUser.username}.json</code>
                    {vaultStatus?.updatedAt ? ` · 最近同步 ${vaultStatus.updatedAt}` : ''}
                    {vaultStatus?.backupCount ? ` · 历史快照 ${vaultStatus.backupCount} 份` : ''}
                  </div>
                </div>

                <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                  <button type="button" className="mini" onClick={onSyncVaultNow}>
                    ☁️ 立即上传同步
                  </button>
                  <button type="button" className="mini" onClick={onPullVaultNow}>
                    ⬇ 从云端拉取
                  </button>
                </div>
              </div>

              {(onUpdateTotalAssets || onUpdateCash || onUpdateInitialCapital) && (
                <div style={{
                  padding: '12px 14px',
                  borderRadius: '10px',
                  background: 'var(--surface2)',
                  border: '1px solid var(--line)',
                }}>
                  <div style={{ fontSize: '12.5px', fontWeight: 700, marginBottom: '8px', display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: '4px' }}>
                    <span>💰 账户资产与本金快速输入</span>
                    <span style={{ fontSize: '11px', fontWeight: 400, color: 'var(--mute)' }}>直接输入数字回车即存，自动同步云金库</span>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '8px' }}>
                    {onUpdateTotalAssets && (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                        <span style={{ fontSize: '11.5px', color: 'var(--sub)' }}>实时账户总资产</span>
                        <DirectMoneyInput
                          value={totalAssets}
                          onCommit={onUpdateTotalAssets}
                          min={0}
                          allowZero={true}
                          size="md"
                          ariaLabel="账号弹窗总资产输入"
                        />
                      </div>
                    )}
                    {onUpdateCash && (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                        <span style={{ fontSize: '11.5px', color: 'var(--sub)' }}>真实可用现金</span>
                        <DirectMoneyInput
                          value={cash}
                          onCommit={onUpdateCash}
                          min={0}
                          allowZero={true}
                          size="md"
                          tone="cash"
                          ariaLabel="账号弹窗可用现金输入"
                        />
                      </div>
                    )}
                    {onUpdateInitialCapital && (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                        <span style={{ fontSize: '11.5px', color: 'var(--sub)' }}>初始投入本金</span>
                        <DirectMoneyInput
                          value={initialCapital}
                          onCommit={onUpdateInitialCapital}
                          min={100}
                          allowZero={false}
                          size="md"
                          ariaLabel="账号弹窗初始本金输入"
                        />
                      </div>
                    )}
                  </div>
                </div>
              )}

              {isOwner && (
                <div style={{
                  padding: '10px 13px',
                  borderRadius: '10px',
                  background: openReg ? 'var(--down-bg)' : 'var(--warn-bg)',
                  border: `1px solid ${openReg ? 'var(--down-b)' : 'var(--warn-b)'}`,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  flexWrap: 'wrap',
                  gap: '8px',
                }}>
                  <div style={{ fontSize: '12px', color: 'var(--text)', flex: '1 1 220px', minWidth: 0 }}>
                    <b>{openReg ? '🟢 免邀请码开放注册：已开启' : '🔒 邀请码门禁注册：已开启'}</b>
                    <div style={{ fontSize: '11.5px', color: 'var(--sub)', marginTop: '2px' }}>
                      {openReg
                        ? '朋友打开网址可直接注册独立账号；人齐后可随时关上防陌生人注册。'
                        : '陌生人无法自由开户，必须输入你分享的有效邀请码才能注册。'}
                    </div>
                  </div>
                  <button
                    type="button"
                    className="mini"
                    disabled={settingBusy}
                    onClick={handleToggleOpenRegister}
                    style={{
                      fontWeight: 700,
                      borderColor: openReg ? 'var(--warn-b)' : 'var(--down-b)',
                      background: 'var(--card)',
                      color: openReg ? 'var(--warn-d)' : 'var(--down-d)',
                    }}
                  >
                    {openReg ? '🔒 切换为仅凭邀请码' : '🟢 开启免邀请码注册'}
                  </button>
                </div>
              )}

              <form onSubmit={handleChangePwd} style={{
                padding: '12px 14px',
                borderRadius: '10px',
                border: '1px solid var(--line)',
                display: 'flex',
                flexDirection: 'column',
                gap: '9px',
              }}>
                <div style={{ fontSize: '13px', fontWeight: 800 }}>🔑 修改登录密码</div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '8px' }}>
                  <input
                    type="password"
                    className="auth-input compact"
                    placeholder="当前密码"
                    autoComplete="current-password"
                    value={curPwd}
                    onChange={(e) => setCurPwd(e.target.value)}
                  />
                  <input
                    type="password"
                    className="auth-input compact"
                    placeholder="新密码（≥6位）"
                    autoComplete="new-password"
                    value={newPwd}
                    onChange={(e) => setNewPwd(e.target.value)}
                  />
                  <input
                    type="password"
                    className="auth-input compact"
                    placeholder="确认新密码"
                    autoComplete="new-password"
                    value={confirmPwd}
                    onChange={(e) => setConfirmPwd(e.target.value)}
                  />
                </div>
                <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                  <button type="submit" className="mini primary" disabled={pwdBusy}>
                    {pwdBusy ? '提交中…' : '更新密码'}
                  </button>
                </div>
              </form>

              <div style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                flexWrap: 'wrap',
                gap: '8px',
                paddingTop: '4px',
              }}>
                <span style={{ fontSize: '11.5px', color: 'var(--mute)' }}>
                  切换或退出账号前会自动保存当前金库，各账号数据互不串号。
                </span>
                <button
                  type="button"
                  className="mini"
                  style={{ borderColor: 'var(--up-b)', color: '#dc2626', background: 'var(--up-bg)', fontWeight: 700 }}
                  onClick={onLogout}
                >
                  🚪 退出当前账号
                </button>
              </div>
            </>
          )}

          {tab === 'invites' && isOwner && (
            <>
              <div style={{
                padding: '10px 13px',
                borderRadius: '10px',
                background: openReg ? 'var(--down-bg)' : 'var(--warn-bg)',
                border: `1px solid ${openReg ? 'var(--down-b)' : 'var(--warn-b)'}`,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                flexWrap: 'wrap',
                gap: '8px',
              }}>
                <div style={{ fontSize: '12px', color: 'var(--text)', flex: '1 1 220px', minWidth: 0 }}>
                  <b>{openReg ? '🟢 当前已开启「免邀请码开放注册」' : '🔒 当前已开启「邀请码门禁保护」'}</b>
                  <div style={{ fontSize: '11.5px', color: 'var(--sub)', marginTop: '2px' }}>
                    {openReg
                      ? '无需填邀请码即可直接注册；若想限制陌生人开户，点击右侧按钮关闭即可。'
                      : '新用户注册时必须填写下方未作废的邀请码。'}
                  </div>
                </div>
                <button
                  type="button"
                  className="mini"
                  disabled={settingBusy}
                  onClick={handleToggleOpenRegister}
                  style={{
                    fontWeight: 700,
                    borderColor: openReg ? 'var(--warn-b)' : 'var(--down-b)',
                    background: 'var(--card)',
                    color: openReg ? 'var(--warn-d)' : 'var(--down-d)',
                  }}
                >
                  {openReg ? '🔒 切换为仅凭邀请码' : '🟢 开启免邀请码注册'}
                </button>
              </div>

              <div style={{
                padding: '11px 13px',
                borderRadius: '10px',
                background: 'var(--surface)',
                border: '1px solid var(--line)',
                display: 'flex',
                flexWrap: 'wrap',
                alignItems: 'center',
                gap: '8px',
              }}>
                <input
                  type="text"
                  className="auth-input compact"
                  style={{ flex: '1 1 160px' }}
                  placeholder="备注（如：给老王开号）"
                  value={invNote}
                  onChange={(e) => setInvNote(e.target.value)}
                />
                <select
                  className="auth-input compact"
                  style={{ width: 'auto', flex: '0 0 auto' }}
                  value={invMaxUses}
                  onChange={(e) => setInvMaxUses(Number(e.target.value))}
                >
                  <option value={1}>可用 1 次（单人专属）</option>
                  <option value={5}>可用 5 次</option>
                  <option value={10}>可用 10 次</option>
                  <option value={0}>不限次数（被作废前有效）</option>
                </select>
                <button type="button" className="mini primary" onClick={handleCreateInvite}>
                  ✨ 生成邀请码并复制链接
                </button>
              </div>

              {invLoading ? (
                <div style={{ padding: '18px', textAlign: 'center', color: 'var(--mute)', fontSize: '12.5px' }}>
                  正在读取邀请码列表…
                </div>
              ) : invites.length === 0 ? (
                <div style={{ padding: '18px', textAlign: 'center', color: 'var(--mute)', fontSize: '12.5px' }}>
                  暂无邀请码，点击上方按钮即可一键生成。
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', maxHeight: '300px', overflowY: 'auto' }}>
                  {invites.map((inv) => {
                    const maxU = Number(inv.maxUses || 0);
                    const usedU = Number(inv.usedCount || 0);
                    const exhausted = maxU > 0 && usedU >= maxU;
                    const disabled = Boolean(inv.revoked) || exhausted;
                    return (
                      <div
                        key={inv.code}
                        style={{
                          padding: '10px 12px',
                          borderRadius: '8px',
                          border: '1px solid var(--line)',
                          background: disabled ? 'var(--surface)' : 'var(--card)',
                          opacity: disabled ? 0.72 : 1,
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          flexWrap: 'wrap',
                          gap: '8px',
                        }}
                      >
                        <div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                            <b style={{ fontFamily: 'monospace', fontSize: '14px', color: disabled ? 'var(--mute)' : 'var(--info-d)' }}>
                              {inv.code}
                            </b>
                            <span style={{ fontSize: '12px', color: 'var(--text)', fontWeight: 600 }}>
                              {inv.note || '好友邀请码'}
                            </span>
                            <span style={{
                              fontSize: '11px',
                              padding: '1px 6px',
                              borderRadius: '4px',
                              background: disabled ? 'var(--surface2)' : 'var(--down-bg)',
                              color: disabled ? 'var(--mute)' : 'var(--down-d)',
                              fontWeight: 700,
                            }}>
                              {inv.revoked ? '已作废' : exhausted ? `已用完 (${usedU}/${maxU})` : maxU === 0 ? `已用 ${usedU} 次 (不限)` : `已用 ${usedU}/${maxU}`}
                            </span>
                          </div>
                          {Array.isArray(inv.usedBy) && inv.usedBy.length > 0 && (
                            <div style={{ fontSize: '11px', color: 'var(--mute)', marginTop: '3px' }}>
                              已注册成员：{inv.usedBy.map((x) => x.username).join('、')}
                            </div>
                          )}
                        </div>

                        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                          {!disabled && (
                            <button type="button" className="mini" onClick={() => handleCopyInviteLink(inv.code)}>
                              📋 复制邀请链接
                            </button>
                          )}
                          {!inv.revoked && !exhausted && (
                            <button type="button" className="mini" onClick={() => handleRevokeOrDeleteInvite('revoke', inv.code)}>
                              作废
                            </button>
                          )}
                          <button type="button" className="mini" onClick={() => handleRevokeOrDeleteInvite('delete', inv.code)}>
                            删除
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          )}

          {tab === 'users' && isOwner && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', maxHeight: '360px', overflowY: 'auto' }}>
              {usersLoading ? (
                <div style={{ padding: '18px', textAlign: 'center', color: 'var(--mute)', fontSize: '12.5px' }}>
                  正在读取成员概览…
                </div>
              ) : (
                users.map((u) => (
                  <div
                    key={u.username}
                    style={{
                      padding: '10px 12px',
                      borderRadius: '8px',
                      border: '1px solid var(--line)',
                      background: 'var(--card)',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '8px',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px' }}>
                      <div>
                        <div style={{ fontSize: '13.5px', fontWeight: 800 }}>
                          {u.role === 'owner' ? '👑 ' : '👤 '}
                          {u.displayName}{' '}
                          <span style={{ fontFamily: 'monospace', fontSize: '11.5px', color: 'var(--mute)' }}>
                            @{u.username}
                          </span>
                        </div>
                        <div style={{ fontSize: '11.5px', color: 'var(--sub)', marginTop: '2px' }}>
                          自选 {u.poolCount || 0} 只 · 持仓 {u.holdingCount || 0} 只 · 流水 {u.logCount || 0} 笔
                          {u.lastLoginAt ? ` · 最近登录 ${u.lastLoginAt}` : ''}
                        </div>
                      </div>

                      {u.role !== 'owner' && (
                        <div style={{ display: 'flex', gap: '6px' }}>
                          <button
                            type="button"
                            className="mini"
                            onClick={() => {
                              setResetTarget(resetTarget === u.username ? '' : u.username);
                              setResetNewPwd('');
                            }}
                          >
                            重置密码
                          </button>
                          <button
                            type="button"
                            className="mini"
                            style={{ color: '#dc2626', borderColor: 'var(--up-b)' }}
                            onClick={() => handleOwnerDeleteUser(u.username)}
                          >
                            移除
                          </button>
                        </div>
                      )}
                    </div>

                    {resetTarget === u.username && (
                      <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', paddingTop: '6px', borderTop: '1px dashed var(--hair)' }}>
                        <input
                          type="text"
                          className="auth-input compact"
                          style={{ flex: '1 1 180px' }}
                          placeholder={`输入 ${u.username} 的新临时密码（≥6位）`}
                          value={resetNewPwd}
                          onChange={(e) => setResetNewPwd(e.target.value)}
                        />
                        <button type="button" className="mini primary" onClick={() => handleOwnerResetPwd(u.username)}>
                          确认重置
                        </button>
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
