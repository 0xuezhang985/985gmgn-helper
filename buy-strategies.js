/* Buy-only strategies over already loaded tracking rows. No network or DOM observer. */
(() => {
  'use strict';
  const text = (v, max = 64) => String(v || '').trim().slice(0, max);
  const address = (v) => /^0x[\da-f]{40}$/i.test(String(v || '')) ? String(v).toLowerCase()
    : /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(String(v || '')) ? String(v) : '';
  const members = (v) => [...new Map((Array.isArray(v) ? v : []).slice(0, 20)
    .map((p) => [address(p?.address), { address: address(p?.address), label: text(p?.label) }])
    .filter(([a]) => a)).values()].sort((a, b) => a.address.localeCompare(b.address));
  function normalize(raw = {}) {
    const group = raw?.group || {}, amount = raw?.amount || {};
    const gw = members(group.wallets), aw = members(amount.wallets);
    const seconds = Number(group.windowSeconds), usd = Number(amount.minUsd);
    return {
      group: { enabled: group.enabled === true && gw.length >= 2, wallets: gw,
        windowSeconds: Number.isFinite(seconds) && seconds >= 10 && seconds <= 3600 ? Math.floor(seconds) : 300 },
      amount: { enabled: amount.enabled === true && aw.length > 0 && Number.isFinite(usd) && usd > 0,
        wallets: aw, minUsd: Number.isFinite(usd) && usd > 0 ? usd : 1000 },
    };
  }
  const enabled = (raw) => { const c = normalize(raw); return c.group.enabled || c.amount.enabled; };
  function parseWallets(value) {
    const rows = new Map();
    String(value || '').split(/\r?\n/).forEach((line, index) => {
      if (!line.trim()) return;
      const [raw, ...label] = line.trim().split(/\s+/), a = address(raw);
      if (!a) throw new Error(`第 ${index + 1} 行需要完整的钱包地址，不能仅填人名`);
      rows.set(a, { address: a, label: text(label.join(' ')) });
    });
    if (rows.size > 20) throw new Error('每种策略最多指定 20 人');
    return [...rows.values()];
  }
  function create(now = Date.now) {
    let config = normalize(), key = '', since = Infinity;
    const seen = new Map(), groups = new Map();
    return {
      configure(raw) {
        const next = normalize(raw), nextKey = JSON.stringify(next);
        if (nextKey === key) return false;
        config = next; key = nextKey; since = now(); seen.clear(); groups.clear();
        return true;
      },
      ingest(events) {
        if (!config.group.enabled && !config.amount.enabled) return [];
        const time = now(), windowMs = config.group.windowSeconds * 1000;
        const maxAge = Math.max(windowMs, 300000), out = [];
        const gm = new Map(config.group.wallets.map(p => [p.address, p]));
        const am = new Map(config.amount.wallets.map(p => [p.address, p]));
        for (const [id, entry] of seen) if (time - entry.ts > maxAge) seen.delete(id);
        for (const [token, buyers] of groups) {
          for (const [wallet, event] of buyers) if (time - event.ts > windowMs) buyers.delete(wallet);
          if (!buyers.size) groups.delete(token);
        }
        const ordered = (events || []).map(raw => {
          const ts = Number(raw?.ts), wallet = address(raw?.wallet), token = address(raw?.token);
          const chain = text(raw?.chain, 24).toLowerCase();
          const tx = text(raw?.tx, 180); const normalizedTx = tx.startsWith('0x') ? tx.toLowerCase() : tx;
          if (raw?.side !== 'buy' || !wallet || !token || !/^[a-z0-9_-]+$/.test(chain) || !Number.isFinite(ts) || ts <= 0) return null;
          const event = { ...raw, wallet, token, chain, ts: ts < 1e11 ? ts * 1000 : ts };
          event.id = [chain, token, wallet, normalizedTx || `time:${event.ts}`].join('|');
          return event;
        }).filter(Boolean).sort((a,b) => a.ts-b.ts || a.id.localeCompare(b.id));
        for (const event of ordered) {
          if (event.ts < since || event.ts > time + 5000 || time - event.ts > maxAge) continue;
          if (!(config.group.enabled && gm.has(event.wallet)) && !(config.amount.enabled && am.has(event.wallet))) continue;
          const previous = seen.get(event.id) || { ts: event.ts, group: false, amount: false };
          const reasons = [];
          if (config.group.enabled && gm.has(event.wallet) && !previous.group && time-event.ts <= windowMs) {
            previous.group = true;
            const tokenKey = `${event.chain}|${event.token}`;
            const buyers = groups.get(tokenKey) || new Map(); groups.set(tokenKey, buyers);
            for (const [wallet, buy] of buyers) if (event.ts-buy.ts > windowMs) buyers.delete(wallet);
            const last = buyers.get(event.wallet);
            if (!last || event.ts >= last.ts) buyers.set(event.wallet, event);
            if (buyers.size === gm.size) {
              const names = config.group.wallets.map(p => p.label || `${p.address.slice(0,6)}…${p.address.slice(-4)}`);
              reasons.push(`${config.group.windowSeconds} 秒内共同买入：${names.join('、')}`);
              groups.delete(tokenKey); // A new group alert needs a new buy from every member.
            }
          }
          const usd = Number(event.usd);
          if (config.amount.enabled && am.has(event.wallet) && !previous.amount && Number.isFinite(usd) && usd > config.amount.minUsd && time-event.ts <= 300000) {
            previous.amount = true;
            const name = am.get(event.wallet).label || text(event.name) || event.wallet;
            reasons.push(`${name} 单笔买入 $${usd.toLocaleString('en-US', { maximumFractionDigits: 2 })} > $${config.amount.minUsd.toLocaleString('en-US')}`);
          }
          seen.set(event.id, previous);
          if (reasons.length) out.push({ key: key + '|' + event.id, record: { wallet: event.wallet, href: event.href,
            strategy: true, name: `买入策略 · ${text(event.symbol) || event.token.slice(0, 10)}`,
            detail: `${event.chain.toUpperCase()} · ${reasons.join('；')}` } });
        }
        return out;
      },
    };
  }
  function fromRow(row, site) {
    const d = row.dataset;
    const own = d.gdhStrategyWallet !== undefined;
    const prefix = own ? 'gdhStrategy' : site === 'debot.ai' ? 'gdhDebotTrack' : 'gdhTrack';
    const get = (key) => d[prefix + key];
    const href = (row.matches('a[href*="/token/"]') ? row.getAttribute('href') : row.querySelector('a[href*="/token/"]')?.getAttribute('href'))
      || (own ? (site === 'gmgn.ai' ? `/${get('Chain')}/token/${get('Token')}` : `/token/${get('Chain')}/${get('Token')}`) : '');
    if (!href) return null;
    const event = { wallet: get(own || site === 'debot.ai' ? 'Wallet' : 'Maker'),
      token: get(own || site === 'debot.ai' ? 'Token' : 'Addr'), chain: get('Chain'), side: get('Side'),
      ts: get('Ts'), tx: get('Tx'), usd: get('Usd'), symbol: get('Symbol'), name: get('Nick'), href };
    try {
      const url = new URL(href, `https://${site}`), parts = url.pathname.split('/').filter(Boolean);
      if (url.origin !== `https://${site}` || parts[site === 'gmgn.ai' ? 1 : 0] !== 'token'
        || parts[site === 'gmgn.ai' ? 0 : 1] !== event.chain || address(parts[2]) !== address(event.token)) return null;
    } catch { return null; }
    return event;
  }
  function tagFeed(row, event) {
    // FOMO events without a verifiable wallet are not matched by nickname.
    const wallet = address(event?.pumpWallet || event?.wallet);
    if (!wallet) return;
    for (const [key, value] of Object.entries({ Wallet: wallet, Token: event.addr, Chain: event.chain, Side: event.type,
      Ts: event.ts, Tx: event.tx, Usd: event.usd, Symbol: event.symbol, Nick: event.name || event.handle })) {
      const name = 'gdhStrategy' + key;
      if (value != null && row.dataset[name] !== String(value)) row.dataset[name] = String(value);
    }
  }
  globalThis.GdhBuyStrategies = { normalize, enabled, parseWallets, create, fromRow, tagFeed };
})();
