(() => {
  'use strict';

  if (window.__gdhPageBridgeStarted) return;
  window.__gdhPageBridgeStarted = true;

  const CARD_SELECTOR =
    '[data-sentry-source-file="TokenItem.tsx"][href^="/bsc/token/"]';
  const CALLOUT_SELECTOR = '[data-sentry-component="CalloutItem"]';
  const MANIFESTO_SELECTOR = '[data-sentry-component="ManifestoChipInner"]';
  const HOLDING_ROW_SELECTOR = '[data-sentry-component="SmToken"]';
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

    const match = (card.getAttribute('href') || '').match(
      /\/bsc\/token\/(0x[a-fA-F0-9]{40})/,
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
    if (!card.closest('[data-sentry-component="PumpSubX"]')) return;
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
  function readHoldingToken(element) {
    const fiberKey = Object.keys(element).find((key) => key.startsWith('__reactFiber$'));
    if (!fiberKey) return null;
    const pick = (value, depth) => {
      if (!value || typeof value !== 'object' || depth > 4) return null;
      if (value.address && value.symbol && value.chain) return value;
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
            };
          }
        }
      }
      fiber = fiber.return;
    }
    return null;
  }

  function scanHoldingRow(element) {
    const data = readHoldingToken(element);
    if (!data || !data.chain || !data.address) {
      element.removeAttribute('data-gdh-hold-chain');
      element.removeAttribute('data-gdh-hold-addr');
      element.removeAttribute('data-gdh-hold-symbol');
      return;
    }
    setAttribute(element, 'data-gdh-hold-chain', data.chain);
    setAttribute(element, 'data-gdh-hold-addr', data.address);
    setAttribute(element, 'data-gdh-hold-symbol', data.symbol);
  }

  function scanCards() {
    scanScheduled = false;
    document.querySelectorAll(HOLDING_ROW_SELECTOR).forEach(scanHoldingRow);
    document.querySelectorAll(CARD_SELECTOR).forEach(scanCard);
    document.querySelectorAll(CALLOUT_SELECTOR).forEach((element) => {
      scanCallerElement(element, 'callout');
    });
    document.querySelectorAll(MANIFESTO_SELECTOR).forEach((element) => {
      scanCallerElement(element, 'manifesto');
    });
  }

  function scheduleScan() {
    if (scanScheduled) return;
    scanScheduled = true;
    window.setTimeout(scanCards, 0);
  }

  const observer = new MutationObserver(scheduleScan);
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['href', 'data-gmgn-fee-mode-card'],
  });

  scheduleScan();
  window.setInterval(scheduleScan, 1200);
})();
