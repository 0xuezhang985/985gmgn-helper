(() => {
  'use strict';
  if (location.hostname !== 'fomo.family') return;
  const version = chrome.runtime.getManifest().version;
  try { window.__gdhFomoMirrorCleanup?.(); } catch { /* 旧扩展上下文已失效 */ }
  let stopped = false;
  window.__gdhFomoMirrorVersion = version;
    const unwrap = (raw) => {
      if (!raw) return '';
      let value = raw;
      try {
        const parsed = JSON.parse(raw);
        if (typeof parsed === 'string') value = parsed;
      } catch {
        // 非 JSON 就按原样用
      }
      value = String(value || '').trim();
      return value.length > 20 ? value : '';
    };
    const jwtExpMs = (token) => {
      try {
        const payload = JSON.parse(atob(String(token).split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
        return Number(payload.exp) > 0 ? Number(payload.exp) * 1000 : 0;
      } catch {
        return 0;
      }
    };
    // 多账号登录时 Privy 会写 privy:<userId>:token。token 与 refresh_token 必须按
    // 相同前缀成对读取；旧代码各取第一个，枚举顺序不同时会拼出一条不存在的会话链。
    const readPrivy = () => {
      const pairs = [];
      try {
        for (const tokenKey of Object.keys(window.localStorage).filter((key) => /^privy:(.+:)?token$/.test(key))) {
          const prefix = tokenKey.slice(0, -'token'.length);
          const token = unwrap(window.localStorage.getItem(tokenKey));
          if (!token) continue;
          pairs.push({
            token,
            refresh: unwrap(window.localStorage.getItem(`${prefix}refresh_token`)),
            exp: jwtExpMs(token),
          });
        }
      } catch {
        // localStorage 不可用
      }
      pairs.sort((a, b) => (b.exp || 0) - (a.exp || 0));
      return pairs[0] || { token: '', refresh: '', exp: 0 };
    };
    let lastSent = '';
    const syncFomoToken = () => {
      if (stopped) return;
      const { token, refresh } = readPrivy();
      // 读不到就什么都不做：未登录、privy 还没水合、切页面的空档都会短暂读空，
      // 以前这里会写 null，把一个还能用的令牌直接擦掉。
      if (!token) return;
      const stamp = `${token}|${refresh}`;
      if (stamp === lastSent) return;
      const pageExp = jwtExpMs(token);
      try {
        chrome.storage.local.get('fomoToken', (stored) => {
          if (stopped) return;
          const cur = stored?.fomoToken;
          // 和插件存的完全一致就不用再写一遍
          if (cur?.token === token && (cur.refresh || '') === (refresh || '')) {
            lastSent = stamp;
            return;
          }
          // 另一个页面可能已经镜像了更晚过期的新令牌；较旧页面不准盖回去。
          if (cur?.token && cur.token !== token && cur.exp && pageExp && cur.exp >= pageExp) return;
          lastSent = stamp;
          try {
            chrome.storage.local.set({ fomoToken: { token, refresh, at: Date.now(), exp: pageExp } });
          } catch {
            // 扩展上下文失效
          }
        });
      } catch {
        // 扩展上下文失效
      }
    };
    const onSync = (message, sender, reply) => {
      if (message?.type !== 'fomo-sync-now' || sender.id !== chrome.runtime.id) return false;
      syncFomoToken(); beat(); reply({ ok: true }); return false;
    };
    chrome.runtime.onMessage.addListener(onSync);
    syncFomoToken();
    // 页面开着时它才是 privy 轮换链的主人，插件只镜像。同一个 document 里的
    // localStorage 写入不触发 storage 事件，监听不到，只能轮询——间隔要短，
    // 页面续期后插件手里的 refresh 立刻就是废的，镜像慢一秒就多一秒踩空的窗口。
    const mirrorTimer = window.setInterval(syncFomoToken, 5000);
    window.addEventListener('focus', syncFomoToken);
    window.addEventListener('visibilitychange', syncFomoToken);

    // 心跳仅用于诊断，是否能续期必须由后台检查页面 SDK。
    const beat = () => {
      try {
        chrome.runtime.sendMessage({
          type: 'fomo-page-heartbeat',
          visible: document.visibilityState === 'visible',
          keeper: new URLSearchParams(location.search).has('gdh_keeper'),
        }, () => void chrome.runtime.lastError);
      } catch {
        // 扩展上下文失效
      }
    };
    beat();
    const beatTimer = window.setInterval(beat, 15000);
    document.addEventListener('visibilitychange', beat);
    window.__gdhFomoMirrorCleanup = () => {
      stopped = true;
      window.clearInterval(mirrorTimer); window.clearInterval(beatTimer);
      window.removeEventListener('focus', syncFomoToken);
      window.removeEventListener('visibilitychange', syncFomoToken);
      document.removeEventListener('visibilitychange', beat);
      try { chrome.runtime.onMessage.removeListener(onSync); } catch { /* 旧上下文 */ }
    };
})();
