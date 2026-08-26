(() => {
  'use strict';

  // fomo.family 的 document_start 抢跑脚本，只做一件事：
  // 把插件后台续期出来的最新 privy 令牌，抢在页面 SDK 初始化之前写进 localStorage。
  //
  // 为什么必须抢跑：插件续期会轮换 refresh_token（旧的即刻作废），而写回只能在
  // fomo.family 标签开着时进行。页面关着的时段插件续过期后，网页 localStorage 里
  // 还是已作废的旧 refresh——页面一打开，privy SDK 先用旧 refresh 去续，触发
  // privy 的复用检测把整条会话作废，插件的新链也连坐，表现为"又要重新登录"。
  // document_start 时 SDK 还没跑，这里先把最新链放进去，分叉就不会发生。
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
        const tokenKey = keys.find((k) => /^privy:(.+:)?token$/.test(k)) || 'privy:token';
        const refreshKey = keys.find((k) => /^privy:(.+:)?refresh_token$/.test(k)) || 'privy:refresh_token';
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
