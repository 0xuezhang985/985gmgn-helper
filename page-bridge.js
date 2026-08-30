(() => {
  'use strict';

  if (window.__gdhPageBridgeStarted) return;
  window.__gdhPageBridgeStarted = true;

  // 插件的持仓价格计算复用 GMGN 页面原生 token_stat 行情流。MAIN world 才能读取
  // GMGN 自己的 localStorage 登录态，所以 App 通知开关也在这里请求；桥接层只透出
  // SOL/BSC/Base 的布尔开关，不复制令牌，也不新开第二条 WebSocket。
  const TOKEN_STAT_ATTRIBUTE = 'data-gdh-token-stat';
  const TOKEN_STAT_EVENT = 'gdh-token-stat';
  const HOLDING_CONFIG_REQUEST_EVENT = 'gdh-holding-config-request';
  const HOLDING_CONFIG_RESULT_EVENT = 'gdh-holding-config-result';
  const HOLDING_CONFIG_RESULT_ATTRIBUTE = 'data-gdh-holding-config-result';
  const HOLDING_CONFIG_URL = 'https://gmgn.ai/api/v1/notification/user_config_list';
  const nativeWebSocket = window.WebSocket;
  const tokenStatChains = new WeakMap();
  let holdingConfigInflight = null;

  function normalizeTokenStatAddress(value) {
    const raw = String(value || '');
    if (/^0x[a-fA-F0-9]{40}$/.test(raw)) return raw.toLowerCase();
    return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(raw) ? raw : '';
  }

  function emitHoldingConfigResult(result) {
    if (!document.documentElement) return;
    document.documentElement.setAttribute(HOLDING_CONFIG_RESULT_ATTRIBUTE, JSON.stringify(result));
    document.dispatchEvent(new Event(HOLDING_CONFIG_RESULT_EVENT));
    document.documentElement.removeAttribute(HOLDING_CONFIG_RESULT_ATTRIBUTE);
  }

  function gmgnPageAccessToken() {
    try {
      const parsed = JSON.parse(window.localStorage.getItem('tgInfo') || 'null');
      const token = parsed?.token?.access_token;
      return typeof token === 'string' && token.length > 20 ? token : '';
    } catch {
      return '';
    }
  }

  function gmgnPageApiQuery() {
    try {
      const src = performance.getEntriesByType('resource')
        .map((entry) => entry.name)
        .find((url) => url.includes('gmgn.ai/') && url.includes('device_id='));
      return src?.split('?')[1] || '';
    } catch {
      return '';
    }
  }

  function sanitizeHoldingConfig(payload) {
    const candidates = [payload, payload?.data, payload?.result];
    const rows = candidates.find((value) => Array.isArray(value));
    if (!rows) return null;
    const allowed = new Set(['sol', 'bsc', 'base']);
    const sanitized = [];
    for (const row of rows) {
      const chain = String(row?.push_chain || '').trim().toLowerCase();
      const dict = row?.push_switch_dict;
      if (!allowed.has(chain) || !dict || typeof dict !== 'object'
        || !Object.prototype.hasOwnProperty.call(dict, 'holding_signal')) continue;
      sanitized.push({
        push_chain: chain,
        push_switch_dict: { holding_signal: dict.holding_signal },
      });
    }
    return sanitized.length ? sanitized : null;
  }

  async function fetchHoldingConfig() {
    const token = gmgnPageAccessToken();
    if (!token) return emitHoldingConfigResult({ ok: false, reason: 'login-required', stage: 'token' });
    let query = gmgnPageApiQuery();
    // content script 在 document_idle 就会请求；冷启动时 GMGN 自己第一条带客户端参数的
    // API 可能还没进入 resource timing。最多等 5 秒，不把这个时序差误报成接口故障。
    for (let attempt = 0; !query && attempt < 20; attempt += 1) {
      await new Promise((resolve) => window.setTimeout(resolve, 250));
      query = gmgnPageApiQuery();
    }
    if (!query) return emitHoldingConfigResult({ ok: false, reason: 'unavailable', stage: 'query' });
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch(`${HOLDING_CONFIG_URL}?${query}`, {
        method: 'POST',
        credentials: 'include',
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${token}`,
          'Cache-Control': 'no-cache',
          'Content-Type': 'application/json',
        },
        // 官方 getNotiUserConfig(accountId) 默认发送空对象并返回全部链。
        body: '{}',
      });
      const body = await response.json().catch(() => null);
      const data = response.ok && (body?.code === undefined || body?.code === 0)
        ? sanitizeHoldingConfig(body) : null;
      if (!data) {
        emitHoldingConfigResult({
          ok: false,
          reason: response.status === 401 || response.status === 403 ? 'login-required' : 'unavailable',
          stage: 'response',
          status: response.status,
        });
        return;
      }
      emitHoldingConfigResult({ ok: true, data });
    } catch {
      emitHoldingConfigResult({ ok: false, reason: 'unavailable', stage: 'fetch' });
    } finally {
      window.clearTimeout(timeout);
    }
  }

  document.addEventListener(HOLDING_CONFIG_REQUEST_EVENT, () => {
    if (holdingConfigInflight) return;
    holdingConfigInflight = fetchHoldingConfig()
      .finally(() => { holdingConfigInflight = null; });
  });

  function rememberTokenStatSubscription(socket, data) {
    if (typeof data !== 'string' || !data.includes('token_stat')) return;
    let message;
    try { message = JSON.parse(data); } catch { return; }
    if (message?.channel !== 'token_stat' || !Array.isArray(message.data)) return;
    const chains = tokenStatChains.get(socket) || new Map();
    for (const item of message.data) {
      const chain = String(item?.chain || item?.c || '').trim().toLowerCase();
      const addresses = Array.isArray(item?.addresses) ? item.addresses : [item?.addresses || item?.address || item?.a];
      for (const rawAddress of addresses) {
        const address = normalizeTokenStatAddress(rawAddress);
        if (!address) continue;
        if (message.action === 'unsubscribe') chains.delete(address);
        else if (message.action === 'subscribe' && chain) chains.set(address, chain);
      }
    }
    tokenStatChains.set(socket, chains);
  }

  function forwardTokenStatMessage(socket, data) {
    if (typeof data !== 'string' || !data.includes('token_stat')) return;
    let message;
    try { message = JSON.parse(data); } catch { return; }
    if (message?.channel !== 'token_stat' || !Array.isArray(message.data)) return;
    const chains = tokenStatChains.get(socket);
    const items = message.data.slice(0, 200).map((raw) => {
      const address = normalizeTokenStatAddress(raw?.a || raw?.address);
      const chain = String(raw?.c || raw?.chain || chains?.get(address) || '').trim().toLowerCase();
      const price = Number(raw?.p ?? raw?.price);
      const price5m = Number(raw?.p5m ?? raw?.price_5m);
      const pct5m = Number(raw?.pcp5m ?? raw?.price_change_percent5m);
      if (!address || !chain || !(price > 0) || (!(price5m > 0) && !Number.isFinite(pct5m))) return null;
      return { chain, address, price, price5m: price5m > 0 ? price5m : 0, pct5m: Number.isFinite(pct5m) ? pct5m : null };
    }).filter(Boolean);
    if (!items.length || !document.documentElement) return;
    document.documentElement.setAttribute(TOKEN_STAT_ATTRIBUTE, JSON.stringify(items));
    document.dispatchEvent(new Event(TOKEN_STAT_EVENT));
    document.documentElement.removeAttribute(TOKEN_STAT_ATTRIBUTE);
  }

  if (typeof nativeWebSocket === 'function') {
    window.WebSocket = new Proxy(nativeWebSocket, {
      construct(Target, args) {
        const socket = new Target(...args);
        socket.addEventListener('message', (event) => forwardTokenStatMessage(socket, event.data));
        const nativeSend = socket.send;
        socket.send = function gdhTokenStatSend(data) {
          rememberTokenStatSubscription(socket, data);
          return nativeSend.call(socket, data);
        };
        return socket;
      },
    });
  }

  // 战壕卡：GMGN 自己写的 testid 优先，构建期的 sentry 标记作兼容
  // （实测有用户页面上一个 data-sentry-* 都没有，只认后者会让整块功能哑掉）
  const CARD_SELECTOR =
    '[data-testid="trench-token-card"], [data-sentry-source-file="TokenItem.tsx"][href*="/token/0x"]';
  const CALLOUT_SELECTOR = '[data-sentry-component="CalloutItem"]';
  const MANIFESTO_SELECTOR = '[data-sentry-component="ManifestoChipInner"]';
  // 持仓面板行：data-sentry-component 是构建期标记，实测有用户页面完全没有它
  // （追踪流/钱包/徽章都因此栽过）。这里同时用「行内含代币页链接」反查兜底。
  const HOLDING_ROW_SELECTOR = '[data-sentry-component="SmToken"]';
  // 兜底只在持仓面板内找：全站扫 a[href*="/token/"] 会把战壕卡、搜索结果
  // 也当成持仓行收进暴涨提醒清单，弹出"自己根本没有的币"。
  // 锚点取自真实页面实测：持仓行的 data-sentry-source-file 是
  // PositionTableColumns{Sol,Evm,...}.tsx，外层是 <table> + virtuoso 滚动容器。
  const HOLDING_PANEL_SELECTOR = '[data-sentry-source-file^="PositionTable"], [data-sentry-source-file="Holding.tsx"]';
  const HOLDING_ROW_FALLBACK = 'a[href*="/token/"]';
  const TRACKER_ITEM_SELECTOR = '[data-sentry-component="TrackerListItem"]';
  // 代币页「持有者」表格的行（实测自线上 DOM，不是紧凑列表的 HolderItemView）
  const HOLDER_ROW_SELECTOR = '[data-testid="token-detail-holders-row"]';
  const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
  let scanScheduled = false;

  function normalizeAddress(value) {
    return typeof value === 'string' && ADDRESS_RE.test(value)
      ? value.toLowerCase()
      : '';
  }

  function getCardAddress(card) {
    const direct = card.getAttribute('data-gmgn-fee-mode-card');
    if (normalizeAddress(direct)) return direct.toLowerCase();

    // 链段不能写死 bsc：在 /robinhood/token/、/base/token/ 等页面上，
    // 写死会取不到地址 → 整张战壕卡被跳过 → Dev 战绩、创建者数据全不渲染。
    const match = (card.getAttribute('href') || '').match(
      /\/[a-z0-9]+\/token\/(0x[a-fA-F0-9]{40})/i,
    );
    return match ? match[1].toLowerCase() : '';
  }

  function toTokenData(value, expectedAddress) {
    if (!value || typeof value !== 'object') return null;

    const candidates = [
      value,
      value.data,
      value.item,
      value.token,
      value.base_token_info,
    ];

    for (const candidate of candidates) {
      if (!candidate || typeof candidate !== 'object') continue;
      const address = normalizeAddress(candidate.address);
      const creator = normalizeAddress(candidate.creator);
      if (address !== expectedAddress || !creator) continue;

      return {
        address,
        creator,
        symbol: String(candidate.symbol || ''),
        migrated: candidate.creator_created_open_count,
        total: candidate.creator_created_count,
        ratio: candidate.creator_created_open_ratio,
      };
    }
    return null;
  }

  function searchProps(root, expectedAddress) {
    const seen = new WeakSet();
    const queue = [{ value: root, depth: 0 }];
    let budget = 900;

    while (queue.length && budget > 0) {
      const { value, depth } = queue.shift();
      if (!value || (typeof value !== 'object' && typeof value !== 'function')) {
        continue;
      }
      if (seen.has(value)) continue;
      seen.add(value);
      budget -= 1;

      const tokenData = toTokenData(value, expectedAddress);
      if (tokenData) return tokenData;
      if (depth >= 5 || value instanceof Node) continue;

      let keys;
      try {
        keys = Object.keys(value);
      } catch {
        continue;
      }

      for (const key of keys.slice(0, 120)) {
        if (['_owner', 'return', 'child', 'sibling', 'alternate', 'stateNode'].includes(key)) {
          continue;
        }
        let child;
        try {
          child = value[key];
        } catch {
          continue;
        }
        if (child && (typeof child === 'object' || typeof child === 'function')) {
          queue.push({ value: child, depth: depth + 1 });
        }
      }
    }
    return null;
  }

  function readTokenData(card, expectedAddress) {
    const fiberKey = Object.keys(card).find((key) => key.startsWith('__reactFiber$'));
    if (!fiberKey) return null;

    let fiber = card[fiberKey];
    for (let level = 0; fiber && level < 18; level += 1) {
      for (const node of [fiber, fiber.alternate]) {
        if (!node) continue;
        for (const props of [node.memoizedProps, node.pendingProps]) {
          const direct = toTokenData(props, expectedAddress);
          if (direct) return direct;
          const nested = searchProps(props, expectedAddress);
          if (nested) return nested;
        }
      }
      fiber = fiber.return;
    }
    return null;
  }

  function toCallerData(value, kind) {
    if (!value || typeof value !== 'object') return null;
    const item = value.item && typeof value.item === 'object' ? value.item : value;

    if (kind === 'manifesto') {
      const wallet = normalizeAddress(item.callerWallet);
      const handle = String(item.callerHandle || '').trim().replace(/^@/, '');
      if (!wallet && !handle) return null;
      return {
        wallet,
        handle,
        name: String(item.callerName || handle || '').trim(),
        ulid: String(item.ulid || '').trim(),
        tokenAddress: normalizeAddress(item.tokenAddress),
        tokenSymbol: String(item.tokenSymbol || '').trim().slice(0, 32),
        text: String(item.sourceContent || '').trim().slice(0, 200),
        amountUsd: String(item.amountUsd || '').trim().slice(0, 12),
        avatar: /^https:\/\//.test(String(item.callerAvatar || '')) ? String(item.callerAvatar).slice(0, 300) : '',
        verified: String(item.isBlueVerified) === 'true' ? '1' : '',
        multiplier: String(item.multiplier || '').trim().slice(0, 20),
        timeMs: String(item.declareCreateTime || (Number(item.createTime) ? Number(item.createTime) * 1000 : '')).trim(),
      };
    }

    const maker = item.maker_info && typeof item.maker_info === 'object'
      ? item.maker_info
      : item;
    const wallet = normalizeAddress(maker.address);
    const handle = String(
      item.twitter_username || maker.twitter_username || '',
    ).trim().replace(/^@/, '');
    if (!wallet && !handle) return null;
    return {
      wallet,
      handle,
      name: String(
        item.nick_name || maker.name || item.twitter_name || maker.twitter_name || handle || '',
      ).trim(),
    };
  }

  function readCallerData(element, kind) {
    const fiberKey = Object.keys(element).find((key) => key.startsWith('__reactFiber$'));
    if (fiberKey) {
      let fiber = element[fiberKey];
      for (let level = 0; fiber && level < 18; level += 1) {
        for (const node of [fiber, fiber.alternate]) {
          if (!node) continue;
          for (const props of [node.memoizedProps, node.pendingProps]) {
            const data = toCallerData(props, kind);
            if (data) return data;
          }
        }
        fiber = fiber.return;
      }
    }

    if (kind === 'manifesto') {
      const match = (element.textContent || '').match(/@([A-Za-z0-9_]+)/);
      return match ? { wallet: '', handle: match[1], name: match[1] } : null;
    }

    const addressLink = element.querySelector('a[href*="/address/0x"]');
    const match = addressLink?.getAttribute('href')?.match(/\/address\/(0x[a-fA-F0-9]{40})/);
    if (!match) return null;
    return {
      wallet: match[1].toLowerCase(),
      handle: '',
      name: String(addressLink.textContent || '').trim(),
    };
  }

  function setAttribute(card, name, value) {
    if (value == null || value === '') {
      card.removeAttribute(name);
      return;
    }
    const text = String(value);
    if (card.getAttribute(name) !== text) card.setAttribute(name, text);
  }

  function clearTokenData(card) {
    for (const name of [
      'data-gdh-ready',
      'data-gdh-creator',
      'data-gdh-symbol',
      'data-gdh-migrated',
      'data-gdh-total',
      'data-gdh-ratio',
    ]) {
      card.removeAttribute(name);
    }
  }

  function scanCard(card) {
    // 这层护栏只为把范围限定在战壕三列；页面不带 sentry 标记时，
    // 卡片自身的 testid 已经足够说明它就是战壕卡，不能因为没有护栏就整个跳过
    if (!card.closest('[data-sentry-component="PumpSubX"]')
      && !card.matches('[data-testid="trench-token-card"]')) return;
    const address = getCardAddress(card);
    if (!address) return;

    const data = readTokenData(card, address);
    if (!data) {
      clearTokenData(card);
      return;
    }

    setAttribute(card, 'data-gdh-ready', '1');
    setAttribute(card, 'data-gdh-creator', data.creator);
    setAttribute(card, 'data-gdh-symbol', data.symbol);
    setAttribute(card, 'data-gdh-migrated', data.migrated);
    setAttribute(card, 'data-gdh-total', data.total);
    setAttribute(card, 'data-gdh-ratio', data.ratio);
  }

  function clearCallerData(element) {
    for (const name of [
      'data-gdh-caller-ready',
      'data-gdh-caller-wallet',
      'data-gdh-caller-handle',
      'data-gdh-caller-name',
      'data-gdh-mani-ulid',
      'data-gdh-mani-token',
      'data-gdh-mani-symbol',
      'data-gdh-mani-text',
      'data-gdh-mani-usd',
      'data-gdh-mani-avatar',
      'data-gdh-mani-verified',
      'data-gdh-mani-mult',
      'data-gdh-mani-time',
    ]) {
      element.removeAttribute(name);
    }
  }

  function scanCallerElement(element, kind) {
    const data = readCallerData(element, kind);
    if (!data) {
      clearCallerData(element);
      return;
    }

    setAttribute(element, 'data-gdh-caller-ready', '1');
    setAttribute(element, 'data-gdh-caller-wallet', data.wallet);
    setAttribute(element, 'data-gdh-caller-handle', data.handle);
    setAttribute(element, 'data-gdh-caller-name', data.name);
    if (kind === 'manifesto') {
      setAttribute(element, 'data-gdh-mani-ulid', data.ulid);
      setAttribute(element, 'data-gdh-mani-token', data.tokenAddress);
      setAttribute(element, 'data-gdh-mani-symbol', data.tokenSymbol);
      setAttribute(element, 'data-gdh-mani-text', data.text);
      setAttribute(element, 'data-gdh-mani-usd', data.amountUsd);
      setAttribute(element, 'data-gdh-mani-avatar', data.avatar);
      setAttribute(element, 'data-gdh-mani-verified', data.verified);
      setAttribute(element, 'data-gdh-mani-mult', data.multiplier);
      setAttribute(element, 'data-gdh-mani-time', data.timeMs);
    }
  }

  /** 持仓面板行：从 fiber 取 {chain,address,symbol}，供插件缓存持仓清单。 */
  /**
   * 这一仓的「每币平均成本」。GMGN 当前 holdings 接口返回
   * balance / accu_amount / accu_cost / accu_fee，线上分包的成本含手续费口径是
   * `(accu_cost + accu_fee) / accu_amount`。不能拿 accu_cost / balance：部分卖出后
   * balance 会变小，而累计买入数量不变，那样会把成本凭空放大。
   */
  function readHoldingCost(hit) {
    const num = (v) => {
      const n = Number(v);
      return Number.isFinite(n) && n > 0 ? n : 0;
    };
    const nonNegative = (v) => {
      const n = Number(v);
      return Number.isFinite(n) && n >= 0 ? n : 0;
    };
    const balance = num(hit.balance) || num(hit.amount_cur) || num(hit.amount);
    if (!balance) return 0; // 已清仓只剩 history_* 时不是当前持仓
    const accuAmount = num(hit.accu_amount);
    const accuCost = num(hit.accu_cost);
    if (accuAmount && accuCost) return (accuCost + nonNegative(hit.accu_fee)) / accuAmount;
    const direct = num(hit.avg_cost);
    if (direct) return direct;
    const total = num(hit.total_cost) || num(hit.cost) || num(hit.accu_cost);
    if (total) return total / balance;
    // 仅兼容仍把当前均价放在 history_avg_cost 的旧构建；上面的 balance 守卫确保
    // 真正的已清仓历史记录不会进入提醒清单。
    return num(hit.history_avg_cost);
  }

  function readHoldingToken(element) {
    const fiberKey = Object.keys(element).find((key) => key.startsWith('__reactFiber$'));
    if (!fiberKey) return null;
    const pick = (value, depth) => {
      if (!value || typeof value !== 'object' || depth > 4) return null;
      // 光有 {chain,address,symbol} 不够——战壕卡/搜索结果的代币对象也长这样,
      // 曾把满屏别人的币当成"我的持仓"报暴涨。必须再带一个"我的余额"类字段。
      if (value.address && value.symbol && value.chain
        && (value.balance !== undefined || value.usd_value !== undefined
          || value.amount !== undefined || value.holding !== undefined
          || value.unrealized_profit !== undefined)) return value;
      let keys;
      try { keys = Object.keys(value); } catch { return null; }
      for (const key of keys.slice(0, 50)) {
        if (['_owner', 'return', 'child', 'sibling', 'alternate', 'stateNode'].includes(key)) continue;
        let child;
        try { child = value[key]; } catch { continue; }
        if (child && typeof child === 'object') {
          const hit = pick(child, depth + 1);
          if (hit) return hit;
        }
      }
      return null;
    };
    let fiber = element[fiberKey];
    for (let level = 0; fiber && level < 16; level += 1) {
      for (const node of [fiber, fiber.alternate]) {
        if (!node) continue;
        for (const props of [node.memoizedProps, node.pendingProps]) {
          const hit = pick(props, 0);
          if (hit) {
            return {
              chain: String(hit.chain || '').slice(0, 16),
              address: String(hit.address || '').slice(0, 64),
              symbol: String(hit.symbol || '').slice(0, 24),
              cost: readHoldingCost(hit),
            };
          }
        }
      }
      fiber = fiber.return;
    }
    return null;
  }

  /**
   * 追踪事件卡：字段名取自 GMGN 自己的 TrackerListItem.tsx（分包 2085-*.js）——
   * base_address / base_symbol 是被交易的那个币，quote_* 是计价币（WBNB 之类），
   * 另有 token_address 与 chain。不靠 href 也不靠猜。
   */
  function readTrackerRecord(element) {
    const fiberKey = Object.keys(element).find((key) => key.startsWith('__reactFiber$'));
    if (!fiberKey) return null;
    const pick = (value, depth) => {
      if (!value || typeof value !== 'object' || depth > 4) return null;
      if (typeof value.base_address === 'string' && value.base_address) return value;
      let keys;
      try { keys = Object.keys(value); } catch { return null; }
      for (const key of keys.slice(0, 50)) {
        if (['_owner', 'return', 'child', 'sibling', 'alternate', 'stateNode'].includes(key)) continue;
        let child;
        try { child = value[key]; } catch { continue; }
        if (child && typeof child === 'object') {
          const hit = pick(child, depth + 1);
          if (hit) return hit;
        }
      }
      return null;
    };
    let fiber = element[fiberKey];
    for (let level = 0; fiber && level < 16; level += 1) {
      for (const node of [fiber, fiber.alternate]) {
        if (!node) continue;
        for (const props of [node.memoizedProps, node.pendingProps]) {
          const hit = pick(props, 0);
          if (hit) {
            return {
              address: String(hit.token_address || hit.base_address || '').slice(0, 64),
              symbol: String(hit.base_symbol || '').slice(0, 24),
              chain: String(hit.chain || '').slice(0, 16),
              // maker = 这条推送的钱包地址。GMGN 改版后卡片里的钱包名不一定还是
              // <a href="/address/0x..."> 了，只靠 DOM 取地址会整段失效。
              maker: String(hit.maker || '').slice(0, 64),
              nick: String(hit.nick_name || hit.maker_info?.name || '').slice(0, 32),
              // 事件时间。链上记录里是秒（前端拿它 +86400 秒当过期线），这里统一成毫秒；
              // 数值不在合理区间就当没有，锚定逻辑会整体降级，不会拿脏数据乱摆。
              ts: (() => {
                const n = Number(hit.timestamp);
                if (n > 1.4e9 && n < 4.1e9) return Math.round(n * 1000);
                if (n > 1.4e12 && n < 4.1e12) return Math.round(n);
                return 0;
              })(),
            };
          }
        }
      }
      fiber = fiber.return;
    }
    return null;
  }

  function scanTrackerCard(element) {
    const data = readTrackerRecord(element);
    if (data && data.address) {
        setAttribute(element, 'data-gdh-track-addr', data.address);
      if (data.symbol) setAttribute(element, 'data-gdh-track-symbol', data.symbol);
      else element.removeAttribute('data-gdh-track-symbol');
      if (data.maker) setAttribute(element, 'data-gdh-track-maker', data.maker);
      else element.removeAttribute('data-gdh-track-maker');
      if (data.nick) setAttribute(element, 'data-gdh-track-nick', data.nick);
      else element.removeAttribute('data-gdh-track-nick');
      if (data.ts) setAttribute(element, 'data-gdh-track-ts', String(data.ts));
      else element.removeAttribute('data-gdh-track-ts');
      return;
    }
    // 兜底：卡片本身是 next/link 渲染的 <a>，href 里可能带代币地址
    const href = element.getAttribute('href') || '';
    const match = href.match(/\/([a-z0-9]+)\/token\/(0x[a-fA-F0-9]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})/);
    if (match) setAttribute(element, 'data-gdh-track-addr', match[2]);
    else element.removeAttribute('data-gdh-track-addr');
    element.removeAttribute('data-gdh-track-symbol');
  }

  function scanHoldingRow(element) {
    const data = readHoldingToken(element);
    if (!data || !data.chain || !data.address) {
      element.removeAttribute('data-gdh-hold-chain');
      element.removeAttribute('data-gdh-hold-addr');
      element.removeAttribute('data-gdh-hold-symbol');
      element.removeAttribute('data-gdh-hold-cost');
      return;
    }
    setAttribute(element, 'data-gdh-hold-chain', data.chain);
    setAttribute(element, 'data-gdh-hold-addr', data.address);
    setAttribute(element, 'data-gdh-hold-symbol', data.symbol);
    if (data.cost > 0) setAttribute(element, 'data-gdh-hold-cost', String(data.cost));
  }

  /**
   * 代币页「持有者」表格行：字段实测自线上 DOM 的 React fiber ——
   * { address, balance（持币数量）, amount_percentage（小数占比）, usd_value, ... }。
   * 只把排序要用的持币数量和地址透出来，供插入 fomo 持仓者时定位。
   */
  function scanHolderRow(element) {
    const fiberKey = Object.keys(element).find((key) => key.startsWith('__reactFiber$'));
    if (!fiberKey) return;
    const pick = (value, depth) => {
      if (!value || typeof value !== 'object' || depth > 4) return null;
      if (typeof value.address === 'string' && value.address && value.balance !== undefined) return value;
      let keys;
      try { keys = Object.keys(value); } catch { return null; }
      for (const key of keys.slice(0, 50)) {
        if (['_owner', 'return', 'child', 'sibling', 'alternate', 'stateNode'].includes(key)) continue;
        let child;
        try { child = value[key]; } catch { continue; }
        if (child && typeof child === 'object') {
          const hit = pick(child, depth + 1);
          if (hit) return hit;
        }
      }
      return null;
    };
    let fiber = element[fiberKey];
    for (let level = 0; fiber && level < 12; level += 1) {
      for (const node of [fiber, fiber.alternate]) {
        if (!node) continue;
        for (const props of [node.memoizedProps, node.pendingProps]) {
          const hit = pick(props, 0);
          if (hit) {
            setAttribute(element, 'data-gdh-holder-addr', String(hit.address).slice(0, 64));
            setAttribute(element, 'data-gdh-holder-balance', String(hit.balance ?? ''));
            // 行里没有 total_supply，但 amount_percentage 是小数占比，可反推总量
            if (hit.amount_percentage !== undefined) setAttribute(element, 'data-gdh-holder-pct', String(hit.amount_percentage));
            return;
          }
        }
      }
      fiber = fiber.return;
    }
  }

  // 虚拟列表滚动时每帧回收/重建行，mutation 风暴会让 fiber 深遍历（每卡 16 层
  // ×50 键×4 层递归）每帧全量跑——这是整页发粘的大头。rAF 合帧，滚动中降频。
  // 声明必须在 scanCards 之前：它在函数体里赋值，声明放后面会命中 TDZ，
  // 导致 scanCards 每次都从第一行崩掉（持仓行/追踪卡标记全部失效）。
  let scanRafId = 0;
  let lastScanAt = 0;
  let scrollingUntil = 0;

  function scanCards() {
    scanScheduled = false;
    scanRafId = 0;
    const holdingRows = new Set(document.querySelectorAll(HOLDING_ROW_SELECTOR));
    // 兜底：持仓面板里指向代币页的链接，往上找到能读出 {chain,address,symbol} 的那层。
    // fiber 读不到就不标记，不会误伤别处（战壕/搜索的链接读不出这三件套）。
    // 锚元素本身可能就是行（PositionTable* 打在行上），向上取到表格/滚动容器再扫
    const panels = new Set();
    document.querySelectorAll(HOLDING_PANEL_SELECTOR).forEach((anchor) => {
      panels.add(anchor.closest('table, [data-testid="virtuoso-scroller"]') || anchor);
    });
    panels.forEach((panel) => {
      panel.querySelectorAll(HOLDING_ROW_FALLBACK).forEach((link) => {
        if (link.closest(HOLDING_ROW_SELECTOR)) return;
        let el = link;
        for (let level = 0; level < 4 && el instanceof HTMLElement; level += 1) {
          if (readHoldingToken(el)) { holdingRows.add(el); return; }
          el = el.parentElement;
        }
      });
    });
    holdingRows.forEach(scanHoldingRow);
    // 同上：sentry 标记不一定在，用 GMGN 自己的 testid 反查卡片
    const trackerSeen = new Set();
    document.querySelectorAll(TRACKER_ITEM_SELECTOR).forEach((el) => trackerSeen.add(el));
    document.querySelectorAll('[data-testid="follow-tracking-row-symbol"]').forEach((cell) => {
      const tagged = cell.closest(TRACKER_ITEM_SELECTOR);
      if (tagged) return void trackerSeen.add(tagged);
      let el = cell.parentElement;
      for (let level = 0; level < 6 && el; level += 1) {
        if (el.querySelector('[data-testid="follow-tracking-row-maker"]')) { trackerSeen.add(el); return; }
        el = el.parentElement;
      }
    });
    trackerSeen.forEach(scanTrackerCard);
    document.querySelectorAll(HOLDER_ROW_SELECTOR).forEach(scanHolderRow);
    document.querySelectorAll(CARD_SELECTOR).forEach(scanCard);
    document.querySelectorAll(CALLOUT_SELECTOR).forEach((element) => {
      scanCallerElement(element, 'callout');
    });
    document.querySelectorAll(MANIFESTO_SELECTOR).forEach((element) => {
      scanCallerElement(element, 'manifesto');
    });
  }

  function runScheduledScan() {
    scanRafId = 0;
    const now = Date.now();
    if (now < scrollingUntil && now - lastScanAt < 150) {
      scanScheduled = false;
      scheduleScan();
      return;
    }
    lastScanAt = now;
    scanCards();
  }

  function scheduleScan() {
    if (scanScheduled) return;
    scanScheduled = true;
    if (scanRafId) return;
    scanRafId = window.requestAnimationFrame(runScheduledScan);
  }

  document.addEventListener('scroll', () => { scrollingUntil = Date.now() + 200; }, true);

  function startDomScanner() {
    if (!document.documentElement) return;
    const observer = new MutationObserver(scheduleScan);
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['href', 'data-gmgn-fee-mode-card'],
    });
    scheduleScan();
    window.setInterval(scheduleScan, 1200);
  }
  if (document.documentElement) startDomScanner();
  else document.addEventListener('DOMContentLoaded', startDomScanner, { once: true });

  // ---- 站内无刷新跳转（fomo 混排卡用）----
  // content script 在隔离世界摸不到 Next 的路由；这里代为调用 window.next.router.push，
  // 让点击 fomo 卡和点 GMGN 原生卡一样走客户端路由（不整页重载）。
  // URL 经 documentElement 的 attribute 传递（CustomEvent 的 detail 过不了世界边界），
  // 并用白名单限定只能跳代币页。
  const GDH_NAV_RE = /^\/(sol|bsc|eth|base|tron|blast|monad|megaeth|hyperevm|xlayer|robinhood|arc|stable|arbitrum)\/token\/[a-zA-Z0-9]{20,64}$/;
  document.addEventListener('gdh-navigate', () => {
    const url = document.documentElement.getAttribute('data-gdh-nav') || '';
    document.documentElement.removeAttribute('data-gdh-nav');
    if (!GDH_NAV_RE.test(url)) return;
    try {
      const router = window.next && window.next.router;
      if (router && typeof router.push === 'function') {
        Promise.resolve(router.push(url)).catch(() => window.location.assign(url));
        return;
      }
    } catch {
      // 摸不到路由就整页跳
    }
    window.location.assign(url);
  });
})();
