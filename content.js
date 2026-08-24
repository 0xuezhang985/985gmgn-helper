(() => {
  'use strict';

  if (window.__gdhContentStarted) return;
  window.__gdhContentStarted = true;

  // 在 fomo.family 上只做一件事：把你已登录的 fomo 访问令牌交给插件，
  // 供 GMGN 代币页的 fomo 浮窗读取该代币的观点/交易（fomo 接口必须带 Bearer）。
  // 令牌只存在浏览器本地，只会发给 fomo 自己的 API，不外传；之后不跑任何 GMGN 逻辑。
  if (location.hostname === 'fomo.family' || location.hostname.endsWith('.fomo.family')) {
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
    // 多账号登录时 privy 会把键加上用户命名空间（privy:<userId>:token），所以按模式扫而不是写死键名
    const readPrivy = () => {
      const out = { token: '', refresh: '' };
      try {
        for (const key of Object.keys(window.localStorage)) {
          if (!out.token && /^privy:(.+:)?token$/.test(key)) out.token = unwrap(window.localStorage.getItem(key));
          else if (!out.refresh && /^privy:(.+:)?refresh_token$/.test(key)) out.refresh = unwrap(window.localStorage.getItem(key));
        }
      } catch {
        // localStorage 不可用
      }
      return out;
    };
    const jwtExpMs = (token) => {
      try {
        const payload = JSON.parse(atob(String(token).split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
        return Number(payload.exp) > 0 ? Number(payload.exp) * 1000 : 0;
      } catch {
        return 0;
      }
    };
    let lastSent = '';
    const syncFomoToken = () => {
      const { token, refresh } = readPrivy();
      // 读不到就什么都不做：未登录、privy 还没水合、切页面的空档都会短暂读空，
      // 以前这里会写 null，把一个还能用的令牌直接擦掉。
      if (!token) return;
      const stamp = `${token}|${refresh}`;
      if (stamp === lastSent) return;
      lastSent = stamp;
      try {
        chrome.storage.local.set({ fomoToken: { token, refresh, at: Date.now(), exp: jwtExpMs(token) } });
      } catch {
        // 扩展上下文失效
      }
    };
    syncFomoToken();
    window.setInterval(syncFomoToken, 20000);
    window.addEventListener('focus', syncFomoToken);
    return;
  }

  // 战壕卡：GMGN 自己写的 testid 优先，构建期的 sentry 标记作兼容
  // （实测有用户页面上一个 data-sentry-* 都没有，只认后者会让整块功能哑掉）
  const CARD_SELECTOR =
    '[data-testid="trench-token-card"], [data-sentry-source-file="TokenItem.tsx"][href^="/bsc/token/"]';
  const CALLOUT_SELECTOR = '[data-sentry-component="CalloutItem"]';
  const MANIFESTO_SELECTOR = '[data-sentry-component="ManifestoChipInner"]';
  const DEFAULTS = {
    enabled: true,
    showDevPerformance: true,
    showDevTooltip: true,
    enableDevBookmark: true,
    enableCalloutBlacklist: true,
    enableManifestoToast: true,
    enableManifestoTab: true,
    enableSpecialWallet: true,
    enableRemindAlert: true,
    enableFomoPanel: true,
    fomoPanelPos: null,
    fomoTranslate: true,
    fomoPanelOpen: false,
    enableHoldingSurge: true,
    holdingSurgeThreshold: 20,
    holdingSurgeCooldown: 60,
    holdingWatchList: [],
    addWalletStarPref: { on: false, color: '#f5b83d', pin: false },
    hideLightningTrade: true,
    watchedDevs: [],
    blockedCallers: [],
    blockedTokens: [],
    mergeFomoHolders: true,
    markedHolders: [
      { address: '0x38e47fece3ea323e864c65410f6458c820eaa897', name: '奶牛' },
      { address: '0xbf004bff64725914ee36d03b87d6965b0ced4903', name: '阿峰' },
      { address: '0x2ce9d43d1cba6ae31d7f07bfe0098dfa2d833373', name: '枯坐' },
    ],
    enableMarkedHolders: true,
    enableFlapTax: true,
    flapRpc: '',
    specialWallets: [],
    highlightColor: '#f5b83d',
  };

  let settings = { ...DEFAULTS };
  let watchedMap = new Map();
  let blockedWallets = new Set();
  let blockedHandles = new Set();
  // 特别关注高亮预设色（每个钱包可单独循环切换，首个为默认金色）。
  const SPECIAL_COLOR_PALETTE = [
    '#f5b83d',
    '#ef5350',
    '#43c07a',
    '#4c9ffe',
    '#b48ae0',
    '#ed6ba4',
    '#3ec6c6',
  ];
  let specialWalletMap = new Map();
  let scanScheduled = false;
  let scrollScanTimer = 0;
  let calloutToastTimer = 0;
  let blacklistModalOpen = false;
  let activeCard = null;
  let tooltip = null;

  // Dev 历史最高市值：gmgn.ai/api/v1/dev_created_tokens（同源，带会话，免配置）。
  const DEV_ATH_TTL_MS = 5 * 60 * 1000;
  const DEV_ATH_ERROR_RETRY_MS = 60 * 1000;
  const DEV_ATH_GAP_MS = 250;
  const DEV_ATH_QS =
    'device_id=&client_id=gmgn_web&from_app=gmgn&app_ver=&tz_name=Asia%2FShanghai&tz_offset=28800&app_lang=zh-CN&os=web';
  const devAthCache = new Map();
  const devAthQueue = [];
  const devAthQueued = new Set();
  let devAthTimer = 0;

  function getDevAth(creator) {
    if (!creator) return null;
    const hit = devAthCache.get(creator);
    const fresh = hit
      && Date.now() - hit.at < (hit.ok ? DEV_ATH_TTL_MS : DEV_ATH_ERROR_RETRY_MS);
    if (!fresh && !devAthQueued.has(creator)) {
      devAthQueued.add(creator);
      devAthQueue.push(creator);
      if (!devAthTimer) devAthTimer = window.setTimeout(processDevAthQueue, 50);
    }
    return hit && hit.ok && hit.mc > 0 ? hit : null;
  }

  async function processDevAthQueue() {
    devAthTimer = 0;
    if (settings.showDevPerformance === false) {
      devAthQueue.length = 0;
      devAthQueued.clear();
      return;
    }
    const creator = devAthQueue.shift();
    if (!creator) return;
    let entry = { at: Date.now(), ok: false, mc: 0, symbol: '' };
    try {
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), 10000);
      const res = await fetch(
        `https://gmgn.ai/api/v1/dev_created_tokens/bsc/${creator}?${DEV_ATH_QS}`,
        { credentials: 'include', signal: controller.signal },
      );
      window.clearTimeout(timeout);
      const body = await res.json().catch(() => null);
      if (res.ok && body?.code === 0) {
        const info = body.data?.creator_ath_info;
        entry = {
          at: Date.now(),
          ok: true,
          mc: Number(info?.ath_mc) || 0,
          symbol: String(info?.token_symbol || '').slice(0, 24),
        };
      }
    } catch {
      // 网络失败静默降级：峰段不显示，60s 后允许重试。
    }
    devAthCache.set(creator, entry);
    devAthQueued.delete(creator);
    if (entry.ok && entry.mc > 0) scheduleScan();
    if (devAthQueue.length) devAthTimer = window.setTimeout(processDevAthQueue, DEV_ATH_GAP_MS);
  }

  function formatAthMc(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return '';
    const fmt = (v) => (v < 10 ? v.toFixed(1).replace(/\.0$/, '') : String(Math.round(v)));
    if (n >= 1e9) return `$${fmt(n / 1e9)}B`;
    if (n >= 1e6) return `$${fmt(n / 1e6)}M`;
    if (n >= 1e3) return `$${fmt(n / 1e3)}K`;
    return `$${Math.round(n)}`;
  }

  function athTierClass(value) {
    const n = Number(value) || 0;
    if (n >= 1e7) return 'gdh-mc-t4';
    if (n >= 1e6) return 'gdh-mc-t3';
    if (n >= 1e5) return 'gdh-mc-t2';
    return 'gdh-mc-t1';
  }

  function normalizeAddress(value) {
    return typeof value === 'string' ? value.toLowerCase() : '';
  }

  function normalizeHandle(value) {
    return typeof value === 'string' ? value.trim().replace(/^@/, '').toLowerCase() : '';
  }

  function rebuildWatchedMap() {
    watchedMap = new Map(
      (Array.isArray(settings.watchedDevs) ? settings.watchedDevs : [])
        .filter((item) => item && typeof item.address === 'string')
        .map((item) => [
          normalizeAddress(item.address),
          { address: normalizeAddress(item.address), label: String(item.label || '') },
        ]),
    );
  }

  function normalizeBlockedCaller(item) {
    if (!item || typeof item !== 'object') return null;
    const wallet = normalizeAddress(item.wallet);
    const handle = normalizeHandle(item.handle);
    if (!wallet && !handle) return null;
    return {
      wallet,
      handle,
      name: String(item.name || item.handle || item.wallet || '').trim(),
    };
  }

  function getBlockedCallers() {
    return (Array.isArray(settings.blockedCallers) ? settings.blockedCallers : [])
      .map(normalizeBlockedCaller)
      .filter(Boolean);
  }

  function rebuildBlockedCallerIndex() {
    const callers = getBlockedCallers();
    blockedWallets = new Set(callers.map((item) => item.wallet).filter(Boolean));
    blockedHandles = new Set(callers.map((item) => item.handle).filter(Boolean));
  }

  function normalizeSpecialColor(color) {
    if (color === 'rainbow') return 'rainbow';
    if (/^#[0-9a-fA-F]{6}$/.test(String(color || ''))) return String(color).toLowerCase();
    return SPECIAL_COLOR_PALETTE[0];
  }

  function rebuildSpecialWalletSet() {
    specialWalletMap = new Map(
      (Array.isArray(settings.specialWallets) ? settings.specialWallets : [])
        .map((item) => {
          const address = normalizeAddress(item?.address);
          if (!address) return null;
          return [address, {
            label: String(item?.label || ''),
            color: normalizeSpecialColor(item?.color),
            pin: item?.pin === true,
          }];
        })
        .filter(Boolean),
    );
  }

  function formatCount(value) {
    if (value == null || value === '') return '--';
    const number = Number(value);
    return Number.isFinite(number) ? Math.trunc(number).toLocaleString('zh-CN') : '--';
  }

  function getRatioPercent(card) {
    const migrated = card.dataset.gdhMigrated === undefined
      ? Number.NaN
      : Number(card.dataset.gdhMigrated);
    const total = card.dataset.gdhTotal === undefined
      ? Number.NaN
      : Number(card.dataset.gdhTotal);
    if (Number.isFinite(migrated) && Number.isFinite(total) && total > 0) {
      return (migrated / total) * 100;
    }

    const rawRatio = card.dataset.gdhRatio === undefined
      ? Number.NaN
      : Number(card.dataset.gdhRatio);
    if (!Number.isFinite(rawRatio)) return Number.NaN;
    return rawRatio <= 1 ? rawRatio * 100 : rawRatio;
  }

  function formatRatio(card) {
    const percent = getRatioPercent(card);
    if (!Number.isFinite(percent)) return '--';
    if (percent === 0) return '0%';
    if (percent < 0.1) return '<0.1%';
    if (percent < 10) return `${percent.toFixed(1).replace(/\.0$/, '')}%`;
    return `${Math.round(percent)}%`;
  }

  function applyRateColor(performance, percent) {
    const rateKey = Number.isFinite(percent) ? percent.toFixed(6) : 'unknown';
    if (performance.dataset.gdhRateKey === rateKey) return;
    performance.dataset.gdhRateKey = rateKey;

    if (!Number.isFinite(percent)) {
      performance.style.setProperty('--gdh-rate-color', '#8b93a1');
      performance.style.setProperty('--gdh-rate-border', 'rgba(139, 147, 161, 0.38)');
      performance.style.setProperty('--gdh-rate-bg', 'rgba(139, 147, 161, 0.07)');
      performance.style.setProperty('--gdh-rate-glow', 'transparent');
      return;
    }

    const strength = Math.min(1, Math.log1p(Math.max(0, percent)) / Math.log1p(20));
    const saturation = Math.round(18 + (82 * strength));
    const lightness = Math.round(44 + (24 * strength));
    const borderAlpha = (0.34 + (0.56 * strength)).toFixed(2);
    const backgroundAlpha = (0.06 + (0.13 * strength)).toFixed(2);
    const glowAlpha = (0.28 * strength).toFixed(2);
    const color = `hsl(42 ${saturation}% ${lightness}%)`;

    performance.style.setProperty('--gdh-rate-color', color);
    performance.style.setProperty(
      '--gdh-rate-border',
      `hsl(42 ${saturation}% ${lightness}% / ${borderAlpha})`,
    );
    performance.style.setProperty(
      '--gdh-rate-bg',
      `hsl(42 ${saturation}% ${lightness}% / ${backgroundAlpha})`,
    );
    performance.style.setProperty(
      '--gdh-rate-glow',
      `hsl(42 ${saturation}% ${lightness}% / ${glowAlpha})`,
    );
  }

  function clearWatchState(card) {
    delete card.dataset.gdhWatched;
    delete card.dataset.gdhHighlighted;
    delete card.dataset.gdhBadge;
    delete card.dataset.gdhWatchLabel;
    if (card === activeCard) {
      activeCard = null;
      tooltip?.classList.remove('gdh-tooltip--visible');
    }
  }

  function applyDevPerformance(card) {
    const details = card.children[1]?.firstElementChild;
    const metricsRow = details
      ? [...details.children].find((element) => {
        const className = String(element.className);
        return className.includes('h-[24px]')
          && className.includes('font-medium')
          && className.includes('overflow-hidden');
      })
      : null;

    let performance = card.querySelector('.gdh-dev-performance');
    if (settings.showDevPerformance === false || !metricsRow || card.dataset.gdhReady !== '1') {
      performance?.remove();
      return;
    }

    if (!performance) {
      performance = document.createElement('span');
      performance.className = 'gdh-dev-performance';
      metricsRow.prepend(performance);
    }

    const migrated = formatCount(card.dataset.gdhMigrated);
    const total = formatCount(card.dataset.gdhTotal);
    const ratio = formatRatio(card);
    applyRateColor(performance, getRatioPercent(card));

    const ath = getDevAth(normalizeAddress(card.dataset.gdhCreator));
    const rateText = `迁${migrated}发${total}·${ratio}`;
    const mcText = ath ? `峰${formatAthMc(ath.mc)}` : '';
    const tier = ath ? athTierClass(ath.mc) : '';
    const signature = `${rateText}|${mcText}|${tier}`;
    if (performance.dataset.gdhSig !== signature) {
      performance.dataset.gdhSig = signature;
      performance.textContent = '';
      const rateEl = document.createElement('span');
      rateEl.textContent = rateText;
      performance.appendChild(rateEl);
      if (mcText) {
        const sep = document.createElement('span');
        sep.className = 'gdh-dev-performance__sep';
        sep.textContent = '·';
        const mcEl = document.createElement('span');
        mcEl.className = `gdh-dev-performance__mc ${tier}`;
        mcEl.textContent = mcText;
        performance.append(sep, mcEl);
      }
    }
    performance.title = `Dev 发币迁移数：${migrated}\nDev 发币总数：${total}\nDev 发币迁移比例：${ratio}${
      ath ? `\nDev 最高市值币：${ath.symbol || '未知'} ${formatAthMc(ath.mc)}` : ''
    }`;
  }

  function getDeveloperPanelContexts() {
    return [...document.querySelectorAll('div')]
      .filter((element) => (
        element.children.length === 0
        && element.textContent?.trim() === '代币统计'
        && element.getClientRects().length > 0
      ))
      .map((heading) => {
        const container = heading.parentElement;
        const creatorLink = [...container.querySelectorAll('a[href^="/bsc/address/"]')]
          .find((link) => /^\/bsc\/address\/0x[a-fA-F0-9]{40}$/.test(link.getAttribute('href') || ''));
        const match = creatorLink?.getAttribute('href')?.match(/\/bsc\/address\/(0x[a-fA-F0-9]{40})$/);
        const symbolElement = document.querySelector('#token-base-symbol[data-symbol]');
        const symbol = String(symbolElement?.dataset.symbol || symbolElement?.textContent || '').trim();
        if (!container || !match || !symbol) return null;
        return {
          container,
          creator: match[1].toLowerCase(),
          label: `${symbol}dev`,
          insertAfter: container.querySelector('[data-sentry-component="DevFundsSource"]'),
        };
      })
      .filter(Boolean);
  }

  function updateDeveloperButton(button) {
    const address = normalizeAddress(button.dataset.gdhDevAddress);
    const saved = watchedMap.get(address);
    const nextText = saved
      ? `✓ 已收藏 · ${saved.label || address}`
      : '☆ 一键收藏 Dev';
    button.classList.toggle('is-saved', Boolean(saved));
    if (button.textContent !== nextText) button.textContent = nextText;
    button.title = saved
      ? `已收藏 ${address}`
      : `收藏 GMGN Dev ${address}`;
  }

  function saveDeveloper(button) {
    const address = normalizeAddress(button.dataset.gdhDevAddress);
    const label = String(button.dataset.gdhDevLabel || '').trim();
    if (!address || !label) return;

    const current = Array.isArray(settings.watchedDevs) ? settings.watchedDevs : [];
    const next = [
      ...current.filter((item) => normalizeAddress(item?.address) !== address),
      { address, label },
    ];

    button.disabled = true;
    button.textContent = '正在收藏…';
    chrome.storage.local.set({ watchedDevs: next }, () => {
      button.disabled = false;
      const error = chrome.runtime?.lastError;
      if (error) {
        button.textContent = '收藏失败，请重试';
        button.title = error.message;
        return;
      }
      settings.watchedDevs = next;
      rebuildWatchedMap();
      updateDeveloperButton(button);
      scheduleScan();
    });
  }

  function ensureDeveloperBookmarkButtons() {
    if (settings.enableDevBookmark === false) {
      document.querySelectorAll('.gdh-dev-save-button').forEach((button) => button.remove());
      return;
    }

    for (const context of getDeveloperPanelContexts()) {
      let button = context.container.querySelector(':scope > .gdh-dev-save-button');
      if (!button) {
        button = document.createElement('button');
        button.type = 'button';
        button.className = 'gdh-dev-save-button';
        button.addEventListener('click', (event) => {
          event.preventDefault();
          event.stopPropagation();
          saveDeveloper(button);
        });
        if (context.insertAfter) context.insertAfter.insertAdjacentElement('afterend', button);
        else context.container.appendChild(button);
      }
      button.dataset.gdhDevAddress = context.creator;
      button.dataset.gdhDevLabel = context.label;
      updateDeveloperButton(button);
    }
  }

  function applyCardState(card) {
    // 这层护栏只为把范围限定在战壕三列；页面不带 sentry 标记时，
    // 卡片自身的 testid 已经足够说明它就是战壕卡，不能因为没有护栏就整个跳过
    if (!card.closest('[data-sentry-component="PumpSubX"]')
      && !card.matches('[data-testid="trench-token-card"]')) return;

    applyDevPerformance(card);

    const creator = normalizeAddress(card.dataset.gdhCreator);
    const watched = watchedMap.get(creator);
    const highlightEnabled = settings.enabled !== false;
    const tooltipEnabled = settings.showDevTooltip !== false;
    if (!watched || (!highlightEnabled && !tooltipEnabled)) {
      clearWatchState(card);
      return;
    }

    card.dataset.gdhWatched = '1';
    card.dataset.gdhWatchLabel = watched.label;
    if (highlightEnabled) {
      card.dataset.gdhHighlighted = '1';
      card.dataset.gdhBadge = watched.label ? `★ ${watched.label}` : '★ 重点 DEV';
    } else {
      delete card.dataset.gdhHighlighted;
      delete card.dataset.gdhBadge;
    }
  }

  function getCallerFromElement(element) {
    return normalizeBlockedCaller({
      wallet: element.dataset.gdhCallerWallet,
      handle: element.dataset.gdhCallerHandle,
      name: element.dataset.gdhCallerName,
    });
  }

  function callersMatch(left, right) {
    return Boolean(
      (left.wallet && right.wallet && left.wallet === right.wallet)
      || (left.handle && right.handle && left.handle === right.handle),
    );
  }

  function isCallerBlocked(caller) {
    return Boolean(
      settings.enableCalloutBlacklist !== false
      &&
      caller
      && ((caller.wallet && blockedWallets.has(caller.wallet))
        || (caller.handle && blockedHandles.has(caller.handle))),
    );
  }

  function findCalloutHeading(scope) {
    return [...scope.querySelectorAll('span')].find((element) => (
      element.children.length === 0 && element.textContent?.trim() === '喊单'
    ));
  }

  function getCalloutPanelContext() {
    // 2026-08-07 之前的构建：面板根节点带 GlobalCalloutPanel 标记。
    const panel = document.querySelector('[data-sentry-component="GlobalCalloutPanel"]');
    if (panel) {
      const heading = findCalloutHeading(panel);
      const header = heading?.parentElement?.parentElement;
      const controls = header?.children[1];
      if (!heading || !header || !controls) return null;
      return { panel, header, controls };
    }

    // 2026-08-08 GMGN 改版去掉了 GlobalCalloutPanel：改从喊单面板的
    // tab 按钮（我的 / GMGN全部）定位，再用同面板内的“喊单”标题确认。
    for (const tab of document.querySelectorAll('button[data-sentry-component="renderTab"]')) {
      const tabsRow = tab.parentElement?.parentElement;
      const headerBlock = tabsRow?.parentElement;
      const header = headerBlock?.children[0];
      const root = headerBlock?.parentElement;
      if (!header || !root || header === tabsRow) continue;
      const heading = findCalloutHeading(header);
      const controls = heading ? header.children[1] : null;
      if (!heading || !controls) continue;
      return { panel: root, header, controls };
    }
    return null;
  }

  function showCalloutToast(text) {
    const context = getCalloutPanelContext();
    if (!context) return;
    let toast = context.panel.querySelector(':scope > .gdh-callout-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.className = 'gdh-callout-toast';
      context.panel.appendChild(toast);
    }
    toast.textContent = text;
    window.clearTimeout(calloutToastTimer);
    calloutToastTimer = window.setTimeout(() => toast.remove(), 1800);
  }

  function persistBlockedCallers(next, successMessage) {
    const previous = getBlockedCallers();
    settings.blockedCallers = next;
    rebuildBlockedCallerIndex();
    scanCalloutBlacklist();

    chrome.storage.local.set({ blockedCallers: next }, () => {
      const error = chrome.runtime?.lastError;
      if (error) {
        settings.blockedCallers = previous;
        rebuildBlockedCallerIndex();
        scanCalloutBlacklist();
        showCalloutToast('黑名单保存失败');
        return;
      }
      showCalloutToast(successMessage);
    });
  }

  function blockCaller(caller) {
    if (!caller) return;
    const next = [
      ...getBlockedCallers().filter((item) => !callersMatch(item, caller)),
      caller,
    ];
    const label = caller.handle ? `@${caller.handle}` : caller.name || caller.wallet;
    persistBlockedCallers(next, `已屏蔽 ${label}`);
  }

  function unblockCaller(caller) {
    const next = getBlockedCallers().filter((item) => !callersMatch(item, caller));
    const label = caller.handle ? `@${caller.handle}` : caller.name || caller.wallet;
    persistBlockedCallers(next, `已解除 ${label}`);
  }

  function renderBlacklistModal(modal) {
    const callers = getBlockedCallers();
    const key = JSON.stringify(callers);
    if (modal.dataset.gdhBlacklistKey === key) return;
    modal.dataset.gdhBlacklistKey = key;

    const list = modal.querySelector('.gdh-callout-blacklist-list');
    list.replaceChildren();
    if (!callers.length) {
      const empty = document.createElement('div');
      empty.className = 'gdh-callout-blacklist-empty';
      empty.textContent = '暂未屏蔽任何喊单人';
      list.appendChild(empty);
      return;
    }

    for (const caller of callers) {
      const item = document.createElement('div');
      item.className = 'gdh-callout-blacklist-item';

      const identity = document.createElement('div');
      identity.className = 'gdh-callout-blacklist-identity';
      const name = document.createElement('strong');
      name.textContent = caller.name || (caller.handle ? `@${caller.handle}` : caller.wallet);
      const details = document.createElement('span');
      const wallet = caller.wallet
        ? `${caller.wallet.slice(0, 8)}…${caller.wallet.slice(-6)}`
        : '';
      details.textContent = [caller.handle ? `@${caller.handle}` : '', wallet]
        .filter(Boolean)
        .join(' · ');
      identity.append(name, details);

      const removeButton = document.createElement('button');
      removeButton.type = 'button';
      removeButton.className = 'gdh-callout-unblock-button';
      removeButton.textContent = '解除';
      removeButton.addEventListener('pointerdown', (event) => event.stopPropagation());
      removeButton.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        unblockCaller(caller);
      });

      item.append(identity, removeButton);
      list.appendChild(item);
    }
  }

  function ensureBlacklistModal(panel) {
    let modal = panel.querySelector(':scope > .gdh-callout-blacklist-modal');
    if (!blacklistModalOpen) {
      modal?.remove();
      return;
    }

    if (!modal) {
      modal = document.createElement('section');
      modal.className = 'gdh-callout-blacklist-modal';
      modal.addEventListener('pointerdown', (event) => event.stopPropagation());

      const header = document.createElement('div');
      header.className = 'gdh-callout-blacklist-header';
      const title = document.createElement('strong');
      title.textContent = '喊单黑名单';
      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'gdh-callout-blacklist-close';
      close.textContent = '×';
      close.title = '关闭黑名单';
      close.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        blacklistModalOpen = false;
        modal.remove();
        scheduleScan();
      });
      header.append(title, close);

      const list = document.createElement('div');
      list.className = 'gdh-callout-blacklist-list';
      modal.append(header, list);
      panel.appendChild(modal);
    }
    renderBlacklistModal(modal);
  }

  function ensureCalloutControls() {
    const context = getCalloutPanelContext();
    if (!context) return;
    context.panel.classList.add('gdh-callout-panel-host');

    let button = context.controls.querySelector(':scope > .gdh-callout-blacklist-button');
    if (!button) {
      button = document.createElement('button');
      button.type = 'button';
      button.className = 'gdh-callout-blacklist-button';
      button.title = '管理喊单黑名单';
      button.addEventListener('pointerdown', (event) => event.stopPropagation());
      button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        blacklistModalOpen = !blacklistModalOpen;
        if (blacklistModalOpen) maniListOpen = false;
        scheduleScan();
      });
      context.controls.prepend(button);
    }

    const count = getBlockedCallers().length;
    const text = count ? `黑名单 ${count}` : '黑名单';
    if (button.textContent !== text) button.textContent = text;
    button.classList.toggle('is-active', blacklistModalOpen);
    ensureBlacklistModal(context.panel);
  }

  function ensureCalloutBlockButton(card) {
    const addressView = card.querySelector('[data-sentry-component="WalletAddressView"]');
    const addressLink = addressView?.closest('a[href*="/address/0x"]');
    const titleRow = addressLink?.parentElement;
    if (!titleRow) return;

    let button = titleRow.querySelector(':scope > .gdh-callout-block-button');
    if (!button) {
      button = document.createElement('button');
      button.type = 'button';
      button.className = 'gdh-callout-block-button';
      button.textContent = '屏蔽';
      button.title = '一键屏蔽此喊单人';
      button.addEventListener('pointerdown', (event) => event.stopPropagation());
      button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        blockCaller(getCallerFromElement(card));
      });
      titleRow.appendChild(button);
    }
  }

  function applyCalloutCardState(card) {
    const host = card.closest('.gmgn-vlist-item') || card;
    if (host.dataset.gdhCalloutHost !== '1') host.dataset.gdhCalloutHost = '1';
    const caller = getCallerFromElement(card);
    const blocked = isCallerBlocked(caller);
    if (blocked) host.dataset.gdhCallerBlocked = '1';
    else delete host.dataset.gdhCallerBlocked;
    if (caller) ensureCalloutBlockButton(card);
  }

  function applyManifestoState(chip) {
    const blocked = isCallerBlocked(getCallerFromElement(chip));
    if (blocked) chip.dataset.gdhCallerBlocked = '1';
    else delete chip.dataset.gdhCallerBlocked;
  }

  // ---- Flap 代币税收徽章 ----
  // 数据全部由用户浏览器直连公开 BSC RPC 读链上合约得到，不经任何第三方服务。
  // 只处理 Flap 系代币（地址以 7777 / 8888 结尾）。
  const FLAP_ADDR_RE = /^0x[a-fA-F0-9]{36}(?:7777|8888)$/;
  const flapInfoCache = new Map();
  const flapPending = new Set();

  /** 按税收去向判定模式，与展示图标一一对应。 */
  function flapMode(dist) {
    if (!dist) return { icon: '❓', name: '未知', cls: 'unknown' };
    const vault = dist.vault.reduce((sum, x) => sum + x.bps, 0);
    const parts = [
      { bps: dist.dividendBps, icon: '💎', name: '持币分红', cls: 'holder' },
      { bps: dist.lpBps, icon: '💧', name: '加池子', cls: 'lp' },
      { bps: dist.deflationBps, icon: '🔥', name: '销毁通缩', cls: 'burn' },
      { bps: vault, icon: '🎁', name: '金库/营销', cls: 'gift' },
    ].filter((x) => x.bps > 0).sort((a, b) => b.bps - a.bps);
    if (!parts.length) return { icon: '❓', name: '无分配', cls: 'unknown' };
    if (parts.length > 1) return { icon: parts[0].icon, name: '混合分配', cls: 'hybrid', multi: parts.length };
    return parts[0];
  }

  const flapPct = (bps) => `${(Number(bps || 0) / 100).toFixed(Number(bps) % 100 ? 2 : 0)}%`;
  const flapShort = (addr) => (addr && !/^0x0+$/.test(addr) ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : '—');

  /** 徽章正文：优先把「分红给哪个币」这种最有用的信息直接显示出来。 */
  function flapBadgeText(info, mode) {
    const d = info.dist;
    if (d && d.dividendBps > 0) {
      const sym = info.dividendSymbol || '分红';
      return `${mode.icon}${sym} ${flapPct(d.dividendBps)}`;
    }
    if (d && d.lpBps > 0 && d.lpBps >= Math.max(d.deflationBps, ...d.vault.map((v) => v.bps), 0)) {
      const sym = info.quoteSymbol ? `${info.tokenSymbol || ''}/${info.quoteSymbol}` : '加池';
      return `${mode.icon}${sym} ${flapPct(d.lpBps)}`;
    }
    if (d && d.deflationBps > 0) return `${mode.icon}销毁 ${flapPct(d.deflationBps)}`;
    const vault = d ? d.vault.reduce((a, b) => a + b.bps, 0) : 0;
    if (vault > 0) return `${mode.icon}金库 ${flapPct(vault)}`;
    return `${mode.icon}${flapPct(info.taxBps)}`;
  }

  function flapTooltipText(info) {
    const d = info.dist;
    const pair = info.tokenSymbol && info.quoteSymbol
      ? `${info.tokenSymbol}/${info.quoteSymbol}` : '';
    const lines = [
      `总税率 ${flapPct(info.taxBps)}（买 ${flapPct(info.buyTaxBps)} / 卖 ${flapPct(info.sellTaxBps)}）`,
    ];
    if (d) {
      lines.push('—— 税收分配 ——');
      if (d.dividendBps) {
        const sym = info.dividendSymbol ? `${info.dividendSymbol} ` : '';
        lines.push(`💎 持币分红 ${flapPct(d.dividendBps)}　分红资产 ${sym}${flapShort(d.dividendToken)}`);
      }
      if (d.lpBps) lines.push(`💧 加池子 ${flapPct(d.lpBps)}`);
      if (d.deflationBps) lines.push(`🔥 销毁通缩 ${flapPct(d.deflationBps)}`);
      d.vault.forEach((v, i) => {
        if (v.bps) lines.push(`🎁 金库${d.vault.length > 1 ? i + 1 : ''} ${flapPct(v.bps)}　${flapShort(v.address)}`);
      });
      if (d.commissionBps) lines.push(`平台抽成 ${flapPct(d.commissionBps)}`);
    }
    lines.push(`底池 ${pair ? pair + '　' : ''}${flapShort(info.mainPool)}`);
    lines.push('数据直读链上，未经任何第三方服务');
    return lines.join('\n');
  }

  /** GMGN 原生的税率小标签：文案形如 Tax 2% / Tax 2%/5%。 */
  function findNativeTaxChip(card) {
    return [...card.querySelectorAll('div,span')].find((el) => (
      el.children.length === 0 && /^Tax\s*[\d.]+%(\s*\/\s*[\d.]+%)?$/i.test((el.textContent || '').trim())
    )) || null;
  }

  /** 在币名那一行下面开一行专门放徽章；这一行由插件自己创建和维护。 */
  function flapOwnRow(card, native) {
    let existing = card.querySelector(':scope .gdh-flap-row');
    if (existing) return existing;

    // 以原生税标所在的那一行为锚；没有税标就退到卡片信息区的第一行
    let anchor = native;
    if (anchor) {
      const cardWidth = card.getBoundingClientRect().width || 1;
      for (let level = 0; level < 4 && anchor.parentElement && anchor.parentElement !== card; level += 1) {
        anchor = anchor.parentElement;
        if (anchor.getBoundingClientRect().width > cardWidth * 0.6) break;
      }
    } else {
      anchor = card.children[1]?.firstElementChild?.firstElementChild || null;
    }
    if (!anchor || !anchor.parentElement) return null;

    const line = document.createElement('div');
    line.className = 'gdh-flap-row';
    anchor.insertAdjacentElement('afterend', line);
    return line;
  }

  function ensureFlapBadge(host, token, native) {
    const info = flapInfoCache.get(token);
    let badge = host.querySelector(':scope > .gdh-flap');
    if (!info || info.ok === false) {
      if (info && info.ok === false) {
        badge?.remove();
        // 读不到就把原生标签还回去，别让人两头落空
        if (native) native.style.removeProperty('display');
      }
      return;
    }
    // 信息比原生的全，藏掉原生税标避免重复（读不到数据时上面已还原）
    if (native && native.isConnected) native.style.setProperty('display', 'none', 'important');
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'gdh-flap';
      host.appendChild(badge);
    }
    const mode = flapMode(info.dist);
    badge.className = `gdh-flap is-${mode.cls}`;
    badge.textContent = flapBadgeText(info, mode);
    badge.title = `${mode.name}\n${flapTooltipText(info)}`;
  }

  function requestFlapInfo(token) {
    if (flapInfoCache.has(token) || flapPending.has(token)) return;
    if (flapPending.size >= 4) return;
    flapPending.add(token);
    chrome.runtime.sendMessage({
      type: 'flap-token-info',
      payload: { token, rpc: String(settings.flapRpc || '').trim() },
    }).then((res) => {
      flapInfoCache.set(token, res || { ok: false });
    }).catch(() => {}).finally(() => {
      flapPending.delete(token);
      scheduleScan();
    });
  }

  function scanFlapBadges() {
    if (settings.enableFlapTax === false) {
      document.querySelectorAll('.gdh-flap').forEach((el) => el.remove());
      return;
    }
    const seen = new Set();
    const put = (host, token, native) => {
      if (!FLAP_ADDR_RE.test(token)) return;
      const key = token.toLowerCase();
      seen.add(key);
      if (!flapInfoCache.has(key)) return void requestFlapInfo(key);
      ensureFlapBadge(host, key, native);
    };

    // 战壕卡：优先接管 GMGN 原生的「Tax x%」——同一个位置、信息更全，
    // 按文案定位（不依赖构建期标记）；找不到就退到 Dev 战绩那一行并排显示。
    document.querySelectorAll(CARD_SELECTOR).forEach((card) => {
      const token = String(card.getAttribute('href') || '').match(/\/token\/(0x[a-fA-F0-9]{40})/)?.[1];
      if (!token) return;
      const native = findNativeTaxChip(card);
      // 币名那一行本来就挤（名称 + 税标 + 成交额 + 市值），塞进去会被裁掉，
      // 所以单独在它下面起一行放徽章。
      const row = flapOwnRow(card, native);
      put(row || card, token, native);
    });

    // 追踪推送卡：挂在币名那一行
    trackerCards().forEach((card) => {
      const token = card.dataset.gdhTrackAddr;
      if (!token) return;
      put(card.querySelector(TRACKER_SYMBOL_CELL) || card, token);
    });

    // 代币页：跟在页面标题后面
    const route = currentTokenRoute();
    if (route && FLAP_ADDR_RE.test(route.address)) {
      const title = document.querySelector('h1, [class*="text-[20px]"], [class*="text-2xl"]');
      if (title) put(title, route.address);
    }
  }

  // ---- 标注人物持仓徽章 ----
  // 反过来查：不去逐个代币问"持有人里有谁"（那是几十上百个请求），
  // 而是查这几个被标注的钱包各自持有哪些币（人数个请求，缓存复用），
  // 再给命中的代币卡片打上 👤N。
  const MARKED_TTL = 120000;
  let markedMap = new Map();      // 代币地址 -> [人名]
  let markedCache = { chain: '', at: 0 };
  let markedLoading = false;

  function getMarkedHolders() {
    return (Array.isArray(settings.markedHolders) ? settings.markedHolders : [])
      .filter((x) => x && typeof x.address === 'string' && /^0x[a-fA-F0-9]{40}$/.test(x.address));
  }

  function currentChain() {
    const m = location.pathname.match(/^\/([a-z0-9]+)\//);
    return m && m[1] in FOMO_NETWORK_ID ? m[1] : '';
  }

  async function loadMarkedHoldings() {
    const chain = currentChain();
    if (!chain) return;
    if (settings.enableMarkedHolders === false) return void (markedMap = new Map());
    const people = getMarkedHolders();
    if (!people.length) return void (markedMap = new Map());
    if (markedCache.chain === chain && Date.now() - markedCache.at < MARKED_TTL) return;
    if (markedLoading) return;
    markedLoading = true;
    const next = new Map();
    try {
      for (const person of people) {
        try {
          // 契约取自 GMGN 自己的取数代码：eth 链地址要小写
          const addr = chain === 'eth' ? person.address.toLowerCase() : person.address;
          const res = await fetch(`https://gmgn.ai/api/v1/wallet_holdings/${chain}/${addr}?limit=50`, {
            credentials: 'omit',
          });
          const body = await res.json().catch(() => null);
          const holdings = body?.data?.holdings || body?.holdings || [];
          for (const h of holdings) {
            const token = String(h?.token?.address || h?.address || '').toLowerCase();
            if (!token) continue;
            if (!next.has(token)) next.set(token, []);
            const list = next.get(token);
            if (!list.includes(person.name)) list.push(person.name);
          }
        } catch {
          // 单个人失败不影响其他人
        }
      }
      markedMap = next;
      markedCache = { chain, at: Date.now() };
    } finally {
      markedLoading = false;
    }
  }

  function ensureMarkedBadge(host, tokenAddress) {
    const names = markedMap.get(String(tokenAddress).toLowerCase());
    let badge = host.querySelector(':scope > .gdh-marked');
    if (!names || !names.length) {
      badge?.remove();
      return;
    }
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'gdh-marked';
      host.appendChild(badge);
    }
    badge.textContent = `👤${names.length}`;
    badge.title = `持有这个币的标注人物：${names.join('、')}`;
  }

  function scanMarkedBadges() {
    if (settings.enableMarkedHolders === false) {
      document.querySelectorAll('.gdh-marked').forEach((el) => el.remove());
      return;
    }
    loadMarkedHoldings();
    if (!markedMap.size) return;

    // 追踪推送卡：币名那一行（位置已在 0.25.1 实测确认）
    trackerCards().forEach((card) => {
      const addr = card.dataset.gdhTrackAddr;
      if (!addr) return;
      const row = card.querySelector(TRACKER_SYMBOL_CELL) || card;
      ensureMarkedBadge(row, addr);
    });

    // 搜索结果等其它地方：凡是指向代币页的链接都算一行，不依赖组件名
    document.querySelectorAll('a[href*="/token/0x"]').forEach((link) => {
      if (link.closest(TRACKER_ITEM_SELECTOR)) return;
      const m = link.getAttribute('href')?.match(/\/token\/(0x[a-fA-F0-9]{40})/);
      if (!m) return;
      ensureMarkedBadge(link, m[1]);
    });
  }

  // ---- 用 GMGN 持有者表的持仓量，给 fomo 持仓者标出「链上第几名」----
  // 不往 GMGN 那张表里插行：它是虚拟化的，每行各自绝对定位，插进去必然跟它抢布局。
  // 只读取它已加载行的持仓量，拿来给 fomo 浮窗里的人算排名。
  const HOLDER_ROW_SELECTOR = '[data-testid="token-detail-holders-row"]';
  let onchainBalances = { key: '', list: [], loaded: 0 };

  function refreshOnchainBalances() {
    const route = currentTokenRoute();
    if (!route) return;
    const rows = [...document.querySelectorAll(HOLDER_ROW_SELECTOR)];
    if (!rows.length) return;
    const list = rows
      .map((r) => Number(r.dataset.gdhHolderBalance))
      .filter((n) => Number.isFinite(n) && n > 0)
      .sort((a, b) => b - a);
    if (!list.length) return;
    const key = `${route.chain}|${route.address}`;
    // 表格是虚拟化的，一次只渲染可见的十几行；滚动时并进已知集合，覆盖面才会变大
    const merged = key === onchainBalances.key
      ? [...new Set([...onchainBalances.list, ...list])].sort((a, b) => b - a)
      : list;
    onchainBalances = { key, list: merged, loaded: merged.length };
  }

  /** 某个持仓量在链上持有者里排第几（只按已加载的行估算）。 */
  function onchainRank(amount) {
    if (!Number.isFinite(amount) || amount <= 0) return null;
    const route = currentTokenRoute();
    if (!route || onchainBalances.key !== `${route.chain}|${route.address}`) return null;
    const list = onchainBalances.list;
    if (!list.length) return null;
    let above = 0;
    for (const b of list) { if (b > amount) above += 1; else break; }
    const smallest = list[list.length - 1];
    // 比已加载的最小持仓还少时，只能说"在这些之外"，不能编一个名次
    return { rank: above + 1, exact: amount >= smallest, loaded: list.length };
  }

  function buildRankBadge(amount) {
    const info = onchainRank(amount);
    if (!info) return null;
    const el = document.createElement('span');
    el.className = 'gdh-fomo-rank';
    if (info.exact) {
      el.textContent = `链上#${info.rank}`;
      el.classList.toggle('is-top', info.rank <= 10);
      el.title = `按持仓量，在 GMGN 持有者里排第 ${info.rank} 名（已加载 ${info.loaded} 行）`;
    } else {
      el.textContent = `#${info.loaded}+`;
      el.classList.add('is-out');
      el.title = `持仓量小于已加载的 ${info.loaded} 行，名次在 ${info.loaded} 名之后。多滚动几屏 GMGN 持有者表可让排名更准`;
    }
    return el;
  }

  // ---- 追踪里屏蔽某个币 ----
  // 只影响追踪流的显示，不动 GMGN 自己的任何设置。
  let blockedTokenSet = new Set();

  function getBlockedTokens() {
    return (Array.isArray(settings.blockedTokens) ? settings.blockedTokens : [])
      .filter((item) => item && typeof item.address === 'string');
  }

  function rebuildBlockedTokenIndex() {
    blockedTokenSet = new Set(getBlockedTokens().map((item) => item.address.toLowerCase()));
  }

  function isTokenBlocked(address) {
    return Boolean(address && blockedTokenSet.has(String(address).toLowerCase()));
  }

  function persistBlockedTokens(next, message) {
    const previous = getBlockedTokens();
    settings.blockedTokens = next;
    rebuildBlockedTokenIndex();
    scanSpecialWallets();

    chrome.storage.local.set({ blockedTokens: next }, () => {
      const error = chrome.runtime?.lastError;
      if (error) {
        settings.blockedTokens = previous;
        rebuildBlockedTokenIndex();
        scanSpecialWallets();
        return;
      }
      showTrackToast(message);
    });
  }

  function toggleBlockedToken(address, symbol) {
    if (!address) return;
    const key = String(address).toLowerCase();
    const list = getBlockedTokens();
    if (blockedTokenSet.has(key)) {
      persistBlockedTokens(
        list.filter((item) => item.address.toLowerCase() !== key),
        `已恢复 ${symbol || '该币'} 的追踪推送`,
      );
      return;
    }
    persistBlockedTokens(
      [{ address: key, symbol: String(symbol || '').slice(0, 24), at: Date.now() }, ...list].slice(0, 300),
      `已屏蔽 ${symbol || '该币'}，可在 🚫 列表里恢复`,
    );
  }

  let trackToastTimer = 0;
  function showTrackToast(text) {
    const panel = document.querySelector('[data-sentry-component="WalletTrack"]');
    if (!panel || !text) return;
    let toast = panel.querySelector(':scope > .gdh-track-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.className = 'gdh-track-toast';
      panel.appendChild(toast);
    }
    toast.textContent = text;
    window.clearTimeout(trackToastTimer);
    trackToastTimer = window.setTimeout(() => toast.remove(), 2000);
  }

  /** 币名所在的叶子节点：拿 fiber 读到的 symbol 去比对渲染文本，命中才算，不靠类名猜。 */
  function findTrackerSymbolNode(card, symbol) {
    if (!symbol) return null;
    const target = symbol.trim();
    if (!target) return null;
    const nodes = card.querySelectorAll('span, div, p');
    for (const node of nodes) {
      if (node.querySelector('span, div, p')) continue;
      if (node.closest('a[href*="/address/0x"]')) continue;
      if ((node.textContent || '').trim() === target) return node;
    }
    return null;
  }

  /**
   * 折叠被屏蔽的推送。追踪流是 react-virtuoso：它用 ResizeObserver 量高，且会忽略
   * display:none 的测量结果，所以隐藏会留下占位空档；而 GMGN 在卡片外面到底套了
   * 几层壳、哪一层才是被量的那层，并不确定。这里不猜层数——从卡片往上，只要某一层
   * 「只包着这一张追踪卡」就说明它是这张卡的专属外壳，一并折叠；一旦某层里出现了
   * 别的追踪卡，那就是列表容器，停手。
   */
  function markBlockedHosts(card, blocked) {
    let el = card;
    for (let level = 0; level < 6 && el instanceof HTMLElement; level += 1) {
      if (blocked) el.dataset.gdhTokenBlocked = '1';
      else delete el.dataset.gdhTokenBlocked;
      const parent = el.parentElement;
      if (!parent) break;
      if (parent.querySelectorAll(TRACKER_ITEM_SELECTOR).length > 1) break;
      el = parent;
    }
  }

  function ensureTokenBlockButton(card, address, symbol) {
    let button = card.querySelector('.gdh-tokenblock');
    if (!button) {
      button = document.createElement('button');
      button.type = 'button';
      button.className = 'gdh-tokenblock';
      // 屏蔽要长按一秒才生效（这个按钮就在币名边上，单击太容易误触）；
      // 解除屏蔽是无害操作，保持单击即可。
      let holdTimer = 0;
      const cancelHold = () => {
        window.clearTimeout(holdTimer);
        holdTimer = 0;
        button.classList.remove('is-holding');
      };
      button.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (isTokenBlocked(button.dataset.gdhTbAddr || '')) return;
        button.classList.add('is-holding');
        holdTimer = window.setTimeout(() => {
          cancelHold();
          button.dataset.gdhTbFiredAt = String(Date.now());
          toggleBlockedToken(button.dataset.gdhTbAddr || '', button.dataset.gdhTbSymbol || '');
        }, 1000);
      });
      ['pointerup', 'pointerleave', 'pointercancel'].forEach((type) => {
        button.addEventListener(type, cancelHold);
      });
      button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        // 长按刚触发过，紧随其后的这一下 click 是它的尾巴，不能又把它解除。
        // 用时间戳而不是一次性标志：万一那下 click 没产生，标志会残留下来吃掉下一次点击。
        if (Date.now() - Number(button.dataset.gdhTbFiredAt || 0) < 500) return;
        if (isTokenBlocked(button.dataset.gdhTbAddr || '')) {
          toggleBlockedToken(button.dataset.gdhTbAddr || '', button.dataset.gdhTbSymbol || '');
        }
      });
      // 首选 GMGN 自己给币名那一行的 testid（取自其 TrackerListItem.tsx），最稳；
      // 其次按渲染文本匹配币名；都不行才退到动作文案后面。
      const symbolRow = card.querySelector(TRACKER_SYMBOL_CELL);
      const nameNode = symbolRow ? null : findTrackerSymbolNode(card, symbol);
      if (symbolRow) symbolRow.appendChild(button);
      else if (nameNode) nameNode.insertAdjacentElement('afterend', button);
      else {
        const fallback = findCardActionContainer(card);
        if (fallback) fallback.appendChild(button);
        else card.appendChild(button);
      }
    }
    button.dataset.gdhTbAddr = address;
    button.dataset.gdhTbSymbol = symbol || '';
    const blocked = isTokenBlocked(address);
    button.textContent = blocked ? '🔔' : '🚫';
    button.title = blocked
      ? `点一下恢复 ${symbol || '该币'} 在追踪里的推送`
      : `长按一秒，不再在追踪里显示 ${symbol || '该币'} 的推送`;
    button.classList.toggle('is-blocked', blocked);
  }

  // ---- 钱包追踪"特别关注"高亮 ----
  const TRACKER_ITEM_SELECTOR = '[data-sentry-component="TrackerListItem"]';
  const TRACKER_SYMBOL_CELL = '[data-testid="follow-tracking-row-symbol"]';
  const TRACKER_MAKER_CELL = '[data-testid="follow-tracking-row-maker"]';

  /**
   * 找出页面上的追踪推送卡。
   * 只认 data-sentry-component 是不够的：那是构建工具打的标记，GMGN 在某些布局/构建下
   * 并不带它（实测有用户页面上一个都没有，于是高亮/☆/🚫 整块失效）。这里同时用 GMGN
   * 自己写的 testid 反查——币名行和钱包行都在同一张卡里，往上找到同时包含这两者的
   * 那一层，就是卡片本身。
   */
  function trackerCards() {
    const found = new Set();
    document.querySelectorAll(TRACKER_ITEM_SELECTOR).forEach((el) => found.add(el));
    document.querySelectorAll(TRACKER_SYMBOL_CELL).forEach((cell) => {
      const tagged = cell.closest(TRACKER_ITEM_SELECTOR);
      if (tagged) return void found.add(tagged);
      let el = cell.parentElement;
      for (let level = 0; level < 6 && el instanceof HTMLElement; level += 1) {
        if (el.querySelector(TRACKER_MAKER_CELL)) return void found.add(el);
        el = el.parentElement;
      }
    });
    return [...found];
  }
  const WALLET_TABLE_SELECTOR = '[data-sentry-component="WalletTable"]';
  const TRACK_TAB_CELL = '[data-testid="follow-tracking-wallet-tab"], [data-testid="follow-tracking-tab"]';

  /**
   * 钱包列表所在的容器。和追踪卡同理：不能只认 data-sentry-component，
   * 实测有用户页面上这类构建期标记一个都没有。用 GMGN 自己的标签栏 testid 作锚，
   * 往上找到同时含有钱包地址链接的那一层作为扫描范围——既不依赖标记，也不会
   * 扩散到代币页的持有者表等别处的地址链接。
   */
  function walletTableScopes() {
    const scopes = new Set();
    document.querySelectorAll(WALLET_TABLE_SELECTOR).forEach((el) => scopes.add(el));
    document.querySelectorAll(TRACK_TAB_CELL).forEach((tab) => {
      let el = tab.parentElement;
      for (let level = 0; level < 8 && el instanceof HTMLElement; level += 1) {
        if (el.querySelector('a[href*="/address/0x"]')) return void scopes.add(el);
        el = el.parentElement;
      }
    });
    return [...scopes];
  }

  function extractRowWalletAddress(scope) {
    const link = scope.querySelector('a[href*="/address/0x"]');
    const match = link?.getAttribute('href')?.match(/\/address\/(0x[a-fA-F0-9]{40})/);
    if (match) return match[1].toLowerCase();
    // GMGN 改版后追踪卡里的钱包名不一定还是 /address/ 链接了；page-bridge 从卡片数据
    // 里读到的 maker 就是这条推送的钱包地址，拿它兜底，否则高亮/☆/🚫 会一起失效。
    const maker = scope.dataset?.gdhTrackMaker || '';
    return /^0x[a-fA-F0-9]{40}$/.test(maker) ? maker.toLowerCase() : '';
  }

  function extractRowWalletLabel(scope) {
    const link = scope.querySelector('a[href*="/address/0x"]');
    const text = String(link?.textContent || '').trim();
    return (text || scope.dataset?.gdhTrackNick || '').slice(0, 32);
  }

  function isSpecialWallet(address) {
    return Boolean(address && specialWalletMap.has(address));
  }

  function specialWalletColor(address) {
    return specialWalletMap.get(address)?.color || SPECIAL_COLOR_PALETTE[0];
  }

  function hexToRgba(hex, alpha) {
    const m = String(hex).match(/^#([0-9a-fA-F]{6})$/);
    if (!m) return `rgba(245, 184, 61, ${alpha})`;
    const n = parseInt(m[1], 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
  }

  function persistSpecialWallets(next) {
    const previous = Array.isArray(settings.specialWallets) ? settings.specialWallets : [];
    settings.specialWallets = next;
    rebuildSpecialWalletSet();
    scanSpecialWallets();
    chrome.storage.local.set({ specialWallets: next }, () => {
      const error = chrome.runtime?.lastError;
      if (error) {
        settings.specialWallets = previous;
        rebuildSpecialWalletSet();
        scanSpecialWallets();
      }
    });
  }

  function toggleSpecialWallet(address, label) {
    if (!address) return;
    const current = Array.isArray(settings.specialWallets) ? settings.specialWallets : [];
    const exists = current.some((item) => normalizeAddress(item?.address) === address);
    const next = exists
      ? current.filter((item) => normalizeAddress(item?.address) !== address)
      : [...current, { address, label: label || '', color: SPECIAL_COLOR_PALETTE[0] }];
    persistSpecialWallets(next);
  }

  function setSpecialWalletColor(address, color) {
    if (!address || !specialWalletMap.has(address)) return;
    if (color !== 'rainbow' && !/^#[0-9a-fA-F]{6}$/.test(String(color || ''))) return;
    const next = (Array.isArray(settings.specialWallets) ? settings.specialWallets : [])
      .map((item) => (
        normalizeAddress(item?.address) === address
          ? { ...item, color: normalizeSpecialColor(color) }
          : item
      ));
    persistSpecialWallets(next);
  }

  function setSpecialWalletPin(address, pin) {
    if (!address || !specialWalletMap.has(address)) return;
    const next = (Array.isArray(settings.specialWallets) ? settings.specialWallets : [])
      .map((item) => (
        normalizeAddress(item?.address) === address ? { ...item, pin: pin === true } : item
      ));
    persistSpecialWallets(next);
  }

  function addSpecialWallet(address, label, color, pin) {
    const normalized = normalizeAddress(address);
    if (!/^0x[a-f0-9]{40}$/.test(normalized) || specialWalletMap.has(normalized)) return false;
    const current = Array.isArray(settings.specialWallets) ? settings.specialWallets : [];
    persistSpecialWallets([
      ...current,
      {
        address: normalized,
        label: String(label || '').trim().slice(0, 32),
        color: normalizeSpecialColor(color),
        pin: pin === true,
      },
    ]);
    return true;
  }

  // ---- 预设色选择浮层（点色块展开全部颜色，点选即换）----
  let colorPaletteEl = null;

  function closeColorPalette() {
    colorPaletteEl?.remove();
    colorPaletteEl = null;
  }

  function openColorPalette(address, anchorRect) {
    closeColorPalette();
    const palette = document.createElement('div');
    palette.className = 'gdh-color-palette';
    palette.addEventListener('pointerdown', (event) => event.stopPropagation());
    const current = specialWalletColor(address);

    const colorsRow = document.createElement('div');
    colorsRow.className = 'gdh-color-palette__row';
    for (const color of SPECIAL_COLOR_PALETTE) {
      const dot = document.createElement('button');
      dot.type = 'button';
      dot.className = 'gdh-color-palette__dot';
      dot.style.background = color;
      dot.classList.toggle('is-current', color === current);
      dot.title = color;
      dot.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        setSpecialWalletColor(address, color);
        closeColorPalette();
      });
      colorsRow.appendChild(dot);
    }
    // 炫彩
    const rainbow = document.createElement('button');
    rainbow.type = 'button';
    rainbow.className = 'gdh-color-palette__dot gdh-color-palette__dot--rainbow';
    rainbow.classList.toggle('is-current', current === 'rainbow');
    rainbow.title = '炫彩高亮';
    rainbow.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      setSpecialWalletColor(address, 'rainbow');
      closeColorPalette();
    });
    colorsRow.appendChild(rainbow);
    // 自定义取色
    const custom = document.createElement('input');
    custom.type = 'color';
    custom.className = 'gdh-color-palette__custom';
    custom.value = current === 'rainbow' ? SPECIAL_COLOR_PALETTE[0] : current;
    custom.title = '自定义颜色';
    custom.addEventListener('change', () => {
      setSpecialWalletColor(address, custom.value);
      closeColorPalette();
    });
    colorsRow.appendChild(custom);
    palette.appendChild(colorsRow);

    // 置顶推送开关
    const pinRow = document.createElement('label');
    pinRow.className = 'gdh-color-palette__pin';
    const pinBox = document.createElement('input');
    pinBox.type = 'checkbox';
    pinBox.checked = specialWalletMap.get(address)?.pin === true;
    pinBox.addEventListener('change', () => {
      setSpecialWalletPin(address, pinBox.checked);
    });
    const pinText = document.createElement('span');
    pinText.textContent = '📌 新推送置顶 10 秒';
    pinRow.append(pinBox, pinText);
    palette.appendChild(pinRow);

    document.body.appendChild(palette);
    const width = palette.offsetWidth || 220;
    const left = Math.max(8, Math.min(window.innerWidth - width - 8, anchorRect.left - width / 2));
    let top = anchorRect.bottom + 6;
    const height = palette.offsetHeight || 60;
    if (top + height + 8 > window.innerHeight) top = anchorRect.top - height - 6;
    palette.style.left = `${Math.round(left)}px`;
    palette.style.top = `${Math.round(top)}px`;
    colorPaletteEl = palette;
  }

  document.addEventListener('pointerdown', (event) => {
    if (!colorPaletteEl) return;
    if (event.target instanceof Node && colorPaletteEl.contains(event.target)) return;
    closeColorPalette();
  }, true);
  document.addEventListener('scroll', () => closeColorPalette(), true);

  /** 追踪卡里"建仓/加仓/减仓/清仓"文案所在的 flex 容器（0.12.1 起 ⭐ 挂这里）。 */
  function findCardActionContainer(card) {
    const span = [...card.querySelectorAll('span')].find((el) => (
      el.children.length <= 1
      && /^(建仓|加仓|减仓|清仓)/.test((el.textContent || '').trim())
    ));
    return span?.parentElement instanceof HTMLElement ? span.parentElement : null;
  }

  function ensureStarButton(host, address, label, anchor, insertMode) {
    let button = host.querySelector('.gdh-star-button');
    if (!button) {
      button = document.createElement('button');
      button.type = 'button';
      button.className = 'gdh-star-button';
      button.addEventListener('pointerdown', (event) => event.stopPropagation());
      button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        toggleSpecialWallet(
          button.dataset.gdhStarAddr || '',
          button.dataset.gdhStarLabel || '',
        );
      });
      if (anchor instanceof HTMLElement && insertMode === 'after') {
        // 钱包列表行：贴在名字链接后面（占位恒定，悬停才显形）。
        button.classList.add('gdh-star-button--inline');
        anchor.insertAdjacentElement('afterend', button);
      } else if (anchor instanceof HTMLElement && insertMode === 'append') {
        // 追踪事件卡：跟在 加仓/减仓 等动作文案末尾。
        button.classList.add('gdh-star-button--inline');
        anchor.appendChild(button);
      } else {
        // 兜底：绝对定位在卡片右侧（找不到动作容器时）。
        host.appendChild(button);
      }
    }
    button.dataset.gdhStarAddr = address;
    button.dataset.gdhStarLabel = label;
    const starred = isSpecialWallet(address);
    const starColor = starred ? specialWalletColor(address) : '';
    const text = starred ? '★' : '☆';
    if (button.textContent !== text) button.textContent = text;
    button.classList.toggle('is-starred', starred);
    button.classList.toggle('gdh-rainbow-text', starColor === 'rainbow');
    button.style.color = starred && starColor !== 'rainbow' ? starColor : '';
    button.title = starred ? '取消特别关注' : '特别关注';

    // 已关注且按钮是行内挂载时，旁边给一个当前色小色块，点开预设色浮层选色。
    let swatch = host.querySelector('.gdh-color-button');
    if (starred && button.classList.contains('gdh-star-button--inline')) {
      if (!swatch) {
        swatch = document.createElement('button');
        swatch.type = 'button';
        swatch.className = 'gdh-color-button';
        swatch.addEventListener('pointerdown', (event) => event.stopPropagation());
        swatch.addEventListener('click', (event) => {
          event.preventDefault();
          event.stopPropagation();
          openColorPalette(
            swatch.dataset.gdhStarAddr || '',
            swatch.getBoundingClientRect(),
          );
        });
        button.insertAdjacentElement('afterend', swatch);
      }
      swatch.dataset.gdhStarAddr = address;
      applySwatchColor(swatch, specialWalletColor(address));
      swatch.title = '选择高亮颜色 / 置顶';
    } else {
      swatch?.remove();
    }
    return button;
  }

  function applySwatchColor(el, color) {
    if (color === 'rainbow') {
      el.style.background = 'conic-gradient(#ef5350, #f5b83d, #43c07a, #4c9ffe, #b48ae0, #ed6ba4, #ef5350)';
    } else {
      el.style.background = color;
    }
  }

  function applySpecialState(host, address) {
    if (isSpecialWallet(address)) {
      const color = specialWalletColor(address);
      host.dataset.gdhSpecial = '1';
      if (color === 'rainbow') {
        host.dataset.gdhSpRainbow = '1';
        host.style.removeProperty('--gdh-sp-bg');
        host.style.removeProperty('--gdh-sp-border');
      } else {
        delete host.dataset.gdhSpRainbow;
        host.style.setProperty('--gdh-sp-bg', hexToRgba(color, 0.1));
        host.style.setProperty('--gdh-sp-border', color);
      }
    } else {
      delete host.dataset.gdhSpecial;
      delete host.dataset.gdhSpRainbow;
      host.style.removeProperty('--gdh-sp-bg');
      host.style.removeProperty('--gdh-sp-border');
    }
  }

  function findWalletTableRow(link) {
    let row = link;
    for (let depth = 0; depth < 8 && row.parentElement; depth += 1) {
      row = row.parentElement;
      if (row.matches?.(WALLET_TABLE_SELECTOR)) return null;
      const cls = String(row.className || '');
      if (cls.includes('h-[44px]') || cls.includes('h-[64')) return row;
      const rect = row.getBoundingClientRect();
      if (rect.width > 200 && rect.height >= 36 && rect.height <= 130) return row;
    }
    return null;
  }

  function scanSpecialWallets() {
    if (settings.enableSpecialWallet === false) {
      closeColorPalette();
      specialManageOpen = false;
      document
        .querySelectorAll('.gdh-star-button, .gdh-color-button, .gdh-sp-manage-button, .gdh-sp-manage-modal, .gdh-pin-strip, .gdh-addw-row')
        .forEach((node) => node.remove());
      document.querySelectorAll('[data-gdh-special="1"]').forEach((node) => {
        delete node.dataset.gdhSpecial;
        delete node.dataset.gdhSpRainbow;
        node.style.removeProperty('--gdh-sp-bg');
        node.style.removeProperty('--gdh-sp-border');
      });
      document.querySelectorAll('[data-gdh-star-host="1"]').forEach((node) => {
        delete node.dataset.gdhStarHost;
      });
      return;
    }

    // 追踪事件卡：卡片即 <a>，钱包地址取内部 /address/ 链接。
    trackerCards().forEach((card) => {
      const address = extractRowWalletAddress(card);
      if (!address) return;
      if (card.dataset.gdhStarHost !== '1') card.dataset.gdhStarHost = '1';
      applySpecialState(card, address);
      const tokenAddr = card.dataset.gdhTrackAddr || '';
      if (tokenAddr) {
        ensureTokenBlockButton(card, tokenAddr, card.dataset.gdhTrackSymbol || '');
        markBlockedHosts(card, isTokenBlocked(tokenAddr));
      }
      ensureStarButton(
        card,
        address,
        extractRowWalletLabel(card),
        findCardActionContainer(card),
        'append',
      );
    });

    // 钱包列表行：从地址链接爬到行容器。
    walletTableScopes().forEach((table) => {
      table.querySelectorAll('a[href*="/address/0x"]').forEach((link) => {
        const row = findWalletTableRow(link);
        if (!(row instanceof HTMLElement)) return;
        const address = extractRowWalletAddress(row);
        if (!address) return;
        if (row.dataset.gdhStarHost !== '1') row.dataset.gdhStarHost = '1';
        applySpecialState(row, address);
        ensureStarButton(row, address, extractRowWalletLabel(row), link, 'after');
      });
    });

    refreshOnchainBalances();
    // 这两个要打网络、又要动第三方 DOM；一旦抛错不能把同一轮里后面的
    // ☆/高亮/管理入口一起带塌，各自兜住
    try { scanMarkedBadges(); } catch { /* 不影响其余扫描 */ }
    try { scanFlapBadges(); } catch { /* 不影响其余扫描 */ }
    ensureAddressPageStar();
    ensureAddWalletStarRow();
    ensureSpecialManageUI();
    scanPinnedPush();
  }

  // ---- 地址页（添加/关注钱包处）同步打星 ----
  function ensureAddressPageStar() {
    const match = location.href.match(/address\/(0x[a-fA-F0-9]{40})/);
    const follow = document.querySelector('[data-sentry-component="UserFollow"]');
    const existing = document.querySelector('.gdh-star-button--address');
    if (!match || !(follow instanceof HTMLElement) || !follow.parentElement) {
      existing?.remove();
      document.querySelector('.gdh-color-button--address')?.remove();
      return;
    }
    const address = match[1].toLowerCase();
    const host = follow.parentElement;
    if (host.dataset.gdhStarHost !== '1') host.dataset.gdhStarHost = '1';
    const label = String(document.title || '').split(' ')[0].trim().slice(0, 32);
    const button = ensureStarButton(host, address, label, follow, 'after');
    if (button) {
      button.classList.add('gdh-star-button--address');
      const swatch = host.querySelector('.gdh-color-button');
      swatch?.classList.add('gdh-color-button--address');
    }
  }

  // ---- GMGN「添加钱包」弹窗内联特别关注设置 ----
  // 用 placeholder / 按钮文案定位，不依赖 GMGN 的类名与组件标记（改版更抗造）。
  const ADDR_PLACEHOLDER_RE = /钱包地址|wallet\s*address/i;
  const NAME_PLACEHOLDER_RE = /钱包名称|wallet\s*name|备注/i;
  const ADD_SUBMIT_RE = /^(添加钱包|add\s*wallet)$/i;

  function findAddWalletDialog() {
    const addrInput = [...document.querySelectorAll('input')].find((el) => (
      ADDR_PLACEHOLDER_RE.test(el.getAttribute('placeholder') || '')
      && el.getClientRects().length > 0
    ));
    if (!addrInput) return null;
    let node = addrInput.parentElement;
    for (let depth = 0; node && depth < 10; depth += 1) {
      const submit = [...node.querySelectorAll('button, div[role="button"]')].find((el) => (
        ADD_SUBMIT_RE.test((el.textContent || '').trim())
      ));
      if (submit) {
        const nameInput = [...node.querySelectorAll('input')].find((el) => (
          el !== addrInput && NAME_PLACEHOLDER_RE.test(el.getAttribute('placeholder') || '')
        ));
        return { dialog: node, addrInput, nameInput: nameInput || null, submit };
      }
      node = node.parentElement;
    }
    return null;
  }

  function readAddWalletPref() {
    const p = settings.addWalletStarPref;
    return {
      on: p?.on === true,
      color: normalizeSpecialColor(p?.color),
      pin: p?.pin === true,
    };
  }

  function saveAddWalletPref(pref) {
    settings.addWalletStarPref = pref;
    try {
      chrome.storage.local.set({ addWalletStarPref: pref });
    } catch {
      // context invalidated
    }
  }

  function ensureAddWalletStarRow() {
    const ctx = findAddWalletDialog();
    if (!ctx) return;
    if (settings.enableSpecialWallet === false) {
      ctx.dialog.querySelector(':scope .gdh-addw-row')?.remove();
      return;
    }
    let row = ctx.dialog.querySelector(':scope .gdh-addw-row');
    if (row) return;

    const pref = readAddWalletPref();
    row = document.createElement('div');
    row.className = 'gdh-addw-row';
    row.addEventListener('pointerdown', (event) => event.stopPropagation());

    const toggle = document.createElement('label');
    toggle.className = 'gdh-addw-toggle';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = pref.on;
    const star = document.createElement('span');
    star.className = 'gdh-addw-star';
    star.textContent = '★';
    const text = document.createElement('span');
    text.textContent = '同时特别关注';
    toggle.append(box, star, text);
    row.appendChild(toggle);

    const opts = document.createElement('div');
    opts.className = 'gdh-addw-opts';
    const dots = document.createElement('div');
    dots.className = 'gdh-addw-dots';
    let chosen = pref.color;
    const renderDots = () => {
      [...dots.querySelectorAll('.gdh-addw-dot')].forEach((d) => {
        d.classList.toggle('is-current', d.dataset.color === chosen);
      });
      star.style.color = chosen === 'rainbow' ? '' : chosen;
      star.classList.toggle('gdh-rainbow-text', chosen === 'rainbow');
    };
    [...SPECIAL_COLOR_PALETTE, 'rainbow'].forEach((color) => {
      const dot = document.createElement('button');
      dot.type = 'button';
      dot.className = 'gdh-addw-dot';
      dot.dataset.color = color;
      applySwatchColor(dot, color);
      dot.title = color === 'rainbow' ? '炫彩' : color;
      dot.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        chosen = color;
        renderDots();
      });
      dots.appendChild(dot);
    });
    const custom = document.createElement('input');
    custom.type = 'color';
    custom.className = 'gdh-addw-custom';
    custom.value = chosen === 'rainbow' ? SPECIAL_COLOR_PALETTE[0] : chosen;
    custom.title = '自定义颜色';
    custom.addEventListener('input', () => {
      chosen = custom.value;
      renderDots();
    });
    dots.appendChild(custom);
    opts.appendChild(dots);

    const pinLabel = document.createElement('label');
    pinLabel.className = 'gdh-addw-pin';
    const pinBox = document.createElement('input');
    pinBox.type = 'checkbox';
    pinBox.checked = pref.pin;
    const pinText = document.createElement('span');
    pinText.textContent = '📌 推送置顶';
    pinLabel.append(pinBox, pinText);
    opts.appendChild(pinLabel);
    row.appendChild(opts);

    const syncEnabled = () => {
      row.classList.toggle('is-on', box.checked);
      opts.querySelectorAll('button, input').forEach((el) => { el.disabled = !box.checked; });
    };
    box.addEventListener('change', syncEnabled);
    syncEnabled();
    renderDots();

    // 提交时把地址+备注登记为特别关注（捕获阶段先于 GMGN 关闭弹窗）。
    ctx.submit.addEventListener('click', () => {
      if (!box.checked) {
        saveAddWalletPref({ on: false, color: chosen, pin: pinBox.checked });
        return;
      }
      const address = String(ctx.addrInput.value || '').trim();
      const label = String(ctx.nameInput?.value || '').trim();
      saveAddWalletPref({ on: true, color: chosen, pin: pinBox.checked });
      if (!addSpecialWallet(address, label, chosen, pinBox.checked)) {
        // 已在名单里就只更新颜色/置顶
        const normalized = normalizeAddress(address);
        if (specialWalletMap.has(normalized)) {
          setSpecialWalletColor(normalized, chosen);
          setSpecialWalletPin(normalized, pinBox.checked);
        }
      }
    }, true);

    ctx.submit.parentElement?.insertBefore(row, ctx.submit);
  }

  // ---- 特别关注管理面板（钱包追踪面板头部入口）----
  let specialManageOpen = false;

  function specialEntries() {
    return [...specialWalletMap.entries()].map(([address, meta]) => ({ address, ...meta }));
  }

  function ensureSpecialManageUI() {
    const panel = document.querySelector('[data-sentry-component="WalletTrack"]');
    const header = panel?.querySelector('[data-sentry-component="TrackingHeader"]');
    if (!(header instanceof HTMLElement) || !(panel instanceof HTMLElement)) {
      if (specialManageOpen) specialManageOpen = false;
      document.querySelector('.gdh-sp-manage-modal')?.remove();
      return;
    }
    let button = header.querySelector(':scope .gdh-sp-manage-button');
    if (!button) {
      button = document.createElement('button');
      button.type = 'button';
      button.className = 'gdh-sp-manage-button';
      button.title = '特别关注管理';
      button.addEventListener('pointerdown', (event) => event.stopPropagation());
      button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        specialManageOpen = !specialManageOpen;
        scheduleScan();
      });
      header.appendChild(button);
    }
    const text = `★${specialWalletMap.size}`;
    if (button.textContent !== text) button.textContent = text;
    button.classList.toggle('is-active', specialManageOpen);
    ensureSpecialManageModal(panel);
  }

  function ensureSpecialManageModal(panel) {
    let modal = panel.querySelector(':scope > .gdh-sp-manage-modal');
    if (!specialManageOpen) {
      modal?.remove();
      return;
    }
    panel.classList.add('gdh-callout-panel-host');
    if (!modal) {
      modal = document.createElement('section');
      modal.className = 'gdh-sp-manage-modal';
      modal.addEventListener('pointerdown', (event) => event.stopPropagation());

      const head = document.createElement('div');
      head.className = 'gdh-sp-manage__head';
      const title = document.createElement('strong');
      title.className = 'gdh-sp-manage__title';
      title.textContent = '特别关注 / 屏蔽的币';
      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'gdh-sp-manage__close';
      close.textContent = '×';
      close.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        specialManageOpen = false;
        modal.remove();
        scheduleScan();
      });
      head.append(title, close);

      const addRow = document.createElement('div');
      addRow.className = 'gdh-sp-manage__add';
      const addrInput = document.createElement('input');
      addrInput.className = 'gdh-sp-manage__input gdh-sp-manage__input--addr';
      addrInput.placeholder = '0x 钱包地址';
      addrInput.spellcheck = false;
      const labelInput = document.createElement('input');
      labelInput.className = 'gdh-sp-manage__input gdh-sp-manage__input--label';
      labelInput.placeholder = '备注(可选)';
      const addButton = document.createElement('button');
      addButton.type = 'button';
      addButton.className = 'gdh-sp-manage__addbtn';
      addButton.textContent = '添加';
      addButton.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (addSpecialWallet(addrInput.value, labelInput.value)) {
          addrInput.value = '';
          labelInput.value = '';
        } else {
          addrInput.classList.add('is-error');
          window.setTimeout(() => addrInput.classList.remove('is-error'), 900);
        }
      });
      addRow.append(addrInput, labelInput, addButton);

      const list = document.createElement('div');
      list.className = 'gdh-sp-manage__list';
      const blocked = document.createElement('div');
      blocked.className = 'gdh-sp-manage__blocked';
      modal.append(head, addRow, list, blocked);
      panel.appendChild(modal);
    }

    // 挂在面板头部下方
    try {
      const headerRect = panel
        .querySelector('[data-sentry-component="TrackingHeader"]')
        .getBoundingClientRect();
      const panelRect = panel.getBoundingClientRect();
      modal.style.top = `${Math.max(30, Math.round(headerRect.bottom - panelRect.top) + 4)}px`;
    } catch {
      modal.style.top = '34px';
    }
    renderSpecialManageList(modal);
    renderBlockedTokenList(modal);
  }

  /** 管理面板里的「屏蔽的币」一栏：看得到、点一下就能恢复。 */
  function renderBlockedTokenList(modal) {
    const box = modal.querySelector('.gdh-sp-manage__blocked');
    if (!box) return;
    // 没变就别重建：扫描每秒至少跑一次，无条件重建会把「恢复」按钮反复销毁重建，
    // 真实鼠标点击要求 mousedown 与 mouseup 落在同一元素上，中间一重建 click 就不会产生。
    const key = JSON.stringify(getBlockedTokens().map((x) => `${x.address}|${x.symbol || ''}`));
    if (box.dataset.gdhBlockedKey === key) return;
    box.dataset.gdhBlockedKey = key;
    box.replaceChildren();

    const head = document.createElement('div');
    head.className = 'gdh-sp-manage__subhead';
    const list = getBlockedTokens();
    head.textContent = `追踪里屏蔽的币（${list.length}）`;
    box.appendChild(head);

    if (!list.length) {
      const empty = document.createElement('div');
      empty.className = 'gdh-sp-manage__empty';
      empty.textContent = '还没有屏蔽任何币。在追踪推送卡上把鼠标移到币名旁点 🚫 即可。';
      box.appendChild(empty);
      return;
    }

    for (const item of list) {
      const row = document.createElement('div');
      row.className = 'gdh-sp-manage__brow';
      const name = document.createElement('span');
      name.className = 'gdh-sp-manage__bname';
      name.textContent = item.symbol || '(未知币名)';
      const addr = document.createElement('span');
      addr.className = 'gdh-sp-manage__baddr';
      addr.textContent = `${item.address.slice(0, 6)}…${item.address.slice(-4)}`;
      addr.title = item.address;
      const undo = document.createElement('button');
      undo.type = 'button';
      undo.className = 'gdh-sp-manage__undo';
      undo.textContent = '恢复';
      undo.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        toggleBlockedToken(item.address, item.symbol);
        delete box.dataset.gdhBlockedKey;
        renderBlockedTokenList(modal);
      });
      row.append(name, addr, undo);
      box.appendChild(row);
    }
  }

  function renderSpecialManageList(modal) {
    const entries = specialEntries();
    const key = JSON.stringify(entries);
    if (modal.dataset.gdhSpKey === key) return;
    modal.dataset.gdhSpKey = key;
    const title = modal.querySelector('.gdh-sp-manage__title');
    if (title) title.textContent = `特别关注管理 · ${entries.length}`;
    const list = modal.querySelector('.gdh-sp-manage__list');
    list.replaceChildren();
    if (!entries.length) {
      const empty = document.createElement('div');
      empty.className = 'gdh-sp-manage__empty';
      empty.textContent = '还没有特别关注的钱包';
      list.appendChild(empty);
      return;
    }
    for (const entry of entries) {
      const row = document.createElement('div');
      row.className = 'gdh-sp-manage__row';

      const swatch = document.createElement('button');
      swatch.type = 'button';
      swatch.className = 'gdh-sp-manage__swatch';
      applySwatchColor(swatch, entry.color);
      swatch.title = '选择高亮颜色 / 置顶';
      swatch.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        openColorPalette(entry.address, swatch.getBoundingClientRect());
      });

      const pin = document.createElement('button');
      pin.type = 'button';
      pin.className = 'gdh-sp-manage__pin';
      pin.textContent = '📌';
      pin.classList.toggle('is-on', entry.pin);
      pin.title = entry.pin ? '已置顶：新推送置顶 10 秒' : '未置顶';
      pin.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        setSpecialWalletPin(entry.address, !entry.pin);
      });

      const name = document.createElement('span');
      name.className = 'gdh-sp-manage__name';
      name.textContent = entry.label || '(无备注)';
      const addr = document.createElement('span');
      addr.className = 'gdh-sp-manage__addr';
      addr.textContent = `${entry.address.slice(0, 6)}…${entry.address.slice(-4)}`;

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'gdh-sp-manage__remove';
      remove.textContent = '移除';
      remove.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        toggleSpecialWallet(entry.address, entry.label);
      });

      row.append(swatch, pin, name, addr, remove);
      list.appendChild(row);
    }
  }

  // ---- 置顶推送：特别关注(置顶)钱包的新事件卡置顶显示 10 秒 ----
  const SPECIAL_PIN_MS = 10000;
  const SPECIAL_PIN_MAX = 3;
  const SPECIAL_PIN_SEEN_MAX = 400;
  const specialPinSeen = new Set();
  let specialPinBaselineDone = false;
  let specialPinStrip = null;

  function hasPinnedWallets() {
    for (const meta of specialWalletMap.values()) if (meta.pin) return true;
    return false;
  }

  function trackerCardSignature(card, address) {
    const action = findCardActionContainer(card);
    const actionText = action
      ? [...action.children].filter((el) => el.tagName === 'SPAN').map((el) => (el.textContent || '').trim()).join('')
      : '';
    const amount = (card.querySelector('[data-sentry-component="LiteTrackerAmount"]')?.textContent || '').trim();
    return `${address}|${card.getAttribute('href') || ''}|${actionText}|${amount}`;
  }

  function rememberPinSeen(sig) {
    specialPinSeen.add(sig);
    if (specialPinSeen.size > SPECIAL_PIN_SEEN_MAX) {
      const iterator = specialPinSeen.values();
      for (let extra = specialPinSeen.size - SPECIAL_PIN_SEEN_MAX; extra > 0; extra -= 1) {
        specialPinSeen.delete(iterator.next().value);
      }
    }
  }

  function ensurePinStrip(panel) {
    if (specialPinStrip && specialPinStrip.isConnected) return specialPinStrip;
    specialPinStrip = document.createElement('div');
    specialPinStrip.className = 'gdh-pin-strip';
    panel.classList.add('gdh-callout-panel-host');
    panel.appendChild(specialPinStrip);
    return specialPinStrip;
  }

  function pinTrackerCard(card, panel) {
    const strip = ensurePinStrip(panel);
    try {
      const body = panel.querySelector('[data-sentry-component="TrackingBody"]');
      const panelRect = panel.getBoundingClientRect();
      const bodyRect = (body || panel).getBoundingClientRect();
      strip.style.top = `${Math.max(0, Math.round(bodyRect.top - panelRect.top))}px`;
    } catch {
      strip.style.top = '60px';
    }
    while (strip.children.length >= SPECIAL_PIN_MAX) strip.lastElementChild.remove();

    const item = document.createElement('div');
    item.className = 'gdh-pin-item';
    const clone = card.cloneNode(true);
    clone.removeAttribute('id');
    clone.querySelectorAll('.gdh-star-button, .gdh-color-button').forEach((n) => n.remove());
    const badge = document.createElement('span');
    badge.className = 'gdh-pin-item__badge';
    badge.textContent = '📌';
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'gdh-pin-item__close';
    close.textContent = '×';
    item.append(badge, clone, close);

    const href = card.getAttribute('href') || '';
    const dismiss = () => {
      item.remove();
      if (specialPinStrip && !specialPinStrip.children.length) {
        specialPinStrip.remove();
        specialPinStrip = null;
      }
    };
    close.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      dismiss();
    });
    item.addEventListener('click', () => {
      dismiss();
      if (card.isConnected) card.click();
      else if (href) window.location.assign(href);
    });
    strip.prepend(item);
    window.setTimeout(dismiss, SPECIAL_PIN_MS);
  }

  function scanPinnedPush() {
    const panel = document.querySelector('[data-sentry-component="WalletTrack"]');
    if (!(panel instanceof HTMLElement)) return;
    const cards = [...panel.querySelectorAll(TRACKER_ITEM_SELECTOR)];
    if (!cards.length) return;

    if (!specialPinBaselineDone) {
      cards.forEach((card) => {
        const address = extractRowWalletAddress(card);
        if (address) rememberPinSeen(trackerCardSignature(card, address));
      });
      specialPinBaselineDone = true;
      return;
    }

    const pinnedActive = hasPinnedWallets();
    cards.forEach((card) => {
      const address = extractRowWalletAddress(card);
      if (!address) return;
      const sig = trackerCardSignature(card, address);
      if (specialPinSeen.has(sig)) return;
      rememberPinSeen(sig);
      if (pinnedActive && specialWalletMap.get(address)?.pin === true) {
        pinTrackerCard(card, panel);
      }
    });
  }

  // ---- 隐藏 frontrun 插件的"闪电交易"按钮 ----
  // 0.15.1：实测按钮宿主是插进 GMGN DOM 的 portal 元素
  // `[data-frontrun-portal="instant-trade"]`（含 tooltip 变体），不是 frontrun-csui。
  // 注意不能碰它的 "cta" portal（战壕行内快速买入按钮）。
  const FRONTRUN_LIGHTNING_SELECTOR =
    '[data-frontrun-portal="instant-trade"], [data-frontrun-portal="instant-trade-tooltip"]';
  // frontrun 在按钮 shadow 里放了 `:host{display:...!important}` 防隐藏加固
  // （shadow 内 important 压过外部 inline important，display:none 无效）；
  // 它没防 visibility 和尺寸——用这组属性把元素视觉+占位全部收干净。
  const FRONTRUN_HIDE_PROPS = [
    ['display', 'none'],
    ['visibility', 'hidden'],
    ['width', '0px'],
    ['height', '0px'],
    ['min-width', '0px'],
    ['min-height', '0px'],
    ['margin', '0px'],
    ['padding', '0px'],
    ['overflow', 'hidden'],
    ['pointer-events', 'none'],
  ];

  function hideFrontrunHost(host) {
    if (host.dataset.gdhHiddenLightning === '1') return;
    host.dataset.gdhHiddenLightning = '1';
    FRONTRUN_HIDE_PROPS.forEach(([prop, value]) => {
      host.style.setProperty(prop, value, 'important');
    });
  }

  function restoreFrontrunHost(host) {
    FRONTRUN_HIDE_PROPS.forEach(([prop]) => host.style.removeProperty(prop));
    delete host.dataset.gdhHiddenLightning;
  }

  // ---- 价格/市值提醒醒目化 ----
  // GMGN 的提醒（价格/市值到价）触发时只弹一条很窄的小 toast（RemindToast.tsx），
  // 极易错过。这里把它接管成画面正中的大卡片，涨绿跌红、带辉光与脉冲。
  const REMIND_TOAST_SELECTOR = '[data-sentry-component="RemindToast"]';
  const REMIND_CARD_MS = 15000;
  const REMIND_CARD_MAX = 3;
  let remindContainer = null;

  function ensureRemindContainer() {
    if (remindContainer && document.contains(remindContainer)) return remindContainer;
    remindContainer = document.createElement('div');
    remindContainer.className = 'gdh-remind-container';
    document.body.appendChild(remindContainer);
    return remindContainer;
  }

  function remindInfoFromToast(node) {
    const link = node.matches('a[href]')
      ? node
      : node.querySelector('a[href]') || node.closest('a[href]');
    const href = link?.getAttribute('href') || '';
    let dir = '';
    if (node.querySelector('.text-increase-100')) dir = 'up';
    else if (node.querySelector('.text-decrease-100')) dir = 'down';

    const texts = [...node.querySelectorAll('*')]
      .filter((el) => el.children.length === 0)
      .map((el) => (el.textContent || '').trim())
      .filter(Boolean);
    const labelIdx = texts.findIndex((t) => /价格|市值|price|mc|market/i.test(t) && t.length <= 8);
    const label = labelIdx >= 0 ? texts[labelIdx] : '';
    const value = labelIdx >= 0
      ? (texts.slice(labelIdx + 1).find((t) => /[\d$]/.test(t)) || '')
      : (texts.find((t) => /^[$≈]/.test(t)) || '');
    const symbol = texts.find((t) => t && t !== label && t !== value && t.length <= 24) || '';
    return { href, dir, label, value, symbol, raw: (node.textContent || '').replace(/\s+/g, ' ').trim() };
  }

  function showRemindCard(info) {
    const container = ensureRemindContainer();
    while (container.children.length >= REMIND_CARD_MAX) container.firstElementChild.remove();

    const card = document.createElement('div');
    card.className = 'gdh-remind-card';
    if (info.dir) card.dataset.gdhDir = info.dir;

    const head = document.createElement('div');
    head.className = 'gdh-remind-card__head';
    const bell = document.createElement('span');
    bell.className = 'gdh-remind-card__bell';
    bell.textContent = info.bell || '🔔';
    const tag = document.createElement('span');
    tag.className = 'gdh-remind-card__tag';
    tag.textContent = info.tagText || (info.dir === 'down' ? '跌破提醒' : '到价提醒');
    head.append(bell, tag);
    if (info.dir) {
      const arrow = document.createElement('span');
      arrow.className = 'gdh-remind-card__arrow';
      arrow.textContent = info.dir === 'down' ? '↓' : '↑';
      head.appendChild(arrow);
    }
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'gdh-remind-card__close';
    close.textContent = '×';
    close.title = '关闭';
    head.appendChild(close);
    card.appendChild(head);

    const symbolEl = document.createElement('div');
    symbolEl.className = 'gdh-remind-card__symbol';
    symbolEl.textContent = info.symbol || '持仓代币';
    card.appendChild(symbolEl);

    const valueRow = document.createElement('div');
    valueRow.className = 'gdh-remind-card__value';
    if (info.label) {
      const labelEl = document.createElement('span');
      labelEl.className = 'gdh-remind-card__label';
      labelEl.textContent = info.label;
      valueRow.appendChild(labelEl);
    }
    const numEl = document.createElement('strong');
    numEl.className = 'gdh-remind-card__num';
    numEl.textContent = info.value || info.raw.slice(0, 40);
    valueRow.appendChild(numEl);
    card.appendChild(valueRow);

    const foot = document.createElement('div');
    foot.className = 'gdh-remind-card__foot';
    foot.textContent = '点击进入代币页 →';
    card.appendChild(foot);

    let timer = 0;
    const dismiss = () => {
      window.clearTimeout(timer);
      card.remove();
      if (remindContainer && !remindContainer.children.length) {
        remindContainer.remove();
        remindContainer = null;
      }
    };
    const arm = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(dismiss, REMIND_CARD_MS);
    };
    close.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      dismiss();
    });
    card.addEventListener('mouseenter', () => window.clearTimeout(timer));
    card.addEventListener('mouseleave', arm);
    card.addEventListener('click', () => {
      dismiss();
      if (info.href) window.location.assign(info.href);
    });
    arm();
    container.appendChild(card);
  }

  // ---- fomo 浮窗：在 GMGN 代币页看该代币在 fomo 的观点/交易 ----
  const FOMO_NETWORK_ID = { bsc: 56, eth: 1, base: 8453, sol: 1399811149 };
  const FOMO_CHAIN_SLUG = { bsc: 'bnb', eth: 'eth', base: 'base', sol: 'sol' };
  const FOMO_REFRESH_MS = 30000;
  let fomoPanelEl = null;
  let fomoTab = 'thesis';
  let fomoLoadedKey = '';
  let fomoErrKey = '';
  let fomoErrAt = 0;
  const FOMO_ERR_COOLDOWN = 20000;
  let fomoLastItems = [];
  let fomoTimer = 0;
  let fomoLoading = false;

  function currentTokenRoute() {
    const m = location.pathname.match(/^\/([a-z0-9]+)\/token\/([A-Za-z0-9]+)/);
    if (!m) return null;
    const chain = m[1];
    if (!(chain in FOMO_NETWORK_ID)) return null;
    return { chain, address: m[2], networkId: FOMO_NETWORK_ID[chain] };
  }

  function fomoAgo(value) {
    const t = Number(new Date(value));
    if (!Number.isFinite(t) || t <= 0) return '';
    return formatRelTime(t);
  }

  function fomoUsd(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n === 0) return '';
    const abs = Math.abs(n);
    const s = abs >= 1e6 ? `${(abs / 1e6).toFixed(1)}M`
      : abs >= 1e3 ? `${(abs / 1e3).toFixed(1)}K`
        : abs.toFixed(abs >= 10 ? 0 : 2);
    return `${n < 0 ? '-' : ''}$${s}`;
  }

  /** 均价可能很小（0.0000012），不能走 fomoUsd 的两位小数。 */
  function fomoPrice(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return '';
    if (n >= 1) return `$${n.toFixed(2)}`;
    return `$${n.toPrecision(3).replace(/0+$/, '').replace(/\.$/, '')}`;
  }

  /** fomo 的 averageHoldTimeSeconds 是秒数，要自己格式化。 */
  function fomoDur(seconds) {
    const s = Number(seconds);
    if (!Number.isFinite(s) || s <= 0) return '';
    if (s < 3600) return `${Math.max(1, Math.round(s / 60))}分`;
    if (s < 86400) return `${(s / 3600).toFixed(1)}时`;
    return `${(s / 86400).toFixed(1)}天`;
  }

  function pick(obj, keys) {
    for (const k of keys) {
      const v = k.split('.').reduce((o, p) => (o == null ? o : o[p]), obj);
      if (v !== undefined && v !== null && v !== '') return v;
    }
    return undefined;
  }

  /**
   * 自适应取值：按「键名正则 + 值类型」在对象里深搜。
   * fomo 的字段名我没法实测确认，硬猜一份清单很容易全落空（0.21.0 就是这么翻车的），
   * 所以改成按语义找，键名怎么拼都能命中。
   */
  function deepPick(obj, keyRe, kind, depth = 0, seen = new Set()) {
    if (!obj || typeof obj !== 'object' || depth > 3 || seen.has(obj)) return undefined;
    seen.add(obj);
    const ok = (v) => {
      if (kind === 'number') {
        const n = Number(v);
        return Number.isFinite(n) && v !== '' && v !== true && v !== false ? n : undefined;
      }
      if (kind === 'url') {
        return typeof v === 'string' && /^https?:\/\//.test(v) ? v : undefined;
      }
      const s = typeof v === 'string' ? v.trim() : '';
      return s && s.length <= 200 && !/^https?:\/\//.test(s) ? s : undefined;
    };
    // 先本层
    for (const [k, v] of Object.entries(obj)) {
      if (!keyRe.test(k)) continue;
      const val = ok(v);
      if (val !== undefined) return val;
    }
    // 再下钻
    for (const v of Object.values(obj)) {
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        const hit = deepPick(v, keyRe, kind, depth + 1, seen);
        if (hit !== undefined) return hit;
      }
    }
    return undefined;
  }

  /**
   * 两个接口的用户信息结构不一样（照 fomo 前端自己的渲染代码）：
   *   持仓者行：holder.user.{userHandle, profilePictureLink, id}
   *   动态条目：item.{userHandle, displayName, profilePictureLink, userId}——扁平，不在 user 下
   * 先按真实字段取，取不到才退回语义猜测。
   */
  function fomoUser(item) {
    return (item && typeof item.user === 'object' && item.user) || item || {};
  }

  function holderName(item) {
    const u = fomoUser(item);
    const handle = typeof u.userHandle === 'string' ? u.userHandle.trim() : '';
    const display = typeof u.displayName === 'string' ? u.displayName.trim() : '';
    return handle || display
      || deepPick(item, /(username|handle|displayname|nickname)/i, 'string')
      || '匿名';
  }

  function holderAvatar(item) {
    const u = fomoUser(item);
    const direct = u.profilePictureLink || item?.profilePictureLink;
    if (typeof direct === 'string' && /^https?:\/\//.test(direct)) return direct;
    return deepPick(item, /(profilepic|profileimage|avatar|picture|image|photo)/i, 'url');
  }

  // ---- fomo 榜单标注 ----
  // 名单由 985monitor 的 24h/7d/30d/总榜 + 聪明钱 Top300 + KOL 名册编译而来。
  // 值形如 "a1s21k"：总榜第 1 / 聪明钱第 21 / 在 KOL 名册。
  const FOMO_BOARD = JSON.parse('{"change":"a1s21kW","frankdegods":"a2s7k","_logjam":"a3s165","chadbchilln":"a4","lesabre":"a5s47","remusofmars":"a6s126","collectible":"a7s102","dystopiansniper":"a8s40","game_for_one":"a9s164","breakingbad":"a10s39","notepad_h":"a11s27k","guavaguy2001":"a12","nfd":"a13","atom_xyz":"a14s38","thebtcgoose":"a15s19k","c1phervoyager":"a16s138","quakerrz":"a17","resellcalendar":"a18s54","vein":"a19s58","nosanityxbt":"a20s9k","billyballs72":"a21","notwashed":"a22s108","0xleo":"a23s17k","xxxfomoxxx":"a24s56","letsdance":"a25","midjetv2":"m13","letsfkingoooo":"m15","hihi33":"m9","runitbackghost":"m39s46","thevilla":"m43","jimbotrading":"m16","avgjoescrypto":"m8","juicycooks":"m18","metaversejoji":"w9s209","surveillor":"m7s193","smol_intern":"m24s188","rafaelonchain":"w14","jotagezin":"m2s41","sandmann":"w16","onmycheck":"w18","mevzoid":"w19s34D","alphacrew23":"w20","aoulss":"w21","letmehelpurmind":"m34","blackgoblin":"w23","traderpow":"w24s163","xventures":"w25","iceslayerman":"w26","xbtpika":"w27","clavtard":"m40","xet":"w29","tendersalt":"w30","gganon44":"w31","warrennakamotox":"m14","maverickdotsol":"w33","openvpp":"w34","kenzo13ro":"w35","trader":"w36s114","ffa888":"w37","jeetergriffin":"w38s271","octoseaa":"w39s6k","0xjiggy":"w40s210","exploit":"w41","moneyman32":"w42","0xdetweiler":"w43s256","0xwives":"w44","crypt0whalex":"w45","eyezenhour":"m31","cryptologykito":"w47","moneymancalls":"w48","just2addicted":"w49","ultimateoldpheasant":"w50","mabon_zsq":"m4","laolu":"m5","dns_err":"m10s287","unnattybrah":"m11","0xuberm":"m12s18k","0x10kliquid":"m17","fathermeme69":"m19","will__price":"m20","hushedlonelybaboon":"m21","cryptogodjohn":"m22","gwei":"m26","staticctrades":"m27","xbrazilzz":"m28s99","iamh3nry":"m29","komorodragon":"m30","fibs":"m32s255","dior100x":"m33","riskit":"m35","hankusun":"m36","riskanonymous":"m37","rtdquant":"m38s214","pxblocito":"m41","jaqs":"m42","randalltrades":"m44","pastlife":"m45","hdegrootvan":"m46","onchainsorcerer":"m47s139","basicexpecteddragon":"m49","wwayfboss":"m50s233","marcellxmarcell":"d6s94","wrld_sol":"d9","0xiamfake":"d13","daumenxyz":"d14s159","astaso1":"d17s121","0xjumpman":"d20","zinceth":"d22s14k","cryptoaeon":"d23","upnext":"d26","dipwheeler":"d27","ineedtowin":"d30","charles_h90":"d31","hp88":"d32","pemp":"d34","goldenchyna":"d41","ckoptimus":"d43","kr_kimkk":"d49","believer12137":"d50","_cr0wbar_":"s1k","spidercrypto0x":"s2k","1947km":"s3k","mystayor":"s4k","nightcore":"s5k","cutie":"s8k","papsio3k1":"s10k","paikcapital":"s11k","_wash3d_":"s12k","wenmoonsolana_":"s13k","onlyz":"s15k","100milly":"s16k","onchainrobber":"s20k","memeinc":"s22k","randomuser123":"s23k","honestregionallungfish":"s24k","0xvantaa":"s25k","thokani":"s26k","careful":"s28k","sized_in":"s29k","kjs16":"s30k","andy":"s31","kingfomo":"s32","nicktesla16":"s33","favel":"s35","flippingprofits":"s36","seyong":"s37","0xforte124":"s42","imim":"s43","moodywsw":"s44","stigstigstig_":"s45","squidward":"s48","eyeamfin":"s49","wealthmaxxer":"s50","seanlippel":"s51","obitouchiha":"s52","_happyk21":"s53","zemirch":"s55","tommy":"s57","kom3thazine":"s59","icemandot":"s60","account":"s61","spiritualscorch":"s62","colby":"s63","pointfarmcap":"s64","sonder_crypto":"s65","theprimegreek":"s66","loopifyyy":"s67","llonchain":"s68","elegantprecisetapir":"s69","igxyffiyofof":"s70","degentodisciple":"s71","mimiardrp":"s72","memeticpower":"s73","hotlneblng":"s74","foreskinnnnn":"s75","real_y22":"s76","0xheme":"s77","0xsneakky":"s78","user_0037":"s79","0xarchitectx0":"s80","kalexbt":"s81","garythegambler":"s82","losteverythingagain":"s83","runecrypto_":"s84","degengigi":"s85","slushie":"s86","adro808":"s87","blitzrun":"s88","mightyegoism":"s89","31337___":"s90","0xkillua_eth":"s91","0x7ama":"s92","spyda":"s93","fullportonly":"s95","jobsnotfinished":"s96","rynzoeth":"s97","parasite_eei":"s98","notanicecat69":"s100","bryptokenneth3":"s101","solswizzle":"s103","rugmeharder":"s104","kekwdjsjnd":"s105","joespina":"s106","mythos":"s107","4pfcoyote":"s109","senzu":"s110","pingucharts":"s111","lucacseth":"s112","horror":"s113","ghostonchain":"s115","samptsd":"s116","hamsa":"s117","guided":"s118","cuttycurryy":"s119","zimmwho":"s120","scalps":"s122","noahknowstrades":"s123","mnds":"s124","bulgugi":"s125","dragossden":"s127","imviriofficial":"s128","notsuavizim":"s129","growingdisabledgerbil":"s130","kidski":"s131","kongkapital":"s132","navalneutralhalibut":"s133","degnsol":"s134","paik_michael":"s135","choppeduncx":"s136","royalbelligerentplatypus":"s137","joeburrow246":"s140","jstacks___":"s141","onchainstudent":"s142","binkieee":"s143W","leftcurvemaxing":"s144","virtualbacon":"s145","halibutcrypto":"s146","graycandol":"s147","crip":"s148","samflintstone":"s149","privateneighbor":"s150","grampsxbt":"s151","77777777777777":"s152","woooooohooooo":"s153","gera_eth":"s154","bobius":"s155","airtightfish":"s156","lacostetn26":"s157","jxck_eth":"s158","ericceth":"s160","mispriced":"s161","kikaka10000":"s162","maximusfab1us":"s166","dumb_ape":"s167","wardsy0x":"s168","winnerx":"s169","x1x2":"s170","maisonghost":"s171","basedbroker":"s172","prewealthy":"s173","aurah":"s174","stinkysasha":"s175","kbz1":"s176","gr3gor14n":"s177","brox":"s178","10xjdog":"s179","rodotfun":"s180","muddy":"s181","thebiglong":"s182","exuro":"s183","shockedjs":"s184","legionyeni":"s185","good":"s186","mistystrictantelope":"s187","_veigarcrypto_xd":"s189","books":"s190","tassolago":"s191","teepanddestroy":"s192","manofwar":"s194","koyla_sol":"s195","takeiteasy":"s196","spicyperuvian_":"s197","t26x":"s198","ferbsol":"s199","tonyovo":"s200","captain_al_80":"s201","stoploss":"s202","hbutspecial":"s203","insentos":"s204","pius":"s205","ohmprovement":"s206","printgod":"s207","cryptojohnnyfap":"s208","deadass":"s211","quanterty":"s212","gnocity_":"s213","px_721":"s215","seikux":"s216","hehe":"s217","nervousfuzzylizard":"s218","cryptodjip":"s219","poorclick":"s220","aaabbbccc":"s221","osideus":"s222","newlowscore677777":"s223","downhorrndously":"s224","________________":"s225","0xforgivable":"s226","quotes":"s227","ocrxa":"s228","patrick33":"s229","vexrex23":"s230","999999999999999":"s231","chimpfone":"s232","katsucurryxbt":"s234","feanor_crypt":"s235","palequietherring":"s236","mino":"s237","scrooge":"s238","bigslime":"s239","toptickcrypto":"s240","xmediumrare":"s241","lay2000lbs":"s242","yogurt_eth":"s243","carlwheezor":"s244","frankneedsabeer":"s245","judee":"s246","charles":"s247","dictator":"s248","devilslayer1802":"s249","hasntpumpedyet":"s250","jikksol":"s251","zackory":"s252","ilillllliliilii":"s253","jlcryptohh":"s254","don999z":"s257","magica_conch":"s258","rebuild":"s259","zoomeroracle":"s260","finalearc":"s261","brrrgrrrz":"s262","lucasw99":"s263","arbiter":"s264","kusanagiyo_00":"s265","bleachsolana":"s266","degensaw":"s267","kobe":"s268","itackld":"s269","6foot4honda":"s270","0xsnibbler":"s272","brazen":"s273","altanxayan":"s274","maxxbiid":"s275","runitback":"s276","krazz":"s277","wizardcat":"s278","mickeymouse":"s279","quinn":"s280","nigayahu":"s281","casino1":"s282","jambalaya":"s283","allidoiswin":"s284","acetto":"s285","heiss_7":"s286","gluttony":"s288","jackson":"s289","theetherista":"s290","wildwilly":"s291","ashegan":"s292","macdegods":"s293","spyzer":"s294","qtags":"s295","shroom_daddy":"s296","paul":"s297","ishowmemecoins":"s298","basedshillbh":"s299","shownuniform08":"s300","zinc":"D","missoralways":"S","logjam":"W","killua":"F","sencrazy":"S","solo":"F","poorgoat🐂🀄️💛🐈":"W","rowdy":"S","rc":"D","solkcrow":"D","0xsun":"S","nobi":"S","lana":"S","smokξy":"F","frank":"D","pow🧲":"F","rune":"D","ozzy":"F","blknoiz06":"D","unipcs":"W","avast":"D","mr.mystery":"S","冷静冷静再冷静":"S","logan lim":"D"}');
  const FOMO_BOARD_LABEL = { a: '总榜', m: '30天', w: '7天', d: '24h' };
  const FOMO_TIER_ICON = { W: '🐳', D: '🐬', F: '🐟', S: '🦐' };
  const FOMO_TIER_NAME = { W: '鲸', D: '海豚', F: '鱼', S: '虾' };

  function fomoBoardMark(handle) {
    const key = String(handle || '').trim().toLowerCase();
    if (!key) return null;
    const raw = FOMO_BOARD[key];
    if (!raw) return null;
    const board = raw.match(/^([awmd])(\d+)/);
    const smart = raw.match(/s(\d+)/);
    const kol = /k/.test(raw);
    const tier = (raw.match(/[WDFS]/) || [])[0];
    const text = [];
    const tip = [];
    if (tier) {
      text.push(FOMO_TIER_ICON[tier]);
      tip.push(`资金档 ${FOMO_TIER_NAME[tier]}`);
    }
    if (board) {
      text.push(`🏆${FOMO_BOARD_LABEL[board[1]]}#${board[2]}`);
      tip.push(`fomo ${FOMO_BOARD_LABEL[board[1]]}盈利榜第 ${board[2]} 名`);
    }
    if (smart) {
      if (!board) text.push(`🧠#${smart[1]}`);
      tip.push(`聪明钱榜第 ${smart[1]} 名`);
    }
    if (kol) {
      text.push('⭐');
      tip.push('在 KOL 名册');
    }
    if (!text.length) return null;
    return { text: text.join(''), title: tip.join(' · '), top: !!(board && Number(board[2]) <= 10) };
  }

  function attachFomoBoard(container, handle) {
    const mark = fomoBoardMark(handle);
    if (!mark) return;
    const chip = document.createElement('span');
    chip.className = `gdh-fomo__board${mark.top ? ' is-top' : ''}`;
    chip.textContent = mark.text;
    chip.title = mark.title;
    container.appendChild(chip);
  }

  // ---- 观点翻译（Chrome 138+ 内置本地翻译，与 985monitor 同一套 API，全程在本机跑）----
  const fomoTrCache = new Map();
  const fomoTranslators = new Map();
  let fomoDetector = null;
  let fomoTrQueue = [];
  let fomoTrRunning = false;
  let fomoTrGesture = false;
  let fomoTrNeedsGesture = false;
  let fomoTrStuck = false;
  let fomoTrProgress = 0;
  const FOMO_TR_STUCK_MS = 15000;

  /** 浏览器分支：Edge 与 Chrome 的接口一样，但可用性和设置入口不同，提示要分开写。 */
  function browserKind() {
    try {
      const brands = navigator.userAgentData?.brands || [];
      if (brands.some((b) => /Microsoft Edge/i.test(b.brand))) return 'edge';
    } catch {
      // 老浏览器没有 userAgentData
    }
    return / Edg\//.test(navigator.userAgent) ? 'edge' : 'chrome';
  }

  /** 把「译」按钮的样子和当前状态对齐（含"需要点一下下载语言包"这种中间态）。 */
  function syncFomoTrButton() {
    const btn = fomoPanelEl && fomoPanelEl.querySelector('.gdh-fomo__tr');
    if (!btn) return;
    const supported = !!fomoTrApi();
    const edge = browserKind() === 'edge';
    const downloading = fomoTrProgress > 0 && fomoTrProgress < 100;
    btn.classList.toggle('is-on', supported && settings.fomoTranslate && !fomoTrNeedsGesture && !fomoTrStuck);
    btn.classList.toggle('is-off', !supported || fomoTrStuck);
    btn.classList.toggle('is-wait', supported && settings.fomoTranslate && (fomoTrNeedsGesture || downloading));
    btn.textContent = downloading ? `${fomoTrProgress}%` : '译';

    if (!supported) {
      btn.title = edge
        ? '当前 Edge 没有提供内置本地翻译接口（需较新版本的 Edge）'
        : '当前浏览器不支持内置本地翻译（需 Chrome 138+）';
    } else if (fomoTrStuck) {
      // Edge 实测会出现「说能下、但一直不动」的情况，如实说明而不是让按钮空转
      btn.title = edge
        ? 'Edge 的内置翻译接口有响应，但语言包迟迟没就绪（多为本机翻译模型未启用/未下载）。'
          + '可在 Edge 设置里检查翻译相关开关后点这里重试；也可以直接关掉翻译。'
        : '语言包一直没下下来，点这里重试；多次不行可先关掉翻译。';
    } else if (downloading) {
      btn.title = `正在下载中文语言包 ${fomoTrProgress}%（只需一次）`;
    } else if (fomoTrNeedsGesture && settings.fomoTranslate) {
      btn.title = '点一下开始下载中文语言包（只需一次，之后自动翻译）';
    } else if (settings.fomoTranslate) {
      btn.title = '关闭翻译（原文下方的译文会移除）';
    } else {
      btn.title = '在原文下方补上中文翻译（本机翻译，内容不外传）';
    }
  }

  const fomoTrApi = () => { try { return globalThis.Translator || null; } catch { return null; } };
  const fomoDetApi = () => { try { return globalThis.LanguageDetector || null; } catch { return null; } };

  /** 中文字符占比高就不用翻，省掉一次语言检测。 */
  function fomoLooksChinese(text) {
    const cjk = (text.match(/[一-鿿]/g) || []).length;
    return cjk > 0 && cjk / text.replace(/\s/g, '').length > 0.2;
  }

  async function fomoDetectLang(text) {
    const api = fomoDetApi();
    if (!api) return 'en';
    if (!fomoDetector) fomoDetector = await api.create();
    const list = await fomoDetector.detect(text);
    const top = Array.isArray(list) ? list[0] : null;
    if (!top || Number(top.confidence) < 0.5) return '';
    return String(top.detectedLanguage || '').split('-')[0];
  }

  async function fomoTranslatorFor(lang) {
    if (fomoTranslators.has(lang)) return fomoTranslators.get(lang);
    const api = fomoTrApi();
    if (!api) return null;
    // 语言包没下过时，create() 必须发生在用户手势里，否则浏览器直接拒绝。
    // 默认开启的情况下首屏拿不到手势，所以先探可用性，缺包就等用户点一下「译」。
    let availability = 'available';
    try {
      if (typeof api.availability === 'function') {
        availability = String(await api.availability({ sourceLanguage: lang, targetLanguage: 'zh' }) || 'available');
      }
    } catch {
      availability = 'available';
    }
    if (availability === 'unavailable') {
      fomoTranslators.set(lang, null);
      return null;
    }
    if (availability !== 'available' && !fomoTrGesture) {
      fomoTrNeedsGesture = true;
      syncFomoTrButton();
      return null;
    }
    // Edge 实测：availability() 会说 downloadable，但 create() 可能一直挂着——
    // 不返回、不报错、也不发任何 downloadprogress。没有超时的话「译」会永远停在待点状态。
    // 用「有没有收到下载进度」来区分「真在下载」和「悄悄卡住」：收到进度就耐心等，
    // 一直没进度就判定为卡住并按浏览器给出对应说明。
    let sawProgress = false;
    const create = api.create({
      sourceLanguage: lang,
      targetLanguage: 'zh',
      monitor(m) {
        try {
          m.addEventListener('downloadprogress', (event) => {
            sawProgress = true;
            fomoTrProgress = Math.round((Number(event.loaded) || 0) * 100);
            syncFomoTrButton();
          });
        } catch {
          // 该浏览器不支持进度回调
        }
      },
    });
    const stuck = new Promise((resolve) => {
      const tick = () => {
        if (sawProgress) return void window.setTimeout(tick, 5000);
        resolve('stuck');
      };
      window.setTimeout(tick, FOMO_TR_STUCK_MS);
    });
    const translator = await Promise.race([create, stuck]);
    if (translator === 'stuck') {
      fomoTrStuck = true;
      fomoTrNeedsGesture = false;
      syncFomoTrButton();
      return null;
    }
    fomoTrStuck = false;
    fomoTrProgress = 0;
    fomoTranslators.set(lang, translator);
    fomoTrNeedsGesture = false;
    syncFomoTrButton();
    return translator;
  }

  /** 原文不动，译文补一行挂在它下面。 */
  function paintTranslation(el, zh) {
    // 不能要求 el 已进文档：命中缓存时这一步发生在渲染途中，那会儿整行还没挂上去
    if (!zh || !el.parentNode) return;
    let zhEl = el.nextElementSibling;
    if (!zhEl || !zhEl.classList.contains('gdh-fomo__zh')) {
      zhEl = document.createElement('div');
      zhEl.className = 'gdh-fomo__zh';
      el.after(zhEl);
    }
    zhEl.textContent = zh;
  }

  async function runFomoTranslate() {
    if (fomoTrRunning) return;
    fomoTrRunning = true;
    while (fomoTrQueue.length) {
      const { el, text } = fomoTrQueue.shift();
      try {
        const cached = fomoTrCache.get(text);
        if (cached) { paintTranslation(el, cached); continue; }
        const lang = await fomoDetectLang(text);
        if (!lang || lang === 'zh') { fomoTrCache.set(text, ''); continue; }
        const translator = await fomoTranslatorFor(lang);
        if (!translator) continue;
        const zh = String(await translator.translate(text) || '').trim();
        if (!zh) continue;
        fomoTrCache.set(text, zh);
        paintTranslation(el, zh);
      } catch {
        // 语言包缺失/下载失败：保留原文，不打断其余条目
      }
    }
    fomoTrRunning = false;
  }

  /** 把一段正文排进翻译队列（已是中文、太短、翻译没开都直接跳过）。 */
  function queueFomoTranslate(el, text) {
    if (!settings.fomoTranslate || !fomoTrApi()) return;
    const raw = String(text || '').trim();
    if (raw.length < 3 || fomoLooksChinese(raw)) return;
    const cached = fomoTrCache.get(raw);
    if (cached !== undefined) { if (cached) paintTranslation(el, cached); return; }
    fomoTrQueue.push({ el, text: raw });
    // 渲染时这一行还没挂进列表，等本轮 DOM 拼完再跑，否则整批都会被当成已移除丢掉
    if (!fomoTrRunning) setTimeout(runFomoTranslate, 0);
  }

  /** 开关切换后重刷当前列表：开则翻译，关则还原原文。 */
  function refreshFomoTranslations() {
    if (!fomoPanelEl) return;
    const nodes = fomoPanelEl.querySelectorAll('.gdh-fomo__text, .gdh-fomo__htext');
    if (!settings.fomoTranslate) {
      fomoTrQueue = [];
      fomoPanelEl.querySelectorAll('.gdh-fomo__zh').forEach((el) => el.remove());
      return;
    }
    nodes.forEach((el) => queueFomoTranslate(el, el.textContent));
  }

  // ---- 持仓者的 7 天盈亏标记 ----
  // 分档同时看金额和收益率，取较低的一档：大户小赚不算高手，小号翻倍也不算大神。
  const FOMO_TIERS = [
    { icon: '💀', label: '重亏' },
    { icon: '🔴', label: '亏损' },
    { icon: '⚪', label: '持平' },
    { icon: '🟢', label: '盈利' },
    { icon: '🔥', label: '顶级' },
  ];

  function fomoTier(pnl, equity) {
    const abs = pnl >= 5e4 ? 4 : pnl >= 5e3 ? 3 : pnl > -5e3 ? 2 : pnl > -5e4 ? 1 : 0;
    // 仓位太小时比例噪音大（几百美元的号能刷出夸张百分比），只按金额定档
    if (!(equity > 100)) return abs;
    const rate = (pnl / equity) * 100;
    const pct = rate >= 30 ? 4 : rate >= 5 ? 3 : rate > -5 ? 2 : rate > -30 ? 1 : 0;
    return Math.min(abs, pct);
  }

  const FOMO_PNL_TTL = 10 * 60 * 1000;
  const fomoPnlCache = new Map();
  let fomoPnlQueue = [];
  let fomoPnlActive = 0;
  let fomoPnlObserver = null;

  function paintFomoTag(el, data) {
    const pnl = Number(data?.pnl);
    if (!data?.ok || !Number.isFinite(pnl)) {
      el.className = 'gdh-fomo__tag is-none';
      el.textContent = '—';
      el.title = data?.reason === 'expired' ? 'fomo 登录态已过期' : '暂无 7 天盈亏数据';
      return;
    }
    const equity = Number(data.equity) || 0;
    const tier = fomoTier(pnl, equity);
    const meta = FOMO_TIERS[tier];
    const rate = equity > 100 ? (pnl / equity) * 100 : NaN;
    el.className = `gdh-fomo__tag is-t${tier}`;
    el.textContent = `${meta.icon} ${pnl >= 0 ? '+' : ''}${fomoUsd(pnl) || '$0'}`;
    el.title = Number.isFinite(rate)
      ? `${meta.label} · 7天盈亏 ${pnl >= 0 ? '+' : ''}${fomoUsd(pnl)}（${rate > 0 ? '+' : ''}${rate.toFixed(1)}%）· 组合 ${fomoUsd(equity)}`
      : `${meta.label} · 7天盈亏 ${pnl >= 0 ? '+' : ''}${fomoUsd(pnl)}`;
  }

  function pumpFomoPnl() {
    while (fomoPnlActive < 4 && fomoPnlQueue.length) {
      const job = fomoPnlQueue.shift();
      if (!job.el.isConnected) continue;
      fomoPnlActive += 1;
      chrome.runtime.sendMessage({ type: 'fomo-user-pnl', payload: { userId: job.userId } })
        .then((res) => {
          fomoPnlCache.set(job.userId, { at: Date.now(), data: res });
          if (job.el.isConnected) paintFomoTag(job.el, res);
        })
        .catch(() => {})
        .finally(() => { fomoPnlActive -= 1; pumpFomoPnl(); });
    }
  }

  /** 只给滚到可见的行取数，同一用户 10 分钟内不重复请求。 */
  function watchFomoTag(el, userId) {
    const hit = fomoPnlCache.get(userId);
    if (hit && Date.now() - hit.at < FOMO_PNL_TTL) return void paintFomoTag(el, hit.data);
    if (!fomoPnlObserver) return;
    el.dataset.gdhUid = userId;
    fomoPnlObserver.observe(el);
  }

  function resetFomoTagObserver(root) {
    if (fomoPnlObserver) fomoPnlObserver.disconnect();
    fomoPnlQueue = [];
    fomoPnlObserver = new IntersectionObserver((entries, obs) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        obs.unobserve(e.target);
        const userId = e.target.dataset.gdhUid;
        if (userId) fomoPnlQueue.push({ el: e.target, userId });
      }
      pumpFomoPnl();
    }, { root, rootMargin: '120px' });
  }

  /** Holders 表：交易者 / 持仓 / 盈亏 / 平均入场 / 观点 */
  function renderFomoHolders(list, items) {
    list.replaceChildren();
    if (!items.length) {
      const empty = document.createElement('div');
      empty.className = 'gdh-fomo__empty';
      empty.textContent = '暂无持仓者';
      return void list.appendChild(empty);
    }
    resetFomoTagObserver(list);
    for (const item of items.slice(0, 60)) {
      const row = document.createElement('div');
      row.className = 'gdh-fomo__hrow';

      const who = document.createElement('div');
      who.className = 'gdh-fomo__hwho';
      const avatarUrl = holderAvatar(item);
      if (avatarUrl) {
        const img = document.createElement('img');
        img.className = 'gdh-fomo__avatar';
        img.src = avatarUrl;
        img.alt = '';
        img.referrerPolicy = 'no-referrer';
        who.appendChild(img);
      }
      const name = document.createElement('strong');
      name.className = 'gdh-fomo__name';
      name.textContent = holderName(item);
      who.appendChild(name);
      attachFomoBoard(who, fomoUser(item)?.userHandle);

      if (settings.mergeFomoHolders !== false) {
        const rankEl = buildRankBadge(Number(item?.humanAmount));
        if (rankEl) who.appendChild(rankEl);
      }

      const uid = fomoUser(item)?.id;
      if (uid) {
        const tag = document.createElement('span');
        tag.className = 'gdh-fomo__tag is-loading';
        tag.textContent = '…';
        tag.title = '7 天盈亏加载中';
        who.appendChild(tag);
        watchFomoTag(tag, String(uid));
      }

      const hold = fomoDur(item?.averageHoldTimeSeconds)
        || deepPick(item, /hold(ing)?(time|duration|period)|avghold/i, 'string');
      if (hold) {
        const h = document.createElement('span');
        h.className = 'gdh-fomo__hhold';
        h.textContent = String(hold).slice(0, 14);
        who.appendChild(h);
      }
      row.appendChild(who);

      const nums = document.createElement('div');
      nums.className = 'gdh-fomo__hnums';

      // fomo 的口径：有实时价就用 humanAmount×价格，否则用 value（这里没有价格，直接取 value）
      const posUsd = Number(item?.value ?? deepPick(item, /(position|value|balance)(usd)?$/i, 'number'));
      const posEl = document.createElement('span');
      posEl.className = 'gdh-fomo__hpos';
      posEl.textContent = Number.isFinite(posUsd) && posUsd > 0 ? fomoUsd(posUsd) : '—';
      nums.appendChild(posEl);

      const pnl = Number(item?.pnl ?? item?.realizedPnl ?? deepPick(item, /(pnl|profit)(usd)?$/i, 'number'));
      const pnlEl = document.createElement('span');
      pnlEl.className = 'gdh-fomo__hpnl';
      if (Number.isFinite(pnl) && pnl !== 0) {
        pnlEl.classList.add(pnl >= 0 ? 'is-up' : 'is-down');
        // fomo 没有现成的百分比字段，是用 pnl / costBasis 算出来的
        const basis = Number(item?.costBasis);
        const pct = Number.isFinite(basis) && basis > 0 ? (pnl / basis) * 100 : NaN;
        pnlEl.textContent = Number.isFinite(pct) && pct !== 0
          ? `${pnl >= 0 ? '+' : ''}${fomoUsd(pnl)} (${pct > 0 ? '+' : ''}${pct.toFixed(1)}%)`
          : `${pnl >= 0 ? '+' : ''}${fomoUsd(pnl)}`;
      } else {
        pnlEl.textContent = '—';
      }
      nums.appendChild(pnlEl);

      // fomo 的 Avg. entry 列是「均价×总供应量」的市值，这里拿不到总供应量，直接显示均价
      const entryEl = document.createElement('span');
      entryEl.className = 'gdh-fomo__hentry';
      entryEl.textContent = fomoPrice(item?.averageEntryPrice)
        || fomoPrice(deepPick(item, /(entry|average).*(price)/i, 'number')) || '—';
      nums.appendChild(entryEl);
      row.appendChild(nums);

      const thesis = String(item?.comment?.comment
        || deepPick(item, /(thesis|content|message|note|comment)/i, 'string') || '').trim();
      if (thesis) {
        const t = document.createElement('div');
        t.className = 'gdh-fomo__htext';
        t.textContent = thesis;
        row.appendChild(t);
        queueFomoTranslate(t, thesis);
      }
      list.appendChild(row);
    }
  }

  function renderFomoItems(list, items, kind) {
    if (kind === 'holders') return renderFomoHolders(list, items);
    list.replaceChildren();
    if (!items.length) {
      const empty = document.createElement('div');
      empty.className = 'gdh-fomo__empty';
      empty.textContent = kind === 'thesis' ? '还没有人发表观点' : '暂无交易';
      list.appendChild(empty);
      return;
    }
    for (const item of items.slice(0, 50)) {
      const row = document.createElement('div');
      row.className = 'gdh-fomo__item';

      const head = document.createElement('div');
      head.className = 'gdh-fomo__head';
      const avatarUrl = holderAvatar(item);
      if (avatarUrl) {
        const img = document.createElement('img');
        img.className = 'gdh-fomo__avatar';
        img.src = avatarUrl;
        img.alt = '';
        img.referrerPolicy = 'no-referrer';
        head.appendChild(img);
      }
      const name = document.createElement('strong');
      name.className = 'gdh-fomo__name';
      name.textContent = holderName(item);
      head.appendChild(name);
      attachFomoBoard(head, fomoUser(item)?.userHandle);

      // fomo 口径：已平仓看已实现，未平仓看已实现+未实现
      const trade = item?.authorTrade;
      const pnl = Number(trade
        ? (trade.closedAt ? trade.realizedPnlUsd : (trade.realizedPnlUsd || 0) + (trade.unrealizedPnlUsd || 0))
        : (item?.pnlChange ?? deepPick(item, /(pnl|profit)(usd)?$/i, 'number')));
      if (Number.isFinite(pnl) && pnl !== 0) {
        const pnlEl = document.createElement('span');
        pnlEl.className = `gdh-fomo__pnl ${pnl >= 0 ? 'is-up' : 'is-down'}`;
        pnlEl.textContent = fomoUsd(pnl);
        head.appendChild(pnlEl);
      }
      const sizeUsd = Number(trade?.usdValue
        ?? item?.positionUsd ?? deepPick(item, /(amount|size|value|position)(usd)?$/i, 'number'));
      if (Number.isFinite(sizeUsd) && sizeUsd > 0) {
        const sz = document.createElement('span');
        sz.className = 'gdh-fomo__size';
        sz.textContent = fomoUsd(sizeUsd);
        head.appendChild(sz);
      }
      const time = document.createElement('span');
      time.className = 'gdh-fomo__time';
      time.textContent = fomoAgo(pick(item, ['createdAt', 'timestamp', 'createdTime', 'time'])
        || deepPick(item, /(createdat|created_at|timestamp|time)$/i, 'number'));
      head.appendChild(time);
      row.appendChild(head);

      // 观点正文在 item.comment.comment
      const text = String(item?.comment?.comment
        || deepPick(item, /(thesis|content|text|body|message|note)/i, 'string') || '').trim();
      if (text) {
        const body = document.createElement('div');
        body.className = 'gdh-fomo__text';
        body.textContent = text;
        row.appendChild(body);
        queueFomoTranslate(body, text);
      }
      list.appendChild(row);
    }
  }

  /** 令牌状态一句话：没有 / 还有多久过期 / 过期多久了。 */
  function describeFomoToken(stored) {
    if (!stored?.token) return { cls: 'is-bad', text: '尚未取到登录态' };
    const exp = Number(stored.exp) || 0;
    const got = formatRelTime(stored.at || Date.now());
    if (!exp) return { cls: 'is-ok', text: `已取到（${got}）` };
    const left = exp - Date.now();
    if (left <= 0) return { cls: 'is-bad', text: `已过期（${formatRelTime(exp)}过期，${got}取到）` };
    const mins = Math.round(left / 60000);
    return {
      cls: 'is-ok',
      text: `有效，约 ${mins >= 60 ? `${Math.round(mins / 60)} 小时` : `${mins} 分钟`}后过期${stored.renewed ? '（自动续期）' : ''}`,
    };
  }

  /** 拿不到数据时给一份能照着做完的引导，而不是只报一句错。 */
  async function buildFomoErrorBox(res) {
    const box = document.createElement('div');
    box.className = 'gdh-fomo__guide';
    let stored = null;
    try {
      const got = await chrome.storage.local.get('fomoToken');
      stored = got?.fomoToken || null;
    } catch {
      // 扩展上下文失效
    }
    const reason = res?.reason || 'unknown';
    const needLogin = reason === 'no-token' || reason === 'expired';

    const title = document.createElement('div');
    title.className = 'gdh-fomo__gtitle';
    const why = document.createElement('div');
    why.className = 'gdh-fomo__gwhy';

    if (reason === 'no-token') {
      title.textContent = '差一步：需要你的 fomo 登录态';
      why.textContent = 'fomo 的持仓者和观点接口必须带登录令牌。插件会自己去你已登录的 fomo 页面读，你不用复制粘贴任何东西。';
    } else if (reason === 'expired') {
      title.textContent = 'fomo 登录态过期了';
      why.textContent = stored?.refresh
        ? '已尝试自动续期但没成功（通常是 fomo 那边把会话作废了）。照下面走一遍就能重新拿到，之后仍会自动续。'
        : '这份令牌是在支持自动续期之前存下的，缺少续期凭证。照下面走一遍，新的令牌以后就能自动续了。';
    } else if (reason === 'blocked') {
      title.textContent = '被 fomo 的风控挡了';
      why.textContent = `请求返回 ${res?.status || 403}（Cloudflare）。多半是短时间请求太密，等一会儿再点重试；一直这样就截图发我。`;
    } else if (reason === 'network') {
      title.textContent = '网络没通';
      why.textContent = `${String(res?.message || '请求失败').slice(0, 60)}。检查代理/网络后点重试。`;
    } else {
      title.textContent = `加载失败（${reason}${res?.status ? ' / ' + res.status : ''}）`;
      why.textContent = String(res?.message || '把这一行截图发我即可定位。').slice(0, 90);
    }
    box.append(title, why);

    if (needLogin) {
      const steps = document.createElement('ol');
      steps.className = 'gdh-fomo__steps';
      [
        ['点下面的按钮打开 fomo', '会在新标签页打开 fomo.family'],
        ['确认已登录', '没登录就先登录；已登录的话按一次 F5 刷新'],
        ['点右上角头像进自己的主页', '也就是持仓那一页，令牌在这页最稳定'],
        ['切回这个标签页', '插件会自动接上，不用手动点重试'],
      ].forEach(([main, sub]) => {
        const li = document.createElement('li');
        const b = document.createElement('b');
        b.textContent = main;
        const s = document.createElement('span');
        s.textContent = sub;
        li.append(b, s);
        steps.appendChild(li);
      });
      box.appendChild(steps);
    }

    const state = document.createElement('div');
    const desc = describeFomoToken(stored);
    state.className = `gdh-fomo__gstate ${desc.cls}`;
    state.textContent = `登录态：${desc.text}`;
    box.appendChild(state);

    const actions = document.createElement('div');
    actions.className = 'gdh-fomo__gacts';

    if (needLogin) {
      const link = document.createElement('a');
      link.className = 'gdh-fomo__gopen';
      link.href = 'https://fomo.family/';
      link.target = '_blank';
      link.rel = 'noreferrer';
      link.textContent = '打开 fomo 并登录 →';
      actions.appendChild(link);
    }

    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'gdh-fomo__retry';
    retry.textContent = '重试';
    retry.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      fomoLoadedKey = '';
      fomoErrKey = '';
      loadFomoData(true);
    });
    actions.appendChild(retry);
    box.appendChild(actions);
    return box;
  }

  async function loadFomoData(force) {
    const route = currentTokenRoute();
    if (!route || !fomoPanelEl) return;
    const key = `${fomoTab}|${route.chain}|${route.address}`;
    if (!force && key === fomoLoadedKey) return;
    // 出错时不设 fomoLoadedKey，于是每个扫描周期都会重来一遍「清空→加载中→错误框」，
    // 看起来就是整块一直在闪。失败后压一段冷却，期间只有手动重试/换页/令牌到位才再打。
    if (!force && key === fomoErrKey && Date.now() - fomoErrAt < FOMO_ERR_COOLDOWN) return;
    if (fomoLoading) return;
    fomoLoading = true;
    const list = fomoPanelEl.querySelector('.gdh-fomo__list');
    const keepingGuide = key === fomoErrKey && list.querySelector('.gdh-fomo__guide');
    if (key !== fomoLoadedKey && !keepingGuide) {
      list.replaceChildren();
      const loading = document.createElement('div');
      loading.className = 'gdh-fomo__empty';
      loading.textContent = '加载中…';
      list.appendChild(loading);
    }
    try {
      const res = await chrome.runtime.sendMessage({
        type: 'fomo-token-feed',
        payload: { tokenAddress: route.address, networkId: route.networkId, kind: fomoTab },
      });
      if (!fomoPanelEl) return;
      if (res?.ok) {
        fomoLoadedKey = key;
        fomoErrKey = '';
        fomoLastItems = res.items || [];
        renderFomoItems(list, fomoLastItems, fomoTab);
      } else {
        fomoErrKey = key;
        fomoErrAt = Date.now();
        const box = await buildFomoErrorBox(res);
        list.replaceChildren(box);
      }
    } catch {
      // 扩展上下文失效
    }
    fomoLoading = false;
  }

  function positionFomoPanel(panel) {
    const pos = settings.fomoPanelPos;
    if (pos && Number.isFinite(pos.x) && Number.isFinite(pos.y)) {
      panel.style.left = `${Math.max(0, Math.min(window.innerWidth - 120, pos.x))}px`;
      panel.style.top = `${Math.max(0, Math.min(window.innerHeight - 60, pos.y))}px`;
      panel.style.right = 'auto';
    } else {
      panel.style.right = '16px';
      panel.style.top = '110px';
      panel.style.left = 'auto';
    }
  }

  function makeFomoDraggable(panel, handle) {
    let sx = 0; let sy = 0; let ox = 0; let oy = 0; let dragging = false;
    handle.addEventListener('pointerdown', (event) => {
      if (event.target.closest('button, a')) return;
      dragging = true;
      const r = panel.getBoundingClientRect();
      sx = event.clientX; sy = event.clientY; ox = r.left; oy = r.top;
      handle.setPointerCapture(event.pointerId);
      event.preventDefault();
    });
    handle.addEventListener('pointermove', (event) => {
      if (!dragging) return;
      const x = Math.max(0, Math.min(window.innerWidth - 120, ox + event.clientX - sx));
      const y = Math.max(0, Math.min(window.innerHeight - 60, oy + event.clientY - sy));
      panel.style.left = `${x}px`;
      panel.style.top = `${y}px`;
      panel.style.right = 'auto';
    });
    handle.addEventListener('pointerup', () => {
      if (!dragging) return;
      dragging = false;
      const r = panel.getBoundingClientRect();
      settings.fomoPanelPos = { x: Math.round(r.left), y: Math.round(r.top) };
      try {
        chrome.storage.local.set({ fomoPanelPos: settings.fomoPanelPos });
      } catch {
        // ignore
      }
    });
  }

  function setFomoOpen(open) {
    settings.fomoPanelOpen = open;
    try {
      chrome.storage.local.set({ fomoPanelOpen: open });
    } catch {
      // ignore
    }
  }

  function buildFomoPanel() {
    const panel = document.createElement('section');
    panel.className = 'gdh-fomo-panel';

    const head = document.createElement('div');
    head.className = 'gdh-fomo__bar';
    const title = document.createElement('strong');
    title.className = 'gdh-fomo__title';
    title.textContent = 'fomo';
    const tabs = document.createElement('div');
    tabs.className = 'gdh-fomo__tabs';
    [['holders', '持仓者'], ['thesis', '观点'], ['swaps', '交易']].forEach(([id, label]) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'gdh-fomo__tab';
      btn.dataset.tab = id;
      btn.textContent = label;
      btn.classList.toggle('is-active', fomoTab === id);
      btn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        fomoTab = id;
        panel.querySelectorAll('.gdh-fomo__tab').forEach((t) => {
          t.classList.toggle('is-active', t.dataset.tab === id);
        });
        loadFomoData(true);
      });
      tabs.appendChild(btn);
    });
    const open = document.createElement('a');
    open.className = 'gdh-fomo__ext';
    open.target = '_blank';
    open.rel = 'noreferrer';
    open.textContent = '↗';
    open.title = '在 fomo.family 打开';
    // 字段没认出来时用它看原始返回，一眼能定位（不需要开 DevTools）
    const dbg = document.createElement('button');
    dbg.type = 'button';
    dbg.className = 'gdh-fomo__dbg';
    dbg.textContent = '{}';
    dbg.title = '显示原始数据（排查字段用）';
    dbg.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const list = panel.querySelector('.gdh-fomo__list');
      const existing = list.querySelector('.gdh-fomo__raw');
      if (existing) {
        existing.remove();
        return;
      }
      const pre = document.createElement('pre');
      pre.className = 'gdh-fomo__raw';
      const first = fomoLastItems[0];
      pre.textContent = first
        ? `共 ${fomoLastItems.length} 条 · 首条字段：\n${JSON.stringify(first, null, 1).slice(0, 1500)}`
        : '当前没有数据（items 为空）';
      list.prepend(pre);
    });

    // 首次下载语言包需要用户手势，所以做成按钮而不是自动开
    const tr = document.createElement('button');
    tr.type = 'button';
    tr.className = 'gdh-fomo__tr';
    tr.textContent = '译';
    tr.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      // 缺语言包时这一下点击就是那个"用户手势"，此时不该顺手把翻译关掉
      if (settings.fomoTranslate && fomoTrStuck) {
        fomoTrStuck = false;
        fomoTrGesture = true;
        fomoTranslators.clear();
        syncFomoTrButton();
        refreshFomoTranslations();
        return;
      }
      if (settings.fomoTranslate && fomoTrNeedsGesture) {
        fomoTrGesture = true;
        fomoTrNeedsGesture = false;
        syncFomoTrButton();
        refreshFomoTranslations();
        return;
      }
      settings.fomoTranslate = !settings.fomoTranslate;
      if (settings.fomoTranslate) fomoTrGesture = true;
      chrome.storage.local.set({ fomoTranslate: settings.fomoTranslate });
      syncFomoTrButton();
      refreshFomoTranslations();
    });

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'gdh-fomo__close';
    close.textContent = '×';
    close.title = '收起（点右下角 fomo 按钮再打开）';
    close.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      setFomoOpen(false);
      scheduleScan();
    });
    head.append(title, tabs, tr, dbg, open, close);

    const list = document.createElement('div');
    list.className = 'gdh-fomo__list';
    panel.append(head, list);
    makeFomoDraggable(panel, head);
    return panel;
  }

  function ensureFomoLauncher() {
    let btn = document.querySelector('.gdh-fomo-launcher');
    if (settings.enableFomoPanel === false || !currentTokenRoute()) {
      btn?.remove();
      return;
    }
    if (!btn) {
      btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'gdh-fomo-launcher';
      btn.textContent = 'fomo';
      btn.title = '查看该代币在 fomo 的观点';
      btn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        setFomoOpen(!settings.fomoPanelOpen);
        scheduleScan();
      });
      document.body.appendChild(btn);
    }
    btn.classList.toggle('is-active', settings.fomoPanelOpen === true);
  }

  function scanFomoPanel() {
    const route = currentTokenRoute();
    if (settings.enableFomoPanel === false || !route || settings.fomoPanelOpen !== true) {
      if (fomoPanelEl) {
        fomoPanelEl.remove();
        fomoPanelEl = null;
        fomoLoadedKey = '';
      }
      if (fomoTimer) {
        window.clearInterval(fomoTimer);
        fomoTimer = 0;
      }
      ensureFomoLauncher();
      return;
    }
    ensureFomoLauncher();
    if (!fomoPanelEl || !document.contains(fomoPanelEl)) {
      fomoPanelEl = buildFomoPanel();
      document.body.appendChild(fomoPanelEl);
      positionFomoPanel(fomoPanelEl);
      syncFomoTrButton();
      fomoLoadedKey = '';
    }
    const slug = FOMO_CHAIN_SLUG[route.chain] || route.chain;
    const ext = fomoPanelEl.querySelector('.gdh-fomo__ext');
    if (ext) ext.href = `https://fomo.family/tokens/${slug}/${route.address}`;
    loadFomoData(false);
    if (!fomoTimer) {
      fomoTimer = window.setInterval(() => {
        if (document.visibilityState === 'visible') loadFomoData(true);
      }, FOMO_REFRESH_MS);
    }
  }

  // ---- 持仓暴涨提醒 ----
  // 清单：持仓面板开着时从行上读 {chain,address,symbol} 缓存下来（面板只显示当前链，
  // 切链再开一次就把那条链也收进来），之后面板关掉也在。
  // 行情：走公开的 mutil_window_token_info（免登录，返回 price 与 price_1m/5m），
  // 全程不碰任何登录凭据。
  const HOLDING_ROW_SELECTOR = '[data-sentry-component="SmToken"]';
  const HOLDING_WATCH_MAX = 80;
  const HOLDING_POLL_MS = 30000;
  /** 同一代币两次播报的最小间隔，单位分钟，可在配置页改（默认 1 小时）。 */
  function holdingCooldownMs() {
    const minutes = Number(settings.holdingSurgeCooldown);
    return (Number.isFinite(minutes) && minutes > 0 ? minutes : 60) * 60 * 1000;
  }
  const HOLDING_BATCH = 40;
  const holdingAlertedAt = new Map();
  let holdingWatchMap = new Map();
  let holdingSaveTimer = 0;
  let holdingPollTimer = 0;
  let holdingPolling = false;

  function rebuildHoldingWatch() {
    holdingWatchMap = new Map(
      (Array.isArray(settings.holdingWatchList) ? settings.holdingWatchList : [])
        .filter((item) => item && item.chain && item.address)
        .map((item) => [
          `${item.chain}:${item.address}`,
          {
            chain: String(item.chain),
            address: String(item.address),
            symbol: String(item.symbol || ''),
            at: Number(item.at) || 0,
          },
        ]),
    );
  }

  function scheduleHoldingSave() {
    if (holdingSaveTimer) return;
    holdingSaveTimer = window.setTimeout(() => {
      holdingSaveTimer = 0;
      const list = [...holdingWatchMap.values()]
        .sort((a, b) => b.at - a.at)
        .slice(0, HOLDING_WATCH_MAX);
      settings.holdingWatchList = list;
      try {
        chrome.storage.local.set({ holdingWatchList: list });
      } catch {
        // context invalidated
      }
    }, 800);
  }

  /** 从持仓面板行收集当前链的持仓，合并进缓存清单。 */
  function collectHoldingRows() {
    let changed = false;
    document.querySelectorAll(HOLDING_ROW_SELECTOR).forEach((row) => {
      const chain = row.getAttribute('data-gdh-hold-chain') || '';
      const address = row.getAttribute('data-gdh-hold-addr') || '';
      if (!chain || !address) return;
      const symbol = row.getAttribute('data-gdh-hold-symbol') || '';
      const key = `${chain}:${address}`;
      const prev = holdingWatchMap.get(key);
      if (!prev || prev.symbol !== symbol) changed = true;
      holdingWatchMap.set(key, { chain, address, symbol, at: Date.now() });
    });
    if (changed) scheduleHoldingSave();
  }

  function formatPriceShort(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return '';
    if (n >= 1) return `$${n.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')}`;
    return `$${n.toPrecision(4)}`;
  }

  async function pollHoldingSurge() {
    if (holdingPolling) return;
    if (settings.enableHoldingSurge === false) return;
    if (!isTabVisibleForHolding()) return;
    const entries = [...holdingWatchMap.values()];
    if (!entries.length) return;

    holdingPolling = true;
    const threshold = Math.max(5, Number(settings.holdingSurgeThreshold) || 20);
    const byChain = new Map();
    entries.forEach((item) => {
      if (!byChain.has(item.chain)) byChain.set(item.chain, []);
      byChain.get(item.chain).push(item);
    });

    for (const [chain, items] of byChain) {
      for (let i = 0; i < items.length; i += HOLDING_BATCH) {
        const slice = items.slice(i, i + HOLDING_BATCH);
        try {
          const res = await fetch(`https://gmgn.ai/api/v1/mutil_window_token_info?${DEV_ATH_QS}`, {
            method: 'POST',
            credentials: 'omit',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chain, addresses: slice.map((s) => s.address) }),
          });
          const body = await res.json().catch(() => null);
          if (!res.ok || body?.code !== 0 || !Array.isArray(body.data)) continue;
          body.data.forEach((token) => {
            const p = token?.price;
            if (!p) return;
            const now = Number(p.price);
            const past = Number(p.price_5m);
            if (!Number.isFinite(now) || !Number.isFinite(past) || past <= 0) return;
            const pct = ((now - past) / past) * 100;
            if (pct < threshold) return;
            const address = String(token.address || p.address || '');
            const key = `${chain}:${address}`;
            const last = holdingAlertedAt.get(key) || 0;
            if (Date.now() - last < holdingCooldownMs()) return;
            holdingAlertedAt.set(key, Date.now());
            const meta = holdingWatchMap.get(key);
            showRemindCard({
              href: `/${chain}/token/${address}`,
              dir: 'up',
              bell: '🚀',
              tagText: '持仓暴涨',
              symbol: meta?.symbol || token.symbol || '持仓代币',
              label: '5分钟',
              value: `+${pct.toFixed(0)}%  ${formatPriceShort(now)}`,
              raw: '',
            });
          });
        } catch {
          // 网络失败静默跳过，下轮再试
        }
      }
    }
    holdingPolling = false;
  }

  function isTabVisibleForHolding() {
    return document.visibilityState === 'visible';
  }

  function startHoldingPoll() {
    if (holdingPollTimer) return;
    holdingPollTimer = window.setInterval(() => {
      pollHoldingSurge().catch(() => {});
    }, HOLDING_POLL_MS);
  }

  function scanHoldingSurge() {
    if (settings.enableHoldingSurge === false) {
      if (holdingPollTimer) {
        window.clearInterval(holdingPollTimer);
        holdingPollTimer = 0;
      }
      return;
    }
    collectHoldingRows();
    startHoldingPoll();
  }

  function scanRemindToasts() {
    if (settings.enableRemindAlert === false) {
      document.querySelectorAll('[data-gdh-remind-taken="1"]').forEach((node) => {
        node.style.removeProperty('display');
        delete node.dataset.gdhRemindTaken;
      });
      remindContainer?.remove();
      remindContainer = null;
      return;
    }
    document.querySelectorAll(REMIND_TOAST_SELECTOR).forEach((node) => {
      if (node.dataset.gdhRemindTaken === '1') return;
      node.dataset.gdhRemindTaken = '1';
      try {
        showRemindCard(remindInfoFromToast(node));
        // 原生小 toast 收起，避免同一条提醒重复出现两次。
        node.style.setProperty('display', 'none', 'important');
      } catch {
        node.style.removeProperty('display');
      }
    });
  }

  function scanFrontrunLightning() {
    if (settings.hideLightningTrade !== true) {
      document
        .querySelectorAll('[data-gdh-hidden-lightning="1"]')
        .forEach(restoreFrontrunHost);
      return;
    }
    document.querySelectorAll(FRONTRUN_LIGHTNING_SELECTOR).forEach(hideFrontrunHost);
    // 兼容旧识别路径：frontrun-csui 容器内文案含"闪电交易"的一并隐藏。
    document.querySelectorAll('frontrun-csui').forEach((host) => {
      try {
        const shadow = host.shadowRoot;
        if (!shadow) return;
        const isLightning = (shadow.textContent || '').includes('闪电交易');
        if (isLightning) hideFrontrunHost(host);
        else if (host.dataset.gdhHiddenLightning === '1') restoreFrontrunHost(host);
      } catch {
        // 第三方结构变化时静默跳过
      }
    });
  }

  // ---- 新宣言弹窗提醒 ----
  const MANI_SEEN_MAX = 500;
  const MANI_SEEN_STORE_KEY = 'maniSeenKeys';
  const MANI_TOAST_MS = 12000;
  const MANI_TOAST_MAX = 3;
  const MANI_BASELINE_FAILSAFE_MS = 8000;
  const maniSeen = new Set();
  let maniSeenLoaded = false;
  let maniSeenSaveTimer = 0;
  let maniBaselineDone = false;
  let maniRailFirstSeenAt = 0;
  let maniContainer = null;

  function maniKeyFromChip(chip) {
    const ulid = chip.dataset.gdhManiUlid || '';
    if (ulid) return ulid;
    const href = chip.getAttribute('href') || '';
    const token = normalizeAddress(
      chip.dataset.gdhManiToken || (href.match(/\/token\/(0x[a-fA-F0-9]{40})/) || [])[1] || '',
    );
    if (!token) return '';
    return `${token}|${chip.dataset.gdhCallerHandle || ''}`;
  }

  function trimManiSeen() {
    if (maniSeen.size <= MANI_SEEN_MAX) return;
    const iterator = maniSeen.values();
    for (let extra = maniSeen.size - MANI_SEEN_MAX; extra > 0; extra -= 1) {
      maniSeen.delete(iterator.next().value);
    }
  }

  // 已见宣言持久化：新页面/新标签页不再把旧宣言当新宣言重复弹。
  function scheduleManiSeenSave() {
    if (maniSeenSaveTimer) return;
    maniSeenSaveTimer = window.setTimeout(() => {
      maniSeenSaveTimer = 0;
      try {
        chrome.storage.local.set({ [MANI_SEEN_STORE_KEY]: [...maniSeen] });
      } catch {
        // context invalidated — 忽略
      }
    }, 400);
  }

  // 合并其他标签页写入的已见集合；不回写，避免多标签互相触发循环。
  function mergeManiSeenKeys(keys) {
    if (!Array.isArray(keys)) return;
    keys.forEach((key) => {
      if (typeof key === 'string' && key) maniSeen.add(key);
    });
    trimManiSeen();
  }

  function rememberManiKey(key) {
    maniSeen.add(key);
    trimManiSeen();
    scheduleManiSeenSave();
  }

  function manifestoTokenHref(chip) {
    const href = chip.getAttribute('href') || '';
    if (/\/token\/0x[a-fA-F0-9]{40}/.test(href)) return href;
    const token = normalizeAddress(chip.dataset.gdhManiToken);
    return token ? `/bsc/token/${token}` : '';
  }

  function ensureManiContainer() {
    if (maniContainer && document.contains(maniContainer)) return maniContainer;
    maniContainer = document.createElement('div');
    maniContainer.className = 'gdh-mani-toast-container';
    document.body.appendChild(maniContainer);
    return maniContainer;
  }

  /**
   * 0.13.0：宣言卡片统一渲染（居中弹窗 + 宣言列表共用），样式对齐 GMGN
   * 官方宣言悬浮卡：头像 / 名字 / 认证√ / 倍数 / 时间 / 正文 / 代币行。
   */
  function buildManiCard(info) {
    const frag = document.createDocumentFragment();

    const head = document.createElement('div');
    head.className = 'gdh-mani-card__head';
    if (info.avatar) {
      const avatar = document.createElement('img');
      avatar.className = 'gdh-mani-card__avatar';
      avatar.src = info.avatar;
      avatar.alt = '';
      avatar.referrerPolicy = 'no-referrer';
      head.appendChild(avatar);
    }
    const main = document.createElement('div');
    main.className = 'gdh-mani-card__main';
    const nameRow = document.createElement('div');
    nameRow.className = 'gdh-mani-card__namerow';
    const nameEl = document.createElement('strong');
    nameEl.className = 'gdh-mani-card__name';
    nameEl.textContent = info.name || info.handle || '匿名';
    nameRow.appendChild(nameEl);
    if (info.verified) {
      const check = document.createElement('span');
      check.className = 'gdh-mani-card__verified';
      check.textContent = '✔';
      check.setAttribute('aria-label', '认证');
      nameRow.appendChild(check);
    }
    const mult = Number(info.multiplier);
    if (Number.isFinite(mult) && mult > 0) {
      const multEl = document.createElement('span');
      multEl.className = 'gdh-mani-card__mult';
      multEl.textContent = `${mult.toFixed(1).replace(/\.0$/, '')}x`;
      nameRow.appendChild(multEl);
    }
    main.appendChild(nameRow);
    if (info.handle) {
      const handleEl = document.createElement('div');
      handleEl.className = 'gdh-mani-card__handle';
      handleEl.textContent = `@${info.handle}`;
      main.appendChild(handleEl);
    }
    head.appendChild(main);
    const timeMs = Number(info.timeMs);
    if (Number.isFinite(timeMs) && timeMs > 0) {
      const timeEl = document.createElement('span');
      timeEl.className = 'gdh-mani-card__time';
      timeEl.textContent = formatRelTime(timeMs);
      head.appendChild(timeEl);
    }
    frag.appendChild(head);

    if (info.text) {
      const textEl = document.createElement('div');
      textEl.className = 'gdh-mani-card__text';
      textEl.textContent = info.text;
      frag.appendChild(textEl);
    }

    const foot = document.createElement('div');
    foot.className = 'gdh-mani-card__foot';
    const symbolEl = document.createElement('strong');
    symbolEl.className = 'gdh-mani-card__symbol';
    symbolEl.textContent = info.symbol || '代币';
    foot.appendChild(symbolEl);
    if (info.usd) {
      const usdEl = document.createElement('span');
      usdEl.className = 'gdh-mani-card__usd';
      usdEl.textContent = `$${info.usd}`;
      foot.appendChild(usdEl);
    }
    const hint = document.createElement('span');
    hint.className = 'gdh-mani-card__hint';
    hint.textContent = '点击进入代币页 →';
    foot.appendChild(hint);
    frag.appendChild(foot);

    return frag;
  }

  function maniInfoFromChip(chip) {
    return {
      avatar: chip.dataset.gdhManiAvatar || '',
      name: chip.dataset.gdhCallerName || '',
      handle: chip.dataset.gdhCallerHandle || '',
      verified: chip.dataset.gdhManiVerified === '1',
      multiplier: chip.dataset.gdhManiMult || '',
      timeMs: chip.dataset.gdhManiTime || '',
      text: chip.dataset.gdhManiText || '',
      symbol: chip.dataset.gdhManiSymbol || '',
      usd: chip.dataset.gdhManiUsd || '',
    };
  }

  function showManifestoToast(chip) {
    const href = manifestoTokenHref(chip);
    if (!href) return;

    const container = ensureManiContainer();
    while (container.children.length >= MANI_TOAST_MAX) {
      container.firstElementChild.remove();
    }

    const toast = document.createElement('div');
    toast.className = 'gdh-mani-toast';
    toast.appendChild(buildManiCard(maniInfoFromChip(chip)));

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'gdh-mani-toast__close';
    close.textContent = '×';
    close.title = '关闭';
    toast.appendChild(close);

    let dismissTimer = 0;
    const dismiss = () => {
      window.clearTimeout(dismissTimer);
      toast.remove();
      if (maniContainer && !maniContainer.children.length) {
        maniContainer.remove();
        maniContainer = null;
      }
    };
    const arm = () => {
      window.clearTimeout(dismissTimer);
      dismissTimer = window.setTimeout(dismiss, MANI_TOAST_MS);
    };
    close.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      dismiss();
    });
    toast.addEventListener('mouseenter', () => window.clearTimeout(dismissTimer));
    toast.addEventListener('mouseleave', arm);
    toast.addEventListener('click', () => {
      dismiss();
      // 原 chip 还在就代理点击（走 GMGN 自己的 SPA 路由），否则整页跳转。
      if (chip.isConnected) chip.click();
      else window.location.assign(href);
    });
    arm();
    container.appendChild(toast);
  }

  // ---- 喊单窗"宣言"标签页：按时间倒序列出当前宣言 ----
  const MANI_LIST_REFRESH_MS = 30000;
  const MANI_LIST_STALE_MS = 15000;
  let maniListOpen = false;
  let maniListTimer = 0;
  let maniListLoading = false;
  let maniListCache = { at: 0, list: [] };

  function formatRelTime(ms) {
    const diff = Math.max(0, Date.now() - Number(ms));
    if (diff < 60e3) return `${Math.max(1, Math.floor(diff / 1e3))}秒前`;
    if (diff < 3600e3) return `${Math.floor(diff / 60e3)}分钟前`;
    if (diff < 86400e3) return `${Math.floor(diff / 3600e3)}小时前`;
    return `${Math.floor(diff / 86400e3)}天前`;
  }

  async function fetchManifestoSnapshot() {
    if (maniListLoading) return;
    maniListLoading = true;
    try {
      const res = await fetch(
        `https://gmgn.ai/api/v1/notification/callout/declaration/global_snapshot?${DEV_ATH_QS}&chains=bsc`,
        { credentials: 'include' },
      );
      const body = await res.json().catch(() => null);
      if (res.ok && body?.code === 0 && Array.isArray(body.data?.list)) {
        maniListCache = { at: Date.now(), list: body.data.list };
      }
    } catch {
      // 网络失败保留旧缓存
    }
    maniListLoading = false;
    if (maniListOpen) scheduleScan();
  }

  function stopManiListTimer() {
    if (maniListTimer) {
      window.clearInterval(maniListTimer);
      maniListTimer = 0;
    }
  }

  function manifestoItemBlocked(item) {
    return isCallerBlocked({
      wallet: normalizeAddress(item.call_wallet),
      handle: normalizeHandle(item.twitter_username),
    });
  }

  function renderManifestoListModal(modal) {
    const items = [...maniListCache.list]
      .filter((item) => !manifestoItemBlocked(item))
      .sort((a, b) => Number(b.create_time) - Number(a.create_time));
    const key = `${maniListCache.at}|${items.map((it) => it.ulid || it.id).join(',')}|${Math.floor(Date.now() / MANI_LIST_REFRESH_MS)}`;
    if (modal.dataset.gdhManiListKey === key) return;
    modal.dataset.gdhManiListKey = key;

    const list = modal.querySelector('.gdh-mani-list__items');
    list.replaceChildren();
    if (!items.length) {
      const empty = document.createElement('div');
      empty.className = 'gdh-mani-list__empty';
      empty.textContent = maniListCache.at ? '当前没有宣言' : '加载中…';
      list.appendChild(empty);
      return;
    }

    for (const item of items) {
      const token = normalizeAddress(item.call_token);
      if (!token) continue;
      const row = document.createElement('a');
      row.className = 'gdh-mani-list__item';
      row.href = `/bsc/token/${token}`;
      row.appendChild(buildManiCard({
        avatar: /^https:\/\//.test(String(item.wallet_avatar || '')) ? item.wallet_avatar : '',
        name: String(item.twitter_name || '').trim(),
        handle: String(item.twitter_username || '').trim(),
        verified: String(item.is_blue_verified) === 'true',
        multiplier: item.multiplier,
        timeMs: item.create_time,
        text: String(item.call_thesis?.source_content || '').trim(),
        symbol: String(item.token_symbol || '代币').slice(0, 24),
        usd: item.amount_usd || '',
      }));

      row.addEventListener('click', (event) => {
        if (event.ctrlKey || event.metaKey || event.shiftKey || event.button === 1) return;
        event.preventDefault();
        event.stopPropagation();
        maniListOpen = false;
        scheduleScan();
        // 宣言栏里同 ulid 的 chip 还在就代理点击（SPA 路由），否则整页跳转。
        const chip = item.ulid
          ? document.querySelector(`${MANIFESTO_SELECTOR}[data-gdh-mani-ulid="${item.ulid}"]`)
          : null;
        if (chip instanceof HTMLElement && chip.isConnected) chip.click();
        else window.location.assign(`/bsc/token/${token}`);
      });
      list.appendChild(row);
    }
  }

  function ensureManifestoListModal(context) {
    let modal = context.panel.querySelector(':scope > .gdh-mani-list-modal');
    if (!maniListOpen) {
      modal?.remove();
      stopManiListTimer();
      return;
    }

    context.panel.classList.add('gdh-callout-panel-host');
    if (!modal) {
      modal = document.createElement('section');
      modal.className = 'gdh-mani-list-modal';
      modal.addEventListener('pointerdown', (event) => event.stopPropagation());

      const header = document.createElement('div');
      header.className = 'gdh-mani-list__header';
      const title = document.createElement('strong');
      title.textContent = '当前宣言 · 按时间';
      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'gdh-mani-list__close';
      close.textContent = '×';
      close.title = '关闭宣言列表';
      close.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        maniListOpen = false;
        modal.remove();
        stopManiListTimer();
        scheduleScan();
      });
      header.append(title, close);

      const list = document.createElement('div');
      list.className = 'gdh-mani-list__items';
      modal.append(header, list);
      context.panel.appendChild(modal);
    }

    // 挂在 GMGN tab 行下方，保留 tab 行可点（点官方 tab 会关掉本列表）。
    try {
      const firstTab = context.panel.querySelector('button[data-sentry-component="renderTab"]');
      const rowRect = (firstTab?.parentElement || context.header).getBoundingClientRect();
      const panelRect = context.panel.getBoundingClientRect();
      const top = Math.max(40, Math.round(rowRect.bottom - panelRect.top) + 6);
      modal.style.top = `${top}px`;
    } catch {
      modal.style.top = '76px';
    }

    if (Date.now() - maniListCache.at > MANI_LIST_STALE_MS) fetchManifestoSnapshot();
    if (!maniListTimer) {
      maniListTimer = window.setInterval(fetchManifestoSnapshot, MANI_LIST_REFRESH_MS);
    }
    renderManifestoListModal(modal);
  }

  function ensureManifestoTab() {
    if (settings.enableManifestoTab === false) {
      document
        .querySelectorAll('.gdh-mani-tab-button, .gdh-mani-list-modal')
        .forEach((node) => node.remove());
      maniListOpen = false;
      stopManiListTimer();
      return;
    }
    const context = getCalloutPanelContext();
    if (!context) {
      if (maniListOpen) {
        maniListOpen = false;
        stopManiListTimer();
      }
      return;
    }
    const firstTab = context.panel.querySelector('button[data-sentry-component="renderTab"]');
    const tabsInner = firstTab?.parentElement;
    if (!(tabsInner instanceof HTMLElement)) return;

    let button = tabsInner.querySelector(':scope > .gdh-mani-tab-button');
    if (!button) {
      button = document.createElement('button');
      button.type = 'button';
      button.className = 'gdh-mani-tab-button';
      button.title = '按时间查看当前宣言';
      button.addEventListener('pointerdown', (event) => event.stopPropagation());
      button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        maniListOpen = !maniListOpen;
        if (maniListOpen) blacklistModalOpen = false;
        scheduleScan();
      });
      tabsInner.appendChild(button);
      if (!tabsInner.dataset.gdhManiTabWatch) {
        tabsInner.dataset.gdhManiTabWatch = '1';
        tabsInner.addEventListener(
          'click',
          (event) => {
            if (!maniListOpen) return;
            if (event.target.closest?.('button[data-sentry-component="renderTab"]')) {
              maniListOpen = false;
              scheduleScan();
            }
          },
          true,
        );
      }
    }
    const visible = maniListCache.list.filter((item) => !manifestoItemBlocked(item)).length;
    const label = maniListCache.at && visible ? `宣言 ${visible}` : '宣言';
    if (button.textContent !== label) button.textContent = label;
    button.classList.toggle('is-active', maniListOpen);
    ensureManifestoListModal(context);
  }

  function scanManifestoToasts() {
    if (settings.enableManifestoToast === false) {
      maniContainer?.remove();
      maniContainer = null;
      return;
    }
    if (!maniSeenLoaded) return;
    const chips = [...document.querySelectorAll(MANIFESTO_SELECTOR)];
    const railExists = chips.length > 0
      || !!document.querySelector('[data-sentry-component="ManifestoRailInner"]');
    if (!railExists) return;

    if (!maniBaselineDone) {
      if (!maniRailFirstSeenAt) maniRailFirstSeenAt = Date.now();
      // 0.10.1: 空栏不算基线——GMGN 先挂空容器、快照晚到，过早提交会把
      // 旧宣言全判成新宣言（新开页面重复弹）。等到有完整可识别的宣言才提交；
      // 真·无宣言的页面走 8s 兜底。
      const failsafeElapsed =
        Date.now() - maniRailFirstSeenAt >= MANI_BASELINE_FAILSAFE_MS;
      const snapshotReady =
        chips.length > 0 && chips.every((chip) => maniKeyFromChip(chip));
      if (!snapshotReady && !failsafeElapsed) return;
      chips.forEach((chip) => {
        const key = maniKeyFromChip(chip);
        if (key) rememberManiKey(key);
      });
      maniBaselineDone = true;
      return;
    }

    chips.forEach((chip) => {
      const key = maniKeyFromChip(chip);
      if (!key || maniSeen.has(key)) return;
      rememberManiKey(key);
      if (isCallerBlocked(getCallerFromElement(chip))) return;
      showManifestoToast(chip);
    });
  }

  function scanCalloutBlacklist() {
    if (settings.enableCalloutBlacklist === false) {
      blacklistModalOpen = false;
      document.querySelectorAll('.gdh-callout-blacklist-button, .gdh-callout-block-button, .gdh-callout-blacklist-modal, .gdh-callout-toast')
        .forEach((element) => element.remove());
      document.querySelectorAll('[data-gdh-callout-host="1"]').forEach((host) => {
        delete host.dataset.gdhCalloutHost;
        delete host.dataset.gdhCallerBlocked;
      });
      document.querySelectorAll(`${MANIFESTO_SELECTOR}[data-gdh-caller-blocked="1"]`)
        .forEach((chip) => delete chip.dataset.gdhCallerBlocked);
      document.querySelectorAll('.gdh-callout-panel-host')
        .forEach((panel) => panel.classList.remove('gdh-callout-panel-host'));
      return;
    }

    document.querySelectorAll(CALLOUT_SELECTOR).forEach(applyCalloutCardState);
    document.querySelectorAll(MANIFESTO_SELECTOR).forEach(applyManifestoState);
    ensureCalloutControls();
  }

  function scanCards() {
    scanScheduled = false;
    if (settings.showDevTooltip === false) {
      activeCard = null;
      tooltip?.classList.remove('gdh-tooltip--visible');
    }
    document.documentElement.style.setProperty(
      '--gdh-highlight',
      settings.highlightColor || DEFAULTS.highlightColor,
    );
    scanVisibleCards();
    ensureDeveloperBookmarkButtons();
  }

  function scanVisibleCards() {
    document.querySelectorAll(CARD_SELECTOR).forEach(applyCardState);
    scanCalloutBlacklist();
    scanManifestoToasts();
    ensureManifestoTab();
    scanSpecialWallets();
    scanFrontrunLightning();
    scanRemindToasts();
    scanHoldingSurge();
    scanFomoPanel();
  }

  function scheduleScan() {
    if (scanScheduled) return;
    scanScheduled = true;
    window.setTimeout(scanCards, 0);
  }

  function scheduleScrollScan(event) {
    const target = event.target;
    if (!(target instanceof Element)
      || (!target.closest('[data-sentry-component="PumpSubX"]')
        && !target.closest('[data-testid="trench-token-card"]'))) {
      return;
    }

    window.clearTimeout(scrollScanTimer);
    scrollScanTimer = window.setTimeout(() => {
      scrollScanTimer = 0;
      scheduleScan();
    }, 100);
  }

  function ensureTooltip() {
    if (tooltip) return tooltip;

    tooltip = document.createElement('div');
    tooltip.className = 'gdh-tooltip';
    tooltip.setAttribute('role', 'tooltip');

    const title = document.createElement('div');
    title.className = 'gdh-tooltip__title';
    title.dataset.field = 'title';
    tooltip.appendChild(title);

    const address = document.createElement('div');
    address.className = 'gdh-tooltip__address';
    address.dataset.field = 'address';
    tooltip.appendChild(address);

    const fields = [
      ['Dev 发币迁移数', 'migrated'],
      ['Dev 发币总数', 'total'],
      ['Dev 发币迁移比例', 'ratio'],
    ];
    for (const [labelText, field] of fields) {
      const row = document.createElement('div');
      row.className = 'gdh-tooltip__row';
      const label = document.createElement('span');
      label.textContent = labelText;
      const value = document.createElement('strong');
      value.dataset.field = field;
      row.append(label, value);
      tooltip.appendChild(row);
    }

    document.body.appendChild(tooltip);
    return tooltip;
  }

  function setTooltipField(field, value) {
    ensureTooltip().querySelector(`[data-field="${field}"]`).textContent = value;
  }

  function fillTooltip(card) {
    const label = card.dataset.gdhWatchLabel;
    const symbol = card.dataset.gdhSymbol;
    setTooltipField('title', label || symbol || '重点 Dev');
    setTooltipField('address', card.dataset.gdhCreator || '--');
    setTooltipField('migrated', formatCount(card.dataset.gdhMigrated));
    setTooltipField('total', formatCount(card.dataset.gdhTotal));
    setTooltipField('ratio', formatRatio(card));
  }

  function positionTooltip(event) {
    if (!tooltip || !tooltip.classList.contains('gdh-tooltip--visible')) return;
    const gap = 14;
    const rect = tooltip.getBoundingClientRect();
    let left = event.clientX + gap;
    let top = event.clientY + gap;
    if (left + rect.width + 10 > window.innerWidth) left = event.clientX - rect.width - gap;
    if (top + rect.height + 10 > window.innerHeight) top = event.clientY - rect.height - gap;
    tooltip.style.left = `${Math.max(8, left)}px`;
    tooltip.style.top = `${Math.max(8, top)}px`;
  }

  function findWatchedCard(target) {
    if (settings.showDevTooltip === false || !(target instanceof Element)) return null;
    return target.closest(`${CARD_SELECTOR}[data-gdh-watched="1"]`);
  }

  document.addEventListener(
    'pointerover',
    (event) => {
      const card = findWatchedCard(event.target);
      if (!card || card === activeCard) return;
      activeCard = card;
      fillTooltip(card);
      ensureTooltip().classList.add('gdh-tooltip--visible');
      positionTooltip(event);
    },
    true,
  );

  document.addEventListener(
    'pointerout',
    (event) => {
      if (!activeCard) return;
      if (event.relatedTarget instanceof Node && activeCard.contains(event.relatedTarget)) return;
      const leavingCard = findWatchedCard(event.target);
      if (leavingCard !== activeCard) return;
      activeCard = null;
      tooltip?.classList.remove('gdh-tooltip--visible');
    },
    true,
  );

  document.addEventListener('pointermove', positionTooltip, true);
  document.addEventListener('scroll', scheduleScrollScan, true);

  const observer = new MutationObserver(scheduleScan);
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: [
      'data-gdh-creator',
      'data-gdh-migrated',
      'data-gdh-total',
      'data-gdh-ratio',
      'data-gdh-symbol',
      'data-gdh-ready',
      'data-gdh-caller-ready',
      'data-gdh-caller-wallet',
      'data-gdh-caller-handle',
      'data-gdh-caller-name',
      'href',
    ],
  });

  chrome.storage.local.get(DEFAULTS, (stored) => {
    settings = { ...DEFAULTS, ...stored };
    rebuildWatchedMap();
    rebuildBlockedCallerIndex();
    rebuildBlockedTokenIndex();
    rebuildSpecialWalletSet();
    rebuildHoldingWatch();
    scheduleScan();
  });

  chrome.storage.local.get({ [MANI_SEEN_STORE_KEY]: [] }, (stored) => {
    mergeManiSeenKeys(stored[MANI_SEEN_STORE_KEY]);
    maniSeenLoaded = true;
    scheduleScan();
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    let fomoTokenArrived = false;
    for (const [key, change] of Object.entries(changes)) {
      if (key === MANI_SEEN_STORE_KEY) {
        mergeManiSeenKeys(change.newValue);
        continue;
      }
      // 令牌不是设置项，别塞进 settings；它一到位就把浮窗接上，省得用户回来手动点重试
      if (key === 'fomoToken') {
        fomoTokenArrived = !!change.newValue?.token;
        continue;
      }
      settings[key] = change.newValue;
    }
    if (fomoTokenArrived && fomoPanelEl) {
      fomoLoadedKey = '';
      fomoErrKey = '';
      loadFomoData(true);
    }
    rebuildWatchedMap();
    rebuildBlockedCallerIndex();
    rebuildBlockedTokenIndex();
    rebuildSpecialWalletSet();
    rebuildHoldingWatch();
    scheduleScan();
  });

  window.setInterval(scanVisibleCards, 1000);
})();
