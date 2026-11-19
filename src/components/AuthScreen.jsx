'use client';

import React, { useState } from 'react';
import { deriveScramCredentials, computeScramProof } from '../services/authCrypto.js';
import {
  fetchAuthChallenge,
  postSetupOwner,
  postLoginWithProof,
  postRegisterWithInvite,
} from '../services/api.js';

export default function AuthScreen({
  needsSetup = false,
  allowOpenRegister = true,
  hasLegacyVault = false,
  legacySummary = null,
  backendError = '',
  onRetryCheck,
  onAuthSuccess,
}) {
  const [tab, setTab] = useState('login'); // 'login' | 'register'
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [inviteCode, setInviteCode] = useState(() => {
    if (typeof window === 'undefined') return '';
    try {
      const m = window.location.search.match(/[?&]invite=([^&#]+)/) || window.location.hash.match(/[?&]invite=([^&#]+)/);
      if (m && m[1]) return decodeURIComponent(m[1]).trim().toUpperCase();
    } catch (_) {}
    return '';
  });
  const [busy, setBusy] = useState(false);
  const [errMsg, setErrMsg] = useState('');

  React.useEffect(() => {
    if (inviteCode && !needsSetup) {
      setTab('register');
    }
  }, [inviteCode, needsSetup]);

  const validateUsername = (u) => /^[a-z0-9][a-z0-9_-]{1,23}$/.test(u);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setErrMsg('');
    const u = String(username || '').trim().toLowerCase();
    if (!validateUsername(u)) {
      setErrMsg('账号名需为 2~24 位小写字母、数字、下划线或短横线（字母或数字开头）');
      return;
    }
    if (!password || password.length < 6) {
      setErrMsg('密码长度至少需要 6 位');
      return;
    }

    setBusy(true);
    try {
      if (needsSetup) {
        if (password !== confirmPassword) {
          throw new Error('两次输入的密码不一致');
        }
        const creds = deriveScramCredentials(u, password);
        const res = await postSetupOwner({
          username: u,
          displayName: displayName.trim() || u,
          salt: creds.salt,
          storedKey: creds.storedKey,
        });
        onAuthSuccess({
          ...res,
          mode: 'setup_owner',
        });
        return;
      }

      if (tab === 'register') {
        if (!allowOpenRegister && !inviteCode.trim()) {
          throw new Error('请输入主理人分享的邀请码');
        }
        if (password !== confirmPassword) {
          throw new Error('两次输入的密码不一致');
        }
        const creds = deriveScramCredentials(u, password);
        const res = await postRegisterWithInvite({
          username: u,
          displayName: displayName.trim() || u,
          inviteCode: inviteCode.trim().toUpperCase(),
          salt: creds.salt,
          storedKey: creds.storedKey,
        });
        onAuthSuccess({
          ...res,
          mode: 'register',
        });
        return;
      }

      // 登录：先取一次性随机挑战串，再在浏览器本地计算异或证明（明文绝不上网）
      const chal = await fetchAuthChallenge(u);
      const creds = deriveScramCredentials(u, password, chal.salt, chal.rounds || 2048);
      const proof = computeScramProof(creds.clientKey, creds.storedKey, chal.nonce);
      const res = await postLoginWithProof({
        username: u,
        nonce: chal.nonce,
        clientProof: proof,
      });
      onAuthSuccess({
        ...res,
        mode: 'login',
      });
    } catch (err) {
      setErrMsg(err?.message || '请求失败，请重试');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-gate-wrap">
      <div className="auth-card">
        <div className="auth-brand-hd">
          <img src="/favicon.svg" alt="T-Stock" className="auth-logo" />
          <div>
            <div className="auth-title">智策战情室 · T-Stock</div>
            <div className="auth-sub">A股多维选股与盘中做T实战终端 · 多账号独立金库</div>
          </div>
        </div>

        {backendError ? (
          <div className="auth-err-box">
            <div style={{ fontWeight: 700, marginBottom: '4px' }}>⚠️ 无法连接战情室鉴权服务</div>
            <div style={{ fontSize: '12px', opacity: 0.9 }}>{backendError}</div>
            {onRetryCheck && (
              <button
                type="button"
                className="auth-submit-btn"
                style={{ marginTop: '12px' }}
                onClick={onRetryCheck}
              >
                ↻ 重新连接服务
              </button>
            )}
          </div>
        ) : needsSetup ? (
          <>
            <div className="auth-setup-banner">
              <div style={{ fontWeight: 800, fontSize: '13.5px', color: '#1e3a8a', marginBottom: '4px' }}>
                👑 首次启用 · 创建主理人主账号
              </div>
              <div style={{ fontSize: '12px', color: '#334155', lineHeight: 1.55 }}>
                {hasLegacyVault ? (
                  <>
                    检测到服务器已有原实盘金库数据
                    {legacySummary ? (
                      <b>（自选 {legacySummary.poolCount || 0} 只 · 持仓 {legacySummary.holdingCount || 0} 只 · 流水 {legacySummary.logCount || 0} 笔）</b>
                    ) : null}
                    ，完成设置后将<b>自动无缝迁移绑定至你的主账号</b>；默认已开启免邀请码开放注册（你可随时在右上角关闭门禁）。
                  </>
                ) : (
                  <>
                    创建后你将成为主理人并拥有专属独立金库；默认已开启免邀请码开放注册，朋友可直接开户（你也可随时切换为仅限邀请码注册）。
                  </>
                )}
              </div>
            </div>

            <form onSubmit={handleSubmit} className="auth-form">
              <label className="auth-field">
                <span>主理人登录账号（英文/数字，如 isaac）</span>
                <input
                  type="text"
                  className="auth-input"
                  placeholder="例如: isaac"
                  autoComplete="username"
                  autoCapitalize="none"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  required
                />
              </label>
              <label className="auth-field">
                <span>显示昵称（选填）</span>
                <input
                  type="text"
                  className="auth-input"
                  placeholder="顶栏展示名称，留空同账号名"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                />
              </label>
              <label className="auth-field">
                <span>设置登录密码（至少 6 位，挑战签名加密传输）</span>
                <input
                  type="password"
                  className="auth-input"
                  placeholder="至少 6 位字符"
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
              </label>
              <label className="auth-field">
                <span>确认登录密码</span>
                <input
                  type="password"
                  className="auth-input"
                  placeholder="再次输入密码"
                  autoComplete="new-password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  required
                />
              </label>

              {errMsg && <div className="auth-inline-err">{errMsg}</div>}

              <button type="submit" className="auth-submit-btn" disabled={busy}>
                {busy ? '正在加密初始化并迁移金库…' : '👑 创建主账号并进入战情室'}
              </button>
            </form>
          </>
        ) : (
          <>
            <div className="auth-tabs">
              <button
                type="button"
                className={`auth-tab ${tab === 'login' ? 'active' : ''}`}
                onClick={() => { setTab('login'); setErrMsg(''); }}
              >
                🔐 账号登录
              </button>
              <button
                type="button"
                className={`auth-tab ${tab === 'register' ? 'active' : ''}`}
                onClick={() => { setTab('register'); setErrMsg(''); }}
              >
                {allowOpenRegister ? '✨ 注册新账号' : '🎟️ 邀请码注册'}
              </button>
            </div>

            <form onSubmit={handleSubmit} className="auth-form">
              {tab === 'register' && (!allowOpenRegister || inviteCode) && (
                <label className="auth-field">
                  <span>{allowOpenRegister ? '邀请码（选填，当前已开放自由注册）' : '注册邀请码（向主理人获取）'}</span>
                  <input
                    type="text"
                    className="auth-input mono"
                    placeholder="如 TS-8K4M-9P2X"
                    autoCapitalize="characters"
                    value={inviteCode}
                    onChange={(e) => setInviteCode(e.target.value.toUpperCase())}
                    required={!allowOpenRegister}
                  />
                </label>
              )}

              <label className="auth-field">
                <span>登录账号</span>
                <input
                  type="text"
                  className="auth-input"
                  placeholder="2~24 位字母或数字"
                  autoComplete="username"
                  autoCapitalize="none"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  required
                />
              </label>

              {tab === 'register' && (
                <label className="auth-field">
                  <span>显示昵称（选填）</span>
                  <input
                    type="text"
                    className="auth-input"
                    placeholder="用于顶栏识别，可填中文昵称"
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                  />
                </label>
              )}

              <label className="auth-field">
                <span>登录密码</span>
                <input
                  type="password"
                  className="auth-input"
                  placeholder={tab === 'register' ? '设置至少 6 位登录密码' : '输入登录密码'}
                  autoComplete={tab === 'register' ? 'new-password' : 'current-password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
              </label>

              {tab === 'register' && (
                <label className="auth-field">
                  <span>确认密码</span>
                  <input
                    type="password"
                    className="auth-input"
                    placeholder="再次输入密码"
                    autoComplete="new-password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    required
                  />
                </label>
              )}

              {errMsg && <div className="auth-inline-err">{errMsg}</div>}

              <button type="submit" className="auth-submit-btn" disabled={busy}>
                {busy
                  ? (tab === 'register' ? '正在创建独立金库…' : '正在安全验证…')
                  : (tab === 'register' ? '🚀 注册并开启独立实盘金库' : '进入战情室（30天免重复登录）')}
              </button>
            </form>
          </>
        )}

        <div className="auth-foot-note">
          🛡️ 采用 SCRAM-SHA-256 随机挑战签名协议，密码绝不以明文经过网络；各账号持仓、现金与复盘台账物理隔离存储。
        </div>
      </div>
    </div>
  );
}
