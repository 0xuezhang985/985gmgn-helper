(() => {
  'use strict';

  // fomo.family 的 document_start 抢跑脚本，只做一件事：
  // 把扩展镜像到本地的最新 Privy 会话，抢在页面 SDK 初始化前写回 localStorage。
  //
  // 旧版本曾由后台直接轮换 refresh_token，可能在扩展存储里留下比网页更新的链。
  // document_start 时 SDK 还没跑，先做一次单向修复；新版本的日常续期只由页面 SDK
  // 完成，扩展不会再制造第二个 refresh owner。
  if (window.__gdhFomoEarly) return;
  window.__gdhFomoEarly = true;

  const jwtExpMs = (token) => {
    try {
      const payload = JSON.parse(atob(String(token).split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
      return Number(payload.exp) > 0 ? Number(payload.exp) * 1000 : 0;
    } catch {
      return 0;
    }
  };
  const unwrap = (raw) => {
    if (!raw) return '';
    let value = raw;
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed === 'string') value = parsed;
    } catch {
      // 非 JSON 按原样用
    }
    value = String(value || '').trim();
    return value.length > 20 ? value : '';
  };

  try {
    chrome.storage.local.get('fomoToken', (stored) => {
      try {
        const cur = stored?.fomoToken;
        if (!cur?.token || !cur.refresh) return;
        const keys = Object.keys(window.localStorage);
        const candidates = keys
          .filter((k) => /^privy:(.+:)?token$/.test(k))
          .map((tokenKey) => {
            const prefix = tokenKey.slice(0, -'token'.length);
            const token = unwrap(window.localStorage.getItem(tokenKey));
            return { tokenKey, refreshKey: `${prefix}refresh_token`, exp: jwtExpMs(token) };
          })
          .sort((a, b) => (b.exp || 0) - (a.exp || 0));
        const tokenKey = candidates[0]?.tokenKey || 'privy:token';
        const refreshKey = candidates[0]?.refreshKey || 'privy:refresh_token';
        const pageToken = unwrap(window.localStorage.getItem(tokenKey));
        const pageExp = pageToken ? jwtExpMs(pageToken) : 0;
        const curExp = Number(cur.exp) || jwtExpMs(cur.token);
        // 页面里的链更新（或一样新）就不动它
        if (pageToken && pageExp >= curExp) return;
        const keep = (key, value) => {
          const raw = window.localStorage.getItem(key);
          // privy 按 JSON 字符串存（带引号），沿用原格式
          const asJson = raw == null || /^"/.test(raw);
          window.localStorage.setItem(key, asJson ? JSON.stringify(value) : value);
        };
        keep(tokenKey, cur.token);
        keep(refreshKey, cur.refresh);
      } catch {
        // localStorage 不可写等，放弃抢跑，走原有兜底
      }
    });
  } catch {
    // 扩展上下文失效
  }
})();
