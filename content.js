(() => {
  'use strict';

  if (window.__gdhContentStarted) return;
  window.__gdhContentStarted = true;

  const CARD_SELECTOR =
    '[data-sentry-source-file="TokenItem.tsx"][href^="/bsc/token/"]';
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
    watchedDevs: [],
    blockedCallers: [],
    specialWallets: [],
    highlightColor: '#f5b83d',
  };

  let settings = { ...DEFAULTS };
  let watchedMap = new Map();
  let blockedWallets = new Set();
  let blockedHandles = new Set();
  let specialWalletSet = new Set();
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

  function rebuildSpecialWalletSet() {
    specialWalletSet = new Set(
      (Array.isArray(settings.specialWallets) ? settings.specialWallets : [])
        .map((item) => normalizeAddress(item?.address))
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
    if (!card.closest('[data-sentry-component="PumpSubX"]')) return;

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

  // ---- 钱包追踪"特别关注"高亮 ----
  const TRACKER_ITEM_SELECTOR = '[data-sentry-component="TrackerListItem"]';
  const WALLET_TABLE_SELECTOR = '[data-sentry-component="WalletTable"]';

  function extractRowWalletAddress(scope) {
    const link = scope.querySelector('a[href*="/address/0x"]');
    const match = link?.getAttribute('href')?.match(/\/address\/(0x[a-fA-F0-9]{40})/);
    return match ? match[1].toLowerCase() : '';
  }

  function extractRowWalletLabel(scope) {
    const link = scope.querySelector('a[href*="/address/0x"]');
    return String(link?.textContent || '').trim().slice(0, 32);
  }

  function isSpecialWallet(address) {
    return Boolean(address && specialWalletSet.has(address));
  }

  function toggleSpecialWallet(address, label) {
    if (!address) return;
    const current = Array.isArray(settings.specialWallets) ? settings.specialWallets : [];
    const exists = current.some((item) => normalizeAddress(item?.address) === address);
    const next = exists
      ? current.filter((item) => normalizeAddress(item?.address) !== address)
      : [...current, { address, label: label || '' }];
    settings.specialWallets = next;
    rebuildSpecialWalletSet();
    scanSpecialWallets();
    chrome.storage.local.set({ specialWallets: next }, () => {
      const error = chrome.runtime?.lastError;
      if (error) {
        settings.specialWallets = current;
        rebuildSpecialWalletSet();
        scanSpecialWallets();
      }
    });
  }

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
    const text = starred ? '★' : '☆';
    if (button.textContent !== text) button.textContent = text;
    button.classList.toggle('is-starred', starred);
    button.title = starred ? '取消特别关注' : '特别关注';
    return button;
  }

  function applySpecialState(host, address) {
    if (isSpecialWallet(address)) host.dataset.gdhSpecial = '1';
    else delete host.dataset.gdhSpecial;
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
      document.querySelectorAll('.gdh-star-button').forEach((node) => node.remove());
      document.querySelectorAll('[data-gdh-special="1"]').forEach((node) => {
        delete node.dataset.gdhSpecial;
      });
      document.querySelectorAll('[data-gdh-star-host="1"]').forEach((node) => {
        delete node.dataset.gdhStarHost;
      });
      return;
    }

    // 追踪事件卡：卡片即 <a>，钱包地址取内部 /address/ 链接。
    document.querySelectorAll(TRACKER_ITEM_SELECTOR).forEach((card) => {
      const address = extractRowWalletAddress(card);
      if (!address) return;
      if (card.dataset.gdhStarHost !== '1') card.dataset.gdhStarHost = '1';
      applySpecialState(card, address);
      ensureStarButton(
        card,
        address,
        extractRowWalletLabel(card),
        findCardActionContainer(card),
        'append',
      );
    });

    // 钱包列表行：从地址链接爬到行容器。
    document.querySelectorAll(WALLET_TABLE_SELECTOR).forEach((table) => {
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
  }

  function scheduleScan() {
    if (scanScheduled) return;
    scanScheduled = true;
    window.setTimeout(scanCards, 0);
  }

  function scheduleScrollScan(event) {
    const target = event.target;
    if (!(target instanceof Element) || !target.closest('[data-sentry-component="PumpSubX"]')) {
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
    rebuildSpecialWalletSet();
    scheduleScan();
  });

  chrome.storage.local.get({ [MANI_SEEN_STORE_KEY]: [] }, (stored) => {
    mergeManiSeenKeys(stored[MANI_SEEN_STORE_KEY]);
    maniSeenLoaded = true;
    scheduleScan();
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    for (const [key, change] of Object.entries(changes)) {
      if (key === MANI_SEEN_STORE_KEY) {
        mergeManiSeenKeys(change.newValue);
        continue;
      }
      settings[key] = change.newValue;
    }
    rebuildWatchedMap();
    rebuildBlockedCallerIndex();
    rebuildSpecialWalletSet();
    scheduleScan();
  });

  window.setInterval(scanVisibleCards, 1000);
})();
