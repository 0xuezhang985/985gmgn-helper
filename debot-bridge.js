'use strict';

(() => {
  if (location.hostname !== 'debot.ai') return;

  const ROW_SELECTOR = 'tbody tr';
  const OWNED_SELECTOR = '[data-gdh-debot-fomo-key]';
  const TRACK_ATTRS = [
    'data-gdh-debot-track-chain',
    'data-gdh-debot-track-token',
    'data-gdh-debot-track-wallet',
    'data-gdh-debot-track-side',
    'data-gdh-debot-track-tx',
    'data-gdh-debot-track-usd',
    'data-gdh-debot-track-mc',
    'data-gdh-debot-track-ts',
    'data-gdh-debot-track-symbol',
  ];

  let scanRaf = 0;
  let scanDelay = 0;
  let lastScanAt = 0;
  let scrollingUntil = 0;

  function onTrackPage() {
    if (location.pathname !== '/track') return false;
    return new URLSearchParams(location.search).get('tab') === 'track';
  }

  function safeString(value, max = 128) {
    return typeof value === 'string'
      ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max)
      : '';
  }

  function eventTimeMs(value) {
    const n = Number(value);
    if (n > 1.4e9 && n < 4.1e9) return Math.round(n * 1000);
    if (n > 1.4e12 && n < 4.1e12) return Math.round(n);
    return 0;
  }

  /**
   * DeBot 2.2.84 的 TrackContent 把 socket 事件清洗为
   * { token, chain, trader, time, op, volume, tx, mc }。只接受这组完整字段，
   * 避免把同页的钱包管理、筛选器或代币元数据对象误标成追踪成交。
   */
  function normalizeTrackRecord(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const chain = safeString(value.chain, 24).toLowerCase();
    const token = safeString(value.token, 96);
    const wallet = safeString(value.trader || value.wallet, 96);
    const side = safeString(value.op, 16).toLowerCase();
    const ts = eventTimeMs(value.time ?? value.unix_time);
    const usd = Number(value.volume);
    const mc = Number(value.mc);
    if (!/^[a-z0-9_-]{2,24}$/.test(chain) || !token || !wallet
      || (side !== 'buy' && side !== 'sell') || !ts || !Number.isFinite(usd)) return null;
    return {
      chain,
      token,
      wallet,
      side,
      tx: safeString(value.tx || value.tx_hash, 180),
      usd: usd > 0 ? usd : 0,
      mc: Number.isFinite(mc) && mc > 0 ? mc : 0,
      ts,
    };
  }

  function findTrackRecord(value, depth = 0, seen = new Set()) {
    if (!value || typeof value !== 'object' || depth > 4 || seen.has(value)) return null;
    seen.add(value);
    const direct = normalizeTrackRecord(value);
    if (direct) return direct;
    let keys;
    try { keys = Object.keys(value); } catch { return null; }
    for (const key of keys.slice(0, 60)) {
      if (['_owner', 'return', 'child', 'sibling', 'alternate', 'stateNode'].includes(key)) continue;
      let child;
      try { child = value[key]; } catch { continue; }
      if (!child || typeof child !== 'object') continue;
      const hit = findTrackRecord(child, depth + 1, seen);
      if (hit) return hit;
    }
    return null;
  }

  function readTrackRecord(element) {
    const fiberKey = Object.keys(element).find((key) => key.startsWith('__reactFiber$'));
    const propsKey = Object.keys(element).find((key) => key.startsWith('__reactProps$'));
    if (propsKey) {
      const hit = findTrackRecord(element[propsKey]);
      if (hit) return hit;
    }
    let fiber = fiberKey ? element[fiberKey] : null;
    for (let level = 0; fiber && level < 16; level += 1) {
      for (const node of [fiber, fiber.alternate]) {
        if (!node) continue;
        for (const props of [node.memoizedProps, node.pendingProps]) {
          const hit = findTrackRecord(props);
          if (hit) return hit;
        }
      }
      fiber = fiber.return;
    }
    return null;
  }

  function setAttr(element, name, value) {
    const next = String(value ?? '');
    if (element.getAttribute(name) === next) return false;
    element.setAttribute(name, next);
    return true;
  }

  function clearTrackAttrs(row) {
    let changed = false;
    for (const attr of TRACK_ATTRS) {
      if (!row.hasAttribute(attr)) continue;
      row.removeAttribute(attr);
      changed = true;
    }
    return changed;
  }

  function rowSymbol(row) {
    const link = row.querySelector('a[href*="/token/"]');
    if (!link) return '';
    const candidates = [...link.querySelectorAll('span, strong, p')]
      .map((node) => safeString(node.textContent, 24))
      .filter((text) => /^[\p{L}\p{N}._$-]{1,24}$/u.test(text));
    return (candidates.at(-1) || '').replace(/^\$/, '');
  }

  function scanRow(row) {
    if (!(row instanceof HTMLElement) || row.matches(OWNED_SELECTOR)) return false;
    const record = readTrackRecord(row);
    if (!record) return clearTrackAttrs(row);
    let changed = false;
    changed = setAttr(row, 'data-gdh-debot-track-chain', record.chain) || changed;
    changed = setAttr(row, 'data-gdh-debot-track-token', record.token) || changed;
    changed = setAttr(row, 'data-gdh-debot-track-wallet', record.wallet) || changed;
    changed = setAttr(row, 'data-gdh-debot-track-side', record.side) || changed;
    changed = setAttr(row, 'data-gdh-debot-track-ts', record.ts) || changed;
    if (record.tx) changed = setAttr(row, 'data-gdh-debot-track-tx', record.tx) || changed;
    else if (row.hasAttribute('data-gdh-debot-track-tx')) {
      row.removeAttribute('data-gdh-debot-track-tx'); changed = true;
    }
    if (record.usd) changed = setAttr(row, 'data-gdh-debot-track-usd', record.usd) || changed;
    if (record.mc) changed = setAttr(row, 'data-gdh-debot-track-mc', record.mc) || changed;
    const symbol = rowSymbol(row);
    if (symbol) changed = setAttr(row, 'data-gdh-debot-track-symbol', symbol) || changed;
    return changed;
  }

  function scan() {
    scanRaf = 0;
    if (!onTrackPage() || document.visibilityState === 'hidden') return;
    const now = Date.now();
    if (now < scrollingUntil && now - lastScanAt < 150) {
      if (!scanDelay) {
        scanDelay = window.setTimeout(() => {
          scanDelay = 0;
          scheduleScan();
        }, Math.max(1, 150 - (now - lastScanAt)));
      }
      return;
    }
    lastScanAt = now;
    let changed = false;
    let examined = 0;
    for (const row of document.querySelectorAll(ROW_SELECTOR)) {
      if (examined >= 120) break;
      if (!(row instanceof HTMLElement) || !row.querySelector('a[href*="/token/"]')) continue;
      examined += 1;
      changed = scanRow(row) || changed;
    }
    if (changed) document.dispatchEvent(new Event('gdh-debot-track-ready'));
  }

  function scheduleScan() {
    if (scanRaf || scanDelay || document.visibilityState === 'hidden') return;
    scanRaf = window.requestAnimationFrame(scan);
  }

  function start() {
    const observer = new MutationObserver((records) => {
      if (records.some((record) => {
        const target = record.target instanceof Element ? record.target : record.target?.parentElement;
        return !target?.closest(OWNED_SELECTOR);
      })) scheduleScan();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    document.addEventListener('scroll', () => {
      scrollingUntil = Date.now() + 220;
      scheduleScan();
    }, true);
    document.addEventListener('visibilitychange', scheduleScan);
    window.addEventListener('popstate', scheduleScan);
    window.setInterval(scheduleScan, 1200);
    scheduleScan();
  }

  if (document.documentElement) start();
  else document.addEventListener('DOMContentLoaded', start, { once: true });
})();
