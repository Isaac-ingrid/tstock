'use client';

import React, { useState, useEffect, useRef } from 'react';

/**
 * 解析金额或数值输入字符串：
 * 支持纯数字、千分位逗号、`¥` 前缀，以及 `w` / `W` / `万` 快捷单位（如 `20w` / `15.5万` -> `200000` / `155000`）
 */
export function parseFlexibleNumber(raw) {
  if (raw === null || raw === undefined) return NaN;
  let str = String(raw).trim().replace(/[¥￥,\s]/g, '');
  if (!str) return NaN;
  let mult = 1;
  if (/[wW万]$/.test(str)) {
    mult = 10000;
    str = str.slice(0, -1).trim();
  } else if (/[kK千]$/.test(str)) {
    mult = 1000;
    str = str.slice(0, -1).trim();
  }
  if (!str || !/^-?\d*(\.\d*)?$/.test(str)) return NaN;
  const num = Number(str);
  return Number.isFinite(num) ? num * mult : NaN;
}

function formatDisplayMoney(val, formatThousand = true, decimals = null) {
  const num = Number(val);
  if (!Number.isFinite(num)) return '0';
  if (decimals !== null) {
    return formatThousand
      ? num.toLocaleString('zh-CN', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
      : num.toFixed(decimals);
  }
  const rounded = Math.round(num * 100) / 100;
  const isInt = Math.abs(rounded - Math.round(rounded)) < 0.005;
  if (!formatThousand) {
    return isInt ? String(Math.round(rounded)) : String(rounded);
  }
  return rounded.toLocaleString('zh-CN', {
    minimumFractionDigits: isInt ? 0 : 2,
    maximumFractionDigits: 2,
  });
}

function formatRawEditValue(val) {
  const num = Number(val);
  if (!Number.isFinite(num)) return '0';
  const rounded = Math.round(num * 100) / 100;
  return String(rounded);
}

/**
 * 全站通用无卡顿直输数字框：
 * - 平时展示清晰千分位金额，点击外框或数字即全选直接敲键盘（无需点二次编辑按钮）
 * - 输入期间锁定本地草稿字符串，彻底杜绝退格变 0、小数点吞没及盘中行情轮询冲掉光标
 * - 支持 Enter 立即提交、Esc 撤销、失焦自动保存，支持 `20w` / `20万` 快捷输入
 */
export default function DirectMoneyInput({
  value = 0,
  onCommit,
  min = 0,
  max = Infinity,
  allowZero = true,
  formatThousand = true,
  decimals = null,
  prefix = '¥',
  suffix = '',
  size = 'md', // 'hero' | 'md' | 'sm' | 'pill' | 'rule'
  tone = 'default', // 'default' | 'cash' | 'accent'
  title = '点击直接输入金额（支持如 200000 或 20w，回车或失焦自动保存）',
  ariaLabel = '金额输入',
  inputStyle = null,
  wrapStyle = null,
  className = '',
}) {
  const [focused, setFocused] = useState(false);
  const [draft, setDraft] = useState(() => formatDisplayMoney(value, formatThousand, decimals));
  const focusedRef = useRef(false);
  const inputRef = useRef(null);

  useEffect(() => {
    if (!focusedRef.current) {
      setDraft(formatDisplayMoney(value, formatThousand, decimals));
    }
  }, [value, formatThousand, decimals]);

  const stopBubble = (e) => {
    e.stopPropagation();
  };

  const handleWrapperClick = (e) => {
    e.stopPropagation();
    if (inputRef.current && document.activeElement !== inputRef.current) {
      inputRef.current.focus();
    }
  };

  const commitValue = (rawStr) => {
    const parsed = parseFlexibleNumber(rawStr);
    const cur = Number(value) || 0;
    if (!Number.isFinite(parsed)) {
      setDraft(formatDisplayMoney(cur, formatThousand, decimals));
      return;
    }
    if (!allowZero && parsed <= 0) {
      setDraft(formatDisplayMoney(cur, formatThousand, decimals));
      return;
    }
    const clamped = Math.min(max, Math.max(min, Math.round(parsed * 100) / 100));
    setDraft(formatDisplayMoney(clamped, formatThousand, decimals));
    if (Math.abs(clamped - cur) >= 0.005 && typeof onCommit === 'function') {
      onCommit(clamped);
    }
  };

  const handleFocus = (e) => {
    e.stopPropagation();
    focusedRef.current = true;
    setFocused(true);
    const rawStr = formatRawEditValue(value);
    setDraft(rawStr);
    requestAnimationFrame(() => {
      if (inputRef.current && document.activeElement === inputRef.current) {
        try {
          inputRef.current.select();
        } catch (_) {}
      }
    });
  };

  const handleBlur = (e) => {
    e.stopPropagation();
    focusedRef.current = false;
    setFocused(false);
    commitValue(e.target.value);
  };

  const handleKeyDown = (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      if (inputRef.current) {
        inputRef.current.blur();
      } else {
        focusedRef.current = false;
        setFocused(false);
        commitValue(draft);
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      focusedRef.current = false;
      setFocused(false);
      setDraft(formatDisplayMoney(value, formatThousand, decimals));
      if (inputRef.current) {
        inputRef.current.blur();
      }
    }
  };

  const charLen = Math.max(3, String(draft || '').length);
  const dynamicCh =
    size === 'pill'
      ? `${Math.min(12, Math.max(5.5, charLen * 0.92 + 0.8))}ch`
      : size === 'sm'
      ? `${Math.min(13, Math.max(6, charLen * 0.95 + 1))}ch`
      : undefined;

  return (
    <span
      className={`direct-money-wrap dm-${size} dm-tone-${tone}${focused ? ' is-focused' : ''}${className ? ` ${className}` : ''}`}
      style={wrapStyle || undefined}
      title={title}
      onClick={handleWrapperClick}
      onMouseDown={stopBubble}
    >
      {prefix ? <span className="dm-prefix">{prefix}</span> : null}
      <input
        ref={inputRef}
        type="text"
        inputMode="decimal"
        autoComplete="off"
        spellCheck={false}
        aria-label={ariaLabel}
        className="direct-money-inp"
        value={draft}
        style={{
          ...(dynamicCh ? { width: dynamicCh } : {}),
          ...(inputStyle || {}),
        }}
        onClick={stopBubble}
        onMouseDown={stopBubble}
        onFocus={handleFocus}
        onBlur={handleBlur}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={handleKeyDown}
      />
      {suffix ? <span className="dm-suffix">{suffix}</span> : null}
    </span>
  );
}
