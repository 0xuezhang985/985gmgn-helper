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
    const mode = group.mode === 'atLeast' ? 'atLeast' : 'all';
    const minBuyers = Number(group.minBuyers ?? 2);
    const validCount = Number.isInteger(minBuyers) && minBuyers >= 1 && minBuyers <= 20;
    return {
      group: { enabled: group.enabled === true && (mode === 'all' ? gw.length >= 2 : validCount && gw.length >= minBuyers), wallets: gw,
        mode, minBuyers: validCount ? minBuyers : 2,
        windowSeconds: Number.isFinite(seconds) && seconds >= 10 && seconds <= 3600 ? Math.floor(seconds) : 300 },
      amount: { enabled: amount.enabled === true && aw.length > 0 && Number.isFinite(usd) && usd > 0,
        wallets: aw, minUsd: Number.isFinite(usd) && usd > 0 ? usd : 1000 },
    };
  }
  const conditionEnabled = raw => { const c = normalize(raw); return c.group.enabled || c.amount.enabled; };
  const globalChains = ['all', 'sol', 'bsc', 'eth', 'base', 'arc', 'robinhood', 'arbitrum', 'monad', 'megaeth', 'hyperevm', 'xlayer', 'stable', 'blast', 'tron'];
  const globalDefaults = { enabled: false, singleEnabled: true, singleUsd: 1000, windowEnabled: false,
    windowSeconds: 60, windowUsd: 0, windowBuyers: 3, chain: 'all', sources: ['tracking', 'fomo', 'pump'] };
  function validateGlobal(c) {
    if (!globalChains.includes(c.chain) || !Array.isArray(c.sources) || !c.sources.length
      || c.sources.some(s => !globalDefaults.sources.includes(s))) throw new Error('请选择有效的链和至少一个来源');
    if (!Number.isFinite(c.singleUsd) || c.singleUsd <= 0 || c.singleUsd > 1e12) throw new Error('单笔金额需要大于 0 且不超过 1 万亿 USD');
    if (!Number.isInteger(c.windowSeconds) || c.windowSeconds < 1 || c.windowSeconds > 3600) throw new Error('全局窗口需要填写 1–3600 的整数秒');
    if (!Number.isFinite(c.windowUsd) || c.windowUsd < 0 || c.windowUsd > 1e12
      || !Number.isInteger(c.windowBuyers) || c.windowBuyers < 0 || c.windowBuyers > 10000) throw new Error('累计金额需为 0–1 万亿 USD，人数需为 0–10000 的整数');
    if (c.windowEnabled && !c.windowUsd && !c.windowBuyers) throw new Error('窗口条件至少设置一个金额或人数门槛');
    if (c.enabled && !c.singleEnabled && !c.windowEnabled) throw new Error('请至少启用一种全局买入条件');
    return c;
  }
  function normalizeGlobal(raw) {
    const r = raw && typeof raw === 'object' ? raw : {};
    const c = { ...globalDefaults, ...Object.fromEntries(Object.keys(globalDefaults).filter(k => Object.hasOwn(r, k)).map(k => [k, r[k]])) };
    for (const k of ['enabled', 'singleEnabled', 'windowEnabled']) c[k] = c[k] === true;
    for (const k of ['singleUsd', 'windowSeconds', 'windowUsd', 'windowBuyers']) c[k] = Number(c[k]);
    c.sources = Array.isArray(c.sources) ? [...new Set(c.sources)].sort() : [];
    try { validateGlobal(c); } catch { return { ...globalDefaults, sources: [...globalDefaults.sources].sort(), enabled: false }; }
    return c;
  }
  const groupId = value => /^[a-zA-Z0-9_-]{1,64}$/.test(String(value || '')) ? String(value) : '';
  function normalizeGroups(raw) {
    if (!Array.isArray(raw?.groups)) {
      const conditions = normalize(raw);
      return { version: 2, global: normalizeGlobal(raw?.global), groups: [{ id: 'legacy', name: '策略 1', enabled: conditionEnabled(conditions), conditions }] };
    }
    const seen = new Set();
    const groups = raw.groups.slice(0, 20).filter(g => groupId(g?.id) && !seen.has(g.id) && seen.add(g.id)).map((g, i) => ({
      id: g.id, name: text(g.name, 40) || `策略 ${i + 1}`, enabled: g.enabled === true,
      conditions: normalize(g.conditions),
    }));
    return { version: 2, global: normalizeGlobal(raw?.global), groups };
  }
  const enabled = raw => normalizeGlobal(raw?.global).enabled || normalizeGroups(raw).groups.some(g => g.enabled && conditionEnabled(g.conditions));
  function create(now = Date.now) {
    const runners = new Map();
    const global = createGlobal(now);
    return {
      configure(raw) {
        const groups = normalizeGroups(raw).groups.filter(g => g.enabled && conditionEnabled(g.conditions));
        let changed = global.configure(raw?.global);
        for (const id of runners.keys()) if (!groups.some(g => g.id === id)) { runners.delete(id); changed = true; }
        for (const group of groups) {
          let runner = runners.get(group.id);
          if (!runner) { runner = { engine: createSingle(now) }; runners.set(group.id, runner); changed = true; }
          changed = runner.engine.configure(group.conditions) || changed;
          runner.group = group; runner.key = JSON.stringify(group.conditions);
        }
        return changed;
      },
      current(alert) { return alert.record.strategyGlobal ? global.current(alert) : runners.get(alert.record.strategyGroup)?.key === alert.groupKey; },
      ingest(events) {
        const out = global.ingest(events);
        if (!runners.size) return out;
        const ordered = orderedEvents(events);
        for (const [id, runner] of runners) for (const alert of runner.engine.ingest(ordered)) {
          out.push({ ...alert, key: id + '|' + alert.key, groupKey: runner.key,
            record: { ...alert.record, strategyGroup: id, name: `${runner.group.name} · ${alert.record.name.replace(/^买入策略 · /, '')}` } });
        }
        return out;
      },
    };
  }

  // Global conditions consume the same loaded rows. FOMO accounts are not guessed from display names.
  function createGlobal(now) {
    let config = normalizeGlobal(), key = '', since = Infinity;
    const tokens = new Map(), fired = new Set();
    const money = n => '$' + n.toLocaleString('en-US', { maximumFractionDigits: 2 });
    function merged(rows) {
      const transactions = new Map(), result = [];
      for (const e of rows) {
        const id = e.tx || e.id;
        if (!transactions.has(id)) transactions.set(id, []);
        transactions.get(id).push(e);
      }
      for (const copies of transactions.values()) {
        const wallets = new Set(copies.map(e => e.wallet).filter(Boolean)), people = new Map();
        // Alias an account to a wallet only when this exact transaction has one verified wallet.
        for (const e of copies.sort((a, b) => globalDefaults.sources.indexOf(a.source) - globalDefaults.sources.indexOf(b.source))) {
          if (!e.wallet && wallets.size > 1) continue;
          const person = e.wallet || (wallets.size === 1 ? [...wallets][0] : e.actor);
          const old = people.get(person);
          if (!old) people.set(person, { ...e, actor: person });
          else { old.ts = Math.min(old.ts, e.ts); if (!(old.usd > 0) && e.usd > 0) old.usd = e.usd; }
        }
        result.push(...people.values());
      }
      return result;
    }
    return {
      configure(raw) {
        const next = normalizeGlobal(raw), nextKey = JSON.stringify(next);
        if (key === nextKey) return false;
        config = next; key = nextKey; since = now(); tokens.clear(); fired.clear(); return true;
      },
      current(alert) { return config.enabled && alert.groupKey === key; },
      ingest(events) {
        if (!config.enabled) return [];
        const time = now(), maxAge = Math.max(config.windowSeconds * 1000, 300000), touched = new Set(), out = [];
        for (const [token, rows] of tokens) {
          for (const [id, e] of rows) if (time - e.ts > maxAge) rows.delete(id);
          if (!rows.size) tokens.delete(token);
        }
        for (const raw of events || []) {
          const wallet = address(raw?.wallet), token = address(raw?.token), chain = text(raw?.chain, 24).toLowerCase();
          const source = raw?.source || 'tracking', handle = text(raw?.handle, 64).toLowerCase();
          let ts = Number(raw?.ts); if (ts < 1e11) ts *= 1000;
          if (raw?.side !== 'buy' || !token || !/^[a-z0-9_-]+$/.test(chain) || !Number.isFinite(ts) || ts < since
            || ts > time + 5000 || time - ts > maxAge || !config.sources.includes(source)
            || (config.chain !== 'all' && chain !== config.chain)) continue;
          const actor = wallet || (source === 'fomo' && handle ? 'fomo:' + handle : '');
          if (!actor) continue;
          const rawTx = text(raw.tx, 180), tx = rawTx.startsWith('0x') ? rawTx.toLowerCase() : rawTx;
          const id = [source, actor, tx || text(raw.feedKey, 180) || `time:${ts}`].join('|');
          const tokenKey = chain + '|' + token, rows = tokens.get(tokenKey) || new Map();
          const usd = Number(raw.usd), old = rows.get(id);
          const value = Number.isFinite(usd) && usd > 0 ? usd : null;
          if (old && (old.usd === value || value === null)) continue;
          rows.set(id, { ...raw, id, wallet, token, chain, actor, source, tx, ts: old?.ts ?? ts, usd: value });
          tokens.set(tokenKey, rows); touched.add(tokenKey);
        }
        for (const tokenKey of touched) {
          const all = merged([...tokens.get(tokenKey).values()]);
          const single = all.find(e => time - e.ts <= 300000 && e.usd > config.singleUsd);
          const window = all.filter(e => time - e.ts <= config.windowSeconds * 1000);
          const sum = window.reduce((s, e) => s + (e.usd || 0), 0), buyers = new Set(window.map(e => e.actor)).size;
          const reasons = [];
          if (config.singleEnabled && single) reasons.push(['single', single, `单笔买入 ${money(single.usd)} > ${money(config.singleUsd)}`]);
          if (config.windowEnabled && window.length && (!config.windowUsd || sum > config.windowUsd)
            && (!config.windowBuyers || buyers >= config.windowBuyers)) {
            reasons.push(['window', window.reduce((a, b) => a.ts > b.ts ? a : b), `${config.windowSeconds} 秒内买入 ${money(sum)} · ${buyers} 个去重钱包/账号${window.some(e => e.usd === null) ? '（仅计已知金额）' : ''}`]);
          }
          for (const [kind, e, reason] of reasons) {
            const alertKey = `global-buy-v1|${kind}|${tokenKey}`;
            if (fired.has(alertKey)) continue;
            fired.add(alertKey);
            out.push({ key: alertKey, groupKey: key, record: { strategy: true, strategyGlobal: true,
              wallet: e.wallet, href: e.href, visual: e.visual, name: `全局买入 · ${text(e.symbol) || e.token.slice(0, 10)}`,
              detail: `${e.chain.toUpperCase()} · ${reason}` } });
          }
        }
        return out;
      },
    };
  }

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
  function searchWallets(people, query, selected = []) {
    const fold = value => String(value || '').normalize('NFKC').toLowerCase();
    const q = text(query, 128), needle = fold(q), picked = new Set(selected.map(p => address(p.address)));
    const candidates = new Map();
    for (const p of Array.isArray(people) ? people : []) {
      const a = address(p?.address);
      if (a && !picked.has(a) && (!needle || fold(a).includes(needle) || fold(p.label).includes(needle))) candidates.set(a, { address: a, label: text(p.label) });
    }
    const typed = address(q);
    if (typed && !picked.has(typed) && !candidates.has(typed)) candidates.set(typed, { address: typed, label: '' });
    return [...candidates.values()];
  }
  function createSingle(now = Date.now) {
    let config = normalize(), key = '', since = Infinity;
    const seen = new Map(), groups = new Map();
    return {
      configure(raw) {
        const next = normalize(raw), nextKey = JSON.stringify(next);
        if (nextKey === key) return false;
        config = next; key = nextKey; since = now(); seen.clear(); groups.clear();
        return true;
      },
      ingest(ordered) {
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
            const required = config.group.mode === 'atLeast' ? config.group.minBuyers : gm.size;
            if (buyers.size >= required) {
              const names = config.group.wallets.filter(p => buyers.has(p.address)).map(p => p.label || `${p.address.slice(0,6)}…${p.address.slice(-4)}`);
              const threshold = config.group.mode === 'atLeast' ? `（指定 ${gm.size} 人中至少 ${required} 人，已买 ${buyers.size} 人）` : '';
              reasons.push(`${config.group.windowSeconds} 秒内共同买入${threshold}：${names.join('、')}`);
              groups.delete(tokenKey); // Start a fresh round of distinct buyers after each alert.
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
            detail: `${event.chain.toUpperCase()} · ${reasons.join('；')}`, visual: event.visual } });
        }
        return out;
      },
    };
  }
  function orderedEvents(events) {
    return (events || []).map(raw => {
          const ts = Number(raw?.ts), wallet = address(raw?.wallet), token = address(raw?.token);
          const chain = text(raw?.chain, 24).toLowerCase();
          const tx = text(raw?.tx, 180); const normalizedTx = tx.startsWith('0x') ? tx.toLowerCase() : tx;
          if (raw?.side !== 'buy' || !wallet || !token || !/^[a-z0-9_-]+$/.test(chain) || !Number.isFinite(ts) || ts <= 0) return null;
          const event = { ...raw, wallet, token, chain, ts: ts < 1e11 ? ts * 1000 : ts };
          event.id = [chain, token, wallet, normalizedTx || `time:${event.ts}`].join('|');
          return event;
        }).filter(Boolean).sort((a,b) => a.ts-b.ts || a.id.localeCompare(b.id));
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
      ts: get('Ts'), tx: get('Tx'), usd: get('Usd'), symbol: get('Symbol'), name: get('Nick'), href,
      source: own ? get('Source') || 'pump' : 'tracking', handle: own ? get('Handle') : '', feedKey: own ? get('Key') : '' };
    try {
      const url = new URL(href, `https://${site}`), parts = url.pathname.split('/').filter(Boolean);
      if (url.origin !== `https://${site}` || parts[site === 'gmgn.ai' ? 1 : 0] !== 'token'
        || parts[site === 'gmgn.ai' ? 0 : 1] !== event.chain || address(parts[2]) !== address(event.token)) return null;
    } catch { return null; }
    return event;
  }
  function tagFeed(row, event) {
    // Walletless FOMO accounts are eligible only for global rules, never selected-person rules.
    const wallet = address(event?.pumpWallet || event?.wallet);
    if (!wallet && !(event?.source === 'fomo' && event.handle)) {
      for (const key of Object.keys(row.dataset)) if (key.startsWith('gdhStrategy')) delete row.dataset[key];
      return;
    }
    for (const [key, value] of Object.entries({ Wallet: wallet, Token: event.addr, Chain: event.chain, Side: event.type,
      Ts: event.ts, Tx: event.tx, Usd: event.usd, Symbol: event.symbol, Nick: event.name || event.handle,
      Source: event.source || 'fomo', Handle: event.handle || '', Key: event.key || '' })) {
      const name = 'gdhStrategy' + key;
      const next = value == null ? '' : String(value);
      if (row.dataset[name] !== next) row.dataset[name] = next;
    }
  }
  function readFields(field) {
    const result = {};
    const mode = field('group-mode')?.value || 'all';
    const minBuyers = Number(field('group-minBuyers')?.value ?? 2);
    if (!['all', 'atLeast'].includes(mode)) throw new Error('请选择有效的共同买入模式');
    if (mode === 'atLeast' && (!Number.isInteger(minBuyers) || minBuyers < 1 || minBuyers > 20)) throw new Error('最少买入人数需要填写 1–20 的整数');
    for (const type of ['group', 'amount']) {
      const on = field(`${type}-enabled`).checked;
      let wallets;
      try { wallets = parseWallets(field(`${type}-wallets`).value); }
      catch (error) { throw new Error(`${type === 'group' ? '共同买入' : '大额买入'}：${error.message}`); }
      const required = type === 'group' ? (mode === 'atLeast' ? minBuyers : 2) : 1;
      if (on && wallets.length < required) throw new Error(type === 'group' ? (mode === 'atLeast' ? '最少买入人数不能大于指定的不同钱包人数' : '共同买入至少需要 2 个不同钱包') : '大额买入至少需要 1 个钱包');
      result[type] = { enabled: on, wallets };
    }
    result.group.windowSeconds = Number(field('group-window').value);
    result.group.mode = mode;
    result.group.minBuyers = Number.isInteger(minBuyers) && minBuyers >= 1 && minBuyers <= 20 ? minBuyers : 2;
    if (!Number.isInteger(result.group.windowSeconds) || result.group.windowSeconds < 10 || result.group.windowSeconds > 3600) throw new Error('共同买入时间窗口需要填写 10–3600 的整数秒');
    result.amount.minUsd = Number(field('amount-usd').value);
    if (!Number.isFinite(result.amount.minUsd) || result.amount.minUsd <= 0) throw new Error('单笔买入金额需要大于 0 USD');
    return result;
  }

  // Merge one group in a single worker queue, rather than overwriting other tabs' groups.
  if (typeof document === 'undefined' && globalThis.chrome?.runtime?.onMessage) {
    let writes = Promise.resolve();
    chrome.runtime.onMessage.addListener((message, sender, respond) => {
      if (message?.type !== 'buy-strategy-update') return;
      let allowed = false;
      try {
        const url = new URL(sender.url);
        allowed = sender.id === chrome.runtime.id && ((url.protocol === 'https:' && ['gmgn.ai', 'debot.ai'].includes(url.hostname))
          || (url.protocol === 'chrome-extension:' && url.hostname === chrome.runtime.id));
      } catch { /* Invalid origin. */ }
      if (!allowed) { respond({ ok: false, error: '无效的策略来源' }); return; }
      writes = writes.then(async () => {
        const config = normalizeGroups((await chrome.storage.local.get('priorityBuyStrategies')).priorityBuyStrategies);
        if (message.action === 'global-save') {
          if (JSON.stringify(config.global) !== message.expected) return { ok: false, conflict: true, config, error: '全局设置已在其他页面修改，请重新读取；草稿已保留。' };
          // Validate raw input before normalization; an invalid save must not silently disable the rule.
          const input = message.global;
          if (!input || ['enabled', 'singleEnabled', 'windowEnabled'].some(k => typeof input[k] !== 'boolean')) throw new Error('无效的全局设置');
          config.global = normalizeGlobal(validateGlobal(input));
          await chrome.storage.local.set({ priorityBuyStrategies: config });
          return { ok: true, config };
        }
        const id = groupId(message.id), index = config.groups.findIndex(g => g.id === id), old = config.groups[index];
        if (!id || !['save', 'toggle', 'remove'].includes(message.action)) throw new Error('无效的策略操作');
        if ((old ? JSON.stringify(old) : null) !== message.expected) return { ok: false, conflict: true, config, error: '本组已在其他页面修改，请重新读取。当前草稿未覆盖。' };
        if (message.action === 'remove') {
          if (index >= 0) config.groups.splice(index, 1);
        } else {
          const input = message.action === 'toggle' ? { ...old, enabled: message.enabled === true } : message.group;
          if (!input || (message.action === 'toggle' && !old)) throw new Error('策略不存在，请重新读取');
          const name = text(input.name, 40);
          if (!name) throw new Error('请填写策略名称');
          const conditions = input.conditions || {};
          const validated = readFields(key => {
            const [type, field] = key.split('-'), condition = conditions[type] || {};
            if (field === 'enabled') return { checked: condition.enabled === true };
            if (field === 'wallets') return { value: (Array.isArray(condition.wallets) ? condition.wallets : []).map(p => `${p.address} ${p.label || ''}`).join('\n') };
            if (field === 'mode') return { value: condition.mode ?? 'all' };
            if (field === 'minBuyers') return { value: condition.minBuyers ?? 2 };
            return { value: field === 'window' ? condition.windowSeconds : condition.minUsd };
          });
          if (input.enabled === true && !conditionEnabled(validated)) throw new Error('启用本组前，请至少配置并保存一种买入条件');
          const next = { id, name, enabled: input.enabled === true, conditions: normalize(validated) };
          if (index < 0) {
            if (config.groups.length >= 20) throw new Error('最多保存 20 组策略');
            config.groups.push(next);
          } else config.groups[index] = next;
        }
        await chrome.storage.local.set({ priorityBuyStrategies: config });
        return { ok: true, config };
      }).then(respond, error => respond({ ok: false, error: error?.message || '保存失败，请重试' }));
      return true;
    });
  }


  const node = (tag, className, value) => {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (value) el.textContent = value;
    if (tag === 'button') el.type = 'button';
    return el;
  };
  const editorEnglish = {
    '全局提醒': 'Global alerts', '启用全局提醒（保存后生效）': 'Enable global alerts (save to apply)',
    '无需指定人物；独立于下方人物策略，并非所有策略的公共过滤器。仅处理当前页面已收到的新买入，命中后黄色重点置顶，直到手动关闭。': 'No people selection. Independent of person strategies below, not a shared filter. Pins new buys received on this page in yellow until dismissed.',
    '单笔大额买入': 'Large single buy', '窗口聚合买入': 'Buys within a time window',
    '累计买入大于（USD，0 忽略）': 'Total buys > (USD; 0 ignores)', '买入人数至少（0 忽略）': 'Minimum buyers (0 ignores)',
    '单笔与窗口条件满足任一即可。窗口内金额与人数同时设置时，必须同时满足。': 'Single-buy OR window condition. If both window thresholds are set, BOTH must be met.',
    '链范围': 'Chain scope', '全部链': 'All chains', '数据来源': 'Sources', '用户追踪': 'Your tracking',
    '同链同币按钱包/FOMO 账号去重；仅在同笔交易明确关联时合并账号。未知 USD 不计金额。': 'Distinct wallets / FOMO accounts per chain and token. Accounts merge only with an unambiguous matching transaction. Unknown USD adds no amount.',
    '同币每种条件仅提醒一次，跨刷新记忆；关闭卡片或重新保存不会重复弹出。不开声音，不自动交易，不新增数据请求。': 'Each condition alerts once per chain/token, remembered across reloads. Dismiss or save will not re-alert. No sound, trades or extra data requests.',
    '保存全局设置': 'Save global settings', '重新读取全局设置': 'Reload global settings',
    '全局设置未保存。': 'Global settings have unsaved changes.', '全局设置已保存，不影响人物策略。': 'Global settings saved. Person strategies unchanged.',
    '全局设置已在其他页面修改，请重新读取；草稿已保留。': 'Global settings changed elsewhere. Reload saved settings; your draft is preserved.',
    '已读取最新全局设置。': 'Loaded the latest global settings.', '无效的全局设置': 'Invalid global settings.',
    '请选择有效的链和至少一个来源': 'Choose a valid chain and at least one source.',
    '单笔金额需要大于 0 且不超过 1 万亿 USD': 'Single-buy USD must be greater than 0 and at most 1 trillion.',
    '全局窗口需要填写 1–3600 的整数秒': 'Global window must be an integer from 1 to 3600 seconds.',
    '累计金额需为 0–1 万亿 USD，人数需为 0–10000 的整数': 'Total USD must be 0–1 trillion; buyers must be an integer from 0 to 10000.',
    '窗口条件至少设置一个金额或人数门槛': 'Set at least one window amount or buyer threshold.',
    '请至少启用一种全局买入条件': 'Enable at least one global buy condition.',
    '最多 20 组，各组独立保存和开关。组内满足任一条件即重点置顶；只读取当前页面新买入，不自动交易。': 'Up to 20 independent strategies. Any enabled condition pins an alert. Uses new buys already received on this page; never trades.',
    '+ 新增策略': '+ Add strategy', '策略名称': 'Strategy name',
    '指定人物共同买入': 'Selected people buying together', '指定人物大额买入': 'Large buy by a selected person',
    '同链同币、窗口内按不同钱包计数；重复买入不凑人数，触发后重新累计。': 'Count distinct selected wallets buying the same token on the same chain within the window. Repeated buys count once. Each alert starts a new round.',
    '任一指定人物的单笔买入严格大于金额门槛。': 'A single buy by any selected person must exceed the USD threshold.',
    '时间窗口（秒）': 'Time window (seconds)', '单笔金额门槛（USD）': 'Single-buy threshold (USD)',
    '共同买入模式 · NEW': 'Buyer mode · NEW', '共同买入模式': 'Buyer mode',
    '全部指定人物': 'All selected people', '至少 X 个指定人物': 'At least X selected people', '最少买入人数': 'Minimum distinct buyers',
    '输入地址或备注搜索；也可粘贴新钱包的完整地址': 'Search address or note, or paste a new full address',
    '每行：完整钱包地址 备注（可选）': 'One per line: full wallet address, optional note',
    '保存本组': 'Save strategy', '重新读取': 'Reload saved', '删除本组': 'Delete strategy',
    '选择人物添加…': 'Select a person to add…', '没有匹配的未添加人物': 'No matching unselected people', '未命名': 'Unnamed',
    '还没有策略，点击上方新增。': 'No strategies yet. Add one above.', '未命名策略': 'Unnamed strategy',
    ' · 未保存': ' · Unsaved', '启用': 'Enable', '开启': 'On', '关闭': 'Off',
    '本组已在其他页面修改，请重新读取。草稿已保留。': 'Changed in another page. Reload saved settings; your draft is preserved.',
    '本组已在其他页面修改，请重新读取。当前草稿未覆盖。': 'Changed in another page. Reload saved settings; your draft was not overwritten.',
    '本组尚未保存': 'Unsaved strategy', '开关即时生效；修改条件后请保存本组。': 'The switch applies immediately. Save after editing conditions.',
    '请先保存或重新读取本组，再切换开关。': 'Save or reload this strategy before toggling it.',
    '本组尚未保存，切换策略不会丢失草稿。': 'Unsaved changes. Switching strategies keeps your draft.',
    '新增组默认关闭；请配置条件、保存本组，再打开组开关。': 'New strategies start disabled. Configure and save, then enable the strategy.',
    '扩展连接失败，请重试': 'Extension connection failed. Please retry.', '保存失败：': 'Save failed: ',
    '；未保存的输入已保留。': '; your unsaved input is preserved.',
    '本组开关已保存，不影响其他组。': 'Switch saved. Other strategies are unchanged.',
    '已删除本组。': 'Strategy deleted.', '本组已保存，与插件设置同步。': 'Strategy saved and synced with extension settings.',
    '请填写策略名称': 'Enter a strategy name.', '已读取最新保存的本组策略。': 'Loaded the latest saved strategy.',
    '读取失败，当前草稿已保留。': 'Could not load saved settings. Your draft is preserved.', '已移除未保存的策略。': 'Unsaved strategy removed.',
    '请选择有效的共同买入模式': 'Select a valid buyer mode.', '最少买入人数需要填写 1–20 的整数': 'Minimum buyers must be an integer from 1 to 20.',
    '最少买入人数不能大于指定的不同钱包人数': 'Minimum buyers cannot exceed the number of distinct selected wallets.',
    '共同买入至少需要 2 个不同钱包': 'All-people mode requires at least 2 distinct wallets.', '大额买入至少需要 1 个钱包': 'Large-buy mode requires at least 1 wallet.',
    '共同买入时间窗口需要填写 10–3600 的整数秒': 'Time window must be an integer from 10 to 3600 seconds.',
    '单笔买入金额需要大于 0 USD': 'Single-buy threshold must be greater than 0 USD.', '每种策略最多指定 20 人': 'Each condition supports up to 20 people.',
    '无效的策略来源': 'Invalid strategy source.', '无效的策略操作': 'Invalid strategy operation.',
    '策略不存在，请重新读取': 'Strategy not found. Reload saved settings.',
    '启用本组前，请至少配置并保存一种买入条件': 'Configure and save at least one buy condition before enabling this strategy.',
    '最多保存 20 组策略': 'Up to 20 strategies can be saved.', '保存失败，请重试': 'Save failed. Please retry.',
  };
  function createEditor(editor, raw, wallets) {
    let language = 'en', languageChosen = false, lastMessage = '';
    const bindings = [];
    const tr = value => {
      if (language === 'zh') return value;
      if (editorEnglish[value]) return editorEnglish[value];
      if (/^第 \d+ 行需要完整的钱包地址，不能仅填人名$/.test(value)) return `Line ${value.match(/\d+/)[0]} requires a full wallet address, not a name.`;
      const prefixed = value.match(/^(共同买入|大额买入)：(.*)$/);
      return prefixed ? `${prefixed[1] === '共同买入' ? 'Group buys' : 'Large buys'}: ${tr(prefixed[2])}` : value;
    };
    const bind = (el, value, attribute) => {
      const target = attribute ? el : document.createTextNode('');
      if (!attribute) el.append(target);
      const paint = () => attribute ? el.setAttribute(attribute, tr(value)) : (target.textContent = tr(value));
      bindings.push(paint); paint(); return el;
    };
    const ui = (tag, className, value) => { const el = node(tag, className); return value ? bind(el, value) : el; };
    editor.classList.add('gdh-strategy-editor');
    const intro = ui('p', 'gdh-strategy-hint', '最多 20 组，各组独立保存和开关。组内满足任一条件即重点置顶；只读取当前页面新买入，不自动交易。');
    const toolbar = ui('div', 'gdh-strategy-actions');
    const languageSelect = node('select', 'gdh-strategy-language');
    languageSelect.setAttribute('aria-label', 'Language / 语言'); languageSelect.append(new Option('English', 'en'), new Option('中文', 'zh'));
    languageSelect.addEventListener('change', () => {
      languageChosen = true; applyLanguage(languageSelect.value);
      const chosen = language;
      Promise.resolve().then(() => chrome.storage.local.set({ priorityStrategyLanguageV1: chosen })).catch(() => {});
    });
    const add = ui('button', '', '+ 新增策略'); toolbar.append(add, languageSelect);
    const globalPanel = ui('details', 'gdh-strategy-global');
    const globalSummary = ui('summary', '', '全局提醒');
    globalSummary.append(node('em', 'gdh-manager-new', 'NEW'));
    const globalState = node('span', 'gdh-global-state'); globalSummary.append(globalState);
    const globalForm = node('div', 'gdh-global-form'), gf = {};
    const globalCheck = (key, title, parent) => {
      const label = ui('label', 'gdh-strategy-toggle'), input = node('input'); input.type = 'checkbox';
      input.dataset.global = key; gf[key] = input; label.append(input); bind(label, title); parent.append(label);
    };
    const globalNumber = (key, title, min, max, step, parent) => {
      const label = ui('label', 'gdh-strategy-number', title), input = node('input');
      Object.assign(input, { type: 'number', min: String(min), max: String(max), step });
      input.dataset.global = key; bind(input, title, 'aria-label'); gf[key] = input; label.append(input); parent.append(label);
    };
    globalForm.append(ui('p', 'gdh-strategy-hint', '无需指定人物；独立于下方人物策略，并非所有策略的公共过滤器。仅处理当前页面已收到的新买入，命中后黄色重点置顶，直到手动关闭。'));
    globalCheck('enabled', '启用全局提醒（保存后生效）', globalForm);
    const globalSingle = node('fieldset'), globalWindow = node('fieldset'), globalScope = node('fieldset');
    globalCheck('singleEnabled', '单笔大额买入', globalSingle);
    globalNumber('singleUsd', '单笔金额门槛（USD）', 0.01, 1e12, 'any', globalSingle);
    globalCheck('windowEnabled', '窗口聚合买入', globalWindow);
    globalNumber('windowSeconds', '时间窗口（秒）', 1, 3600, '1', globalWindow);
    globalNumber('windowUsd', '累计买入大于（USD，0 忽略）', 0, 1e12, 'any', globalWindow);
    globalNumber('windowBuyers', '买入人数至少（0 忽略）', 0, 10000, '1', globalWindow);
    const chainLabel = ui('label', 'gdh-strategy-number', '链范围'), chainSelect = node('select');
    for (const chain of globalChains) {
      const option = new Option('', chain); bind(option, chain === 'all' ? '全部链' : chain.toUpperCase()); chainSelect.append(option);
    }
    gf.chain = chainSelect; chainSelect.dataset.global = 'chain'; bind(chainSelect, '链范围', 'aria-label'); chainLabel.append(chainSelect);
    const sources = node('div', 'gdh-global-sources'); sources.append(ui('span', '', '数据来源'));
    for (const source of globalDefaults.sources) globalCheck('source-' + source, source === 'tracking' ? '用户追踪' : source.toUpperCase(), sources);
    globalScope.append(chainLabel, sources);
    const globalActions = node('div', 'gdh-strategy-actions');
    const globalSave = ui('button', 'gdh-global-save', '保存全局设置'), globalReload = ui('button', '', '重新读取全局设置');
    globalActions.append(globalSave, globalReload);
    const globalStatus = node('div', 'gdh-strategy-global-status'); globalStatus.setAttribute('role', 'status');
    globalForm.append(globalSingle, globalWindow, ui('p', 'gdh-strategy-hint', '单笔与窗口条件满足任一即可。窗口内金额与人数同时设置时，必须同时满足。'), globalScope,
      ui('p', 'gdh-strategy-hint', '同链同币按钱包/FOMO 账号去重；仅在同笔交易明确关联时合并账号。未知 USD 不计金额。'),
      ui('p', 'gdh-strategy-hint', '同币每种条件仅提醒一次，跨刷新记忆；关闭卡片或重新保存不会重复弹出。不开声音，不自动交易，不新增数据请求。'), globalActions, globalStatus);
    globalPanel.append(globalSummary, globalForm);
    let globalBase = normalizeGlobal(raw?.global), globalDirty = false, globalConflict = false, globalBusy = false, globalMessage = '';
    const showGlobal = (message, error = false) => {
      globalMessage = message; globalStatus.textContent = tr(message); globalStatus.classList.toggle('is-error', error);
    };
    const globalBadge = () => { globalState.textContent = tr(globalBase.enabled ? '开启' : '关闭') + (globalDirty ? tr(' · 未保存') : ''); };
    const fillGlobal = () => {
      for (const [key, el] of Object.entries(gf)) {
        if (key.startsWith('source-')) el.checked = globalBase.sources.includes(key.slice(7));
        else if (el.type === 'checkbox') el.checked = globalBase[key];
        else el.value = globalBase[key];
      }
      globalSave.disabled = globalConflict; globalBadge();
    };
    const syncGlobal = config => {
      if (globalBusy) return;
      const next = normalizeGlobal(config?.global);
      if (JSON.stringify(next) === JSON.stringify(globalBase)) return;
      if (globalDirty) { globalConflict = true; globalSave.disabled = true; showGlobal('全局设置已在其他页面修改，请重新读取；草稿已保留。', true); }
      else { globalBase = next; fillGlobal(); }
    };
    globalForm.addEventListener('input', () => { globalDirty = true; globalBadge(); if (!globalConflict) showGlobal('全局设置未保存。'); });
    globalSave.addEventListener('click', async () => {
      if (globalBusy || globalConflict) return;
      try {
        const input = { sources: globalDefaults.sources.filter(s => gf['source-' + s].checked) };
        for (const [key, el] of Object.entries(gf)) if (!key.startsWith('source-')) input[key] = el.type === 'checkbox' ? el.checked : el.type === 'number' ? Number(el.value) : el.value;
        validateGlobal(input);
        globalBusy = true; globalForm.inert = true;
        const result = await chrome.runtime.sendMessage({ type: 'buy-strategy-update', action: 'global-save', expected: JSON.stringify(globalBase), global: input });
        if (!result?.ok) { globalConflict = result?.conflict === true; globalSave.disabled = globalConflict; throw new Error(result?.error || '扩展连接失败，请重试'); }
        globalBase = normalizeGlobal(result.config.global); globalDirty = false; globalConflict = false; fillGlobal();
        sync(result.config, people); showGlobal('全局设置已保存，不影响人物策略。');
      } catch (error) { showGlobal(error.message, true); }
      finally {
        globalBusy = false; globalForm.inert = false;
        try { const saved = await chrome.storage.local.get('priorityBuyStrategies'); sync(saved.priorityBuyStrategies, people); } catch { /* Preserve the confirmed result and draft. */ }
      }
    });
    globalReload.addEventListener('click', async () => {
      if (globalBusy) return;
      globalBusy = true; globalForm.inert = true;
      try {
        const saved = await chrome.storage.local.get('priorityBuyStrategies');
        globalBase = normalizeGlobal(saved.priorityBuyStrategies?.global); globalDirty = false; globalConflict = false; fillGlobal();
        showGlobal('已读取最新全局设置。');
      } catch { showGlobal('读取失败，当前草稿已保留。', true); }
      finally { globalBusy = false; globalForm.inert = false; }
    });
    fillGlobal();
    const list = ui('div', 'gdh-strategy-groups');
    const form = ui('div', 'gdh-strategy-form');
    const nameLabel = ui('label', 'gdh-strategy-number', '策略名称');
    const nameInput = ui('input'); nameInput.type = 'text'; nameInput.maxLength = 40; nameInput.dataset.buy = 'name'; bind(nameInput, '策略名称', 'aria-label'); nameLabel.append(nameInput); form.append(nameLabel);
    const fields = {};
      for (const [type, title, hint, valueKey, valueTitle, min, max, step] of [
        ['group', '指定人物共同买入', '同链同币、窗口内按不同钱包计数；重复买入不凑人数，触发后重新累计。', 'window', '时间窗口（秒）', '10', '3600', '1'],
        ['amount', '指定人物大额买入', '任一指定人物的单笔买入严格大于金额门槛。', 'usd', '单笔金额门槛（USD）', '0', '', 'any'],
      ]) {
        const box = ui('fieldset');
        const toggle = ui('label', 'gdh-strategy-toggle');
        const check = ui('input'); check.type = 'checkbox'; fields[`${type}-enabled`] = check;
        toggle.append(check); bind(toggle, title);
        const numberLabel = ui('label', 'gdh-strategy-number', valueTitle);
        const number = ui('input'); number.type = 'number'; number.min = min; number.step = step;
        if (max) number.max = max;
        bind(number, valueTitle, 'aria-label'); fields[`${type}-${valueKey}`] = number; numberLabel.append(number);
        const picker = ui('select'); picker.setAttribute('aria-label', `${type} person picker`);
        const search = ui('input'); search.type = 'search'; search.maxLength = 128;
        bind(search, '输入地址或备注搜索；也可粘贴新钱包的完整地址', 'placeholder'); search.setAttribute('aria-label', `${type}: address / note search`);
        const input = ui('textarea'); input.rows = 3; input.spellcheck = false;
        bind(input, '每行：完整钱包地址 备注（可选）', 'placeholder'); input.setAttribute('aria-label', `${type} wallet list`);
        fields[`${type}-wallets`] = input; fields[`${type}-picker`] = picker; fields[`${type}-search`] = search;
        search.addEventListener('input', () => renderPicker(type));
        picker.addEventListener('change', () => {
          if (!picker.value) return;
          try {
            input.value = parseWallets(`${input.value}\n${picker.value}`).map(p => `${p.address} ${p.label}`.trim()).join('\n');
            input.dispatchEvent(new Event('input', { bubbles: true }));
          } catch (error) { show(error.message, true); }
          picker.value = '';
          renderPicker(type);
        });
        box.append(toggle, ui('p', 'gdh-strategy-hint', hint));
        if (type === 'group') {
          const modeLabel = ui('label', 'gdh-strategy-number', '共同买入模式 · NEW');
          const mode = ui('select'); bind(mode, '共同买入模式', 'aria-label');
          for (const [value, title] of [['all', '全部指定人物'], ['atLeast', '至少 X 个指定人物']]) { const option = new Option('', value); bind(option, title); mode.append(option); }
          fields['group-mode'] = mode; modeLabel.append(mode);
          const countLabel = ui('label', 'gdh-strategy-number gdh-strategy-min-buyers', '最少买入人数');
          const count = ui('input'); count.type = 'number'; count.min = '1'; count.max = '20'; count.step = '1';
          bind(count, '最少买入人数', 'aria-label'); fields['group-minBuyers'] = count; countLabel.append(count);
          mode.addEventListener('change', () => { countLabel.hidden = mode.value !== 'atLeast'; });
          box.append(modeLabel, countLabel);
        }
        box.append(numberLabel, search, picker, input); form.append(box);
      }

    for (const [key, el] of Object.entries(fields)) el.dataset.buy = key;
    const actions = ui('div', 'gdh-strategy-actions');
    const save = ui('button', 'gdh-strategy-save', '保存本组');
    const reset = ui('button', '', '重新读取');
    const remove = ui('button', '', '删除本组');
    const status = ui('div', 'gdh-strategy-status'); status.setAttribute('role', 'status');
    const show = (message, error = false) => { lastMessage = message; status.textContent = tr(message); status.classList.toggle('is-error', error); };
    actions.append(save, reset, remove); form.append(actions);
    editor.append(intro, toolbar, globalPanel, list, form, status);
    let latest = normalizeGroups(raw), selected = latest.groups[0]?.id || '', busy = false, people = wallets, pickerKey = '', listKey = '';
    const drafts = new Map();
    const persistedField = key => !/-(picker|search)$/.test(key);
    const valuesOf = group => ({ name: group.name, ...Object.fromEntries(Object.keys(fields).filter(persistedField).map(key => {
      const [type, field] = key.split('-'), c = group.conditions[type];
      return [key, field === 'enabled' ? c.enabled : field === 'wallets' ? c.wallets.map(p => `${p.address} ${p.label}`.trim()).join('\n') : String(field === 'window' ? c.windowSeconds : field === 'mode' ? c.mode : field === 'minBuyers' ? c.minBuyers : c.minUsd)];
    })) });
    const draft = id => {
      if (!drafts.has(id)) {
        const base = latest.groups.find(g => g.id === id);
        if (base) drafts.set(id, { base, values: valuesOf(base), dirty: false, conflict: false });
      }
      return drafts.get(id);
    };
    const ids = () => [...new Set([...latest.groups.map(g => g.id), ...[...drafts].filter(([,d]) => !d.base || d.dirty).map(([id]) => id)])];
    const fill = () => {
      const d = draft(selected); form.hidden = !d;
      if (!d) return;
      nameInput.value = d.values.name;
      for (const [key, value] of Object.entries(d.values)) {
        if (!fields[key]) continue;
        if (key.endsWith('-enabled')) fields[key].checked = value; else fields[key].value = value;
      }
      save.disabled = d.conflict;
      editor.querySelector('.gdh-strategy-min-buyers').hidden = fields['group-mode'].value !== 'atLeast';
      for (const type of ['group', 'amount']) { fields[`${type}-search`].value = ''; renderPicker(type); }
    };
    function renderPicker(type) {
      const picker = fields[`${type}-picker`], query = fields[`${type}-search`].value;
      let selected = [];
      try { selected = parseWallets(fields[`${type}-wallets`].value); } catch { /* Keep invalid draft editable. */ }
      const matches = searchWallets(people, query, selected);
      picker.replaceChildren(new Option(tr(matches.length ? '选择人物添加…' : '没有匹配的未添加人物'), ''));
      for (const p of matches) {
        const option = new Option(`${p.label || tr('未命名')} · ${p.address.slice(0, 6)}…${p.address.slice(-4)}`, `${p.address} ${p.label}`.trim());
        option.title = p.address; picker.append(option);
      }
    }
    function renderList() {
      const rows = ids(), key = JSON.stringify(rows.map(id => { const d = draft(id); return [id,d.values.name,d.base?.enabled,d.dirty,d.conflict,selected===id]; }));
      if (key === listKey) return;
      listKey = key; list.replaceChildren(); add.disabled = rows.length >= 20;
      if (!rows.length) list.append(node('p', 'gdh-strategy-hint', tr('还没有策略，点击上方新增。')));
      for (const id of rows) {
        const d = draft(id), row = ui('div', 'gdh-strategy-group'); row.dataset.groupId = id; row.classList.toggle('is-selected', id === selected);
        const select = node('button', '', `${d.values.name || tr('未命名策略')}${d.dirty ? tr(' · 未保存') : ''}`);
        select.title = d.values.name; select.setAttribute('aria-pressed', String(id === selected));
        select.addEventListener('click', () => { selected = id; fill(); renderList(); show(d.conflict ? '本组已在其他页面修改，请重新读取。草稿已保留。' : d.dirty ? '本组尚未保存' : '开关即时生效；修改条件后请保存本组。', d.conflict); });
        const label = ui('label'); const toggle = ui('input'); toggle.type = 'checkbox'; toggle.checked = d.base?.enabled === true; toggle.disabled = !d.base;
        toggle.setAttribute('aria-label', `${tr('启用')} ${d.values.name}`);
        toggle.addEventListener('change', () => {
          const on = toggle.checked; toggle.checked = d.base?.enabled === true;
          if (d.dirty || d.conflict) { show('请先保存或重新读取本组，再切换开关。', true); return; }
          write(id, 'toggle', { enabled: on });
        });
        label.append(toggle, document.createTextNode(tr(d.base?.enabled ? '开启' : '关闭'))); row.append(select, label); list.append(row);
      }
    }
    const sync = (config, walletList) => {
      syncGlobal(config);
      people = walletList;
      if (!busy) {
        const next = normalizeGroups(config), oldDraft = draft(selected);
        for (const [id, d] of drafts) {
          const actual = next.groups.find(g => g.id === id) || null;
          if (JSON.stringify(d.base) === JSON.stringify(actual)) continue;
          if (d.dirty) { d.conflict = true; }
          else drafts.delete(id);
        }
        latest = next;
        if (!ids().includes(selected)) selected = ids()[0] || '';
        const current = draft(selected);
        if (current !== oldDraft) fill();
        if (current?.conflict) { save.disabled = true; show('本组已在其他页面修改，请重新读取。当前草稿未覆盖。', true); }
        renderList();
      }
      const entries = Array.isArray(walletList) ? walletList : [], key = JSON.stringify(entries);
      if (key === pickerKey) return;
      pickerKey = key;
      for (const type of ['group', 'amount']) renderPicker(type);
    };
    async function write(id, action, extra) {
      if (busy) return;
      const d = draft(id); if (!d) return;
      busy = true; editor.inert = true;
      let result, error = '';
      try {
        result = await chrome.runtime.sendMessage({ type: 'buy-strategy-update', action, id, expected: d.base ? JSON.stringify(d.base) : null, ...extra });
        if (!result?.ok) throw new Error(result?.error || '扩展连接失败，请重试');
        drafts.delete(id);
      } catch (e) { error = e.message; if (result?.conflict) d.conflict = true; }
      finally {
        busy = false; editor.inert = false;
        if (result?.config) sync(result.config, people);
        fill(); renderList();
        show(error ? `${tr('保存失败：')}${tr(error)}${tr('；未保存的输入已保留。')}` : action === 'toggle' ? '本组开关已保存，不影响其他组。' : action === 'remove' ? '已删除本组。' : '本组已保存，与插件设置同步。', !!error);
        // Include any other group saved immediately after our worker response.
        try { const value = await chrome.storage.local.get('priorityBuyStrategies'); sync(value.priorityBuyStrategies, people); } catch { /* Keep confirmed result and drafts. */ }
      }
    }
    form.addEventListener('input', event => {
      if (event.target.dataset.buy?.endsWith('-search')) return;
      const d = draft(selected); if (!d) return;
      d.values = { name: nameInput.value, ...Object.fromEntries(Object.entries(fields).filter(([k]) => persistedField(k)).map(([key, el]) => [key,key.endsWith('-enabled') ? el.checked : el.value])) };
      if (event.target.dataset.buy?.endsWith('-wallets')) renderPicker(event.target.dataset.buy.split('-')[0]);
      d.dirty = true; renderList(); if (!d.conflict) show('本组尚未保存，切换策略不会丢失草稿。');
    });
    add.addEventListener('click', () => {
      if (ids().length >= 20) return;
      selected = crypto.randomUUID();
      drafts.set(selected, { base: null, values: valuesOf({ name: `${language === 'zh' ? '策略' : 'Strategy'} ${ids().length + 1}`, conditions: normalize() }), dirty: true, conflict: false });
      fill(); renderList(); show('新增组默认关闭；请配置条件、保存本组，再打开组开关。');
    });
    save.addEventListener('click', () => {
      const d = draft(selected); if (!d || d.conflict) return;
      try {
        const name = nameInput.value.trim(); if (!name) throw new Error('请填写策略名称');
        const conditions = readFields(key => fields[key]);
        write(selected, 'save', { group: { name, enabled: d.base?.enabled === true, conditions } });
      } catch (e) { show(e.message, true); }
    });
    reset.addEventListener('click', async () => {
      const id = selected;
      try {
        const stored = await chrome.storage.local.get('priorityBuyStrategies');
        if (selected !== id) return;
        drafts.delete(id); sync(stored.priorityBuyStrategies, people); fill(); show('已读取最新保存的本组策略。');
      } catch { show('读取失败，当前草稿已保留。', true); }
    });
    remove.addEventListener('click', () => {
      const d = draft(selected); if (!d || !confirm(language === 'zh' ? `删除「${d.values.name || '未命名策略'}」？此操作仅删除本组。` : `Delete “${d.values.name || 'Unnamed strategy'}”? Only this strategy will be removed.`)) return;
      if (!d.base) { drafts.delete(selected); selected = ids()[0] || ''; fill(); renderList(); show('已移除未保存的策略。'); }
      else write(selected, 'remove');
    });
    function applyLanguage(next) {
      language = next === 'zh' ? 'zh' : 'en'; languageSelect.value = language; editor.lang = language === 'zh' ? 'zh-CN' : 'en';
      bindings.forEach(paint => paint()); listKey = ''; renderList();
      globalBadge(); if (globalMessage) globalStatus.textContent = tr(globalMessage);
      for (const type of ['group', 'amount']) renderPicker(type);
      if (lastMessage) status.textContent = tr(lastMessage);
    }
    fill(); sync(raw, wallets); applyLanguage('en');
    Promise.resolve().then(() => chrome.storage.local.get({ priorityStrategyLanguageV1: 'en' })).then(saved => {
      if (!languageChosen) applyLanguage(saved.priorityStrategyLanguageV1);
    }).catch(() => {});
    return { sync };
  }
  const managers = new WeakMap();
  function mountManager(modal, raw, wallets) {
    let state = managers.get(modal);
    if (!state) {
      const body = node('div', 'gdh-manager-wallets');
      while (modal.children.length > 1) body.append(modal.children[1]);
      const tabs = node('div', 'gdh-manager-tabs'); tabs.setAttribute('role', 'tablist');
      const people = node('button', '', '特别关注'), strategy = node('button', '', '策略追踪');
      strategy.append(node('em', 'gdh-manager-new', 'NEW'));
      const editor = node('div'), api = createEditor(editor, raw, wallets);
      tabs.append(people, strategy); modal.append(tabs, body, editor);
      const activate = button => {
        for (const [tab, content] of [[people, body], [strategy, editor]]) {
          const active = tab === button; tab.setAttribute('aria-selected', String(active)); content.hidden = !active;
        }
      };
      for (const [button, panel] of [[people, body], [strategy, editor]]) {
        button.setAttribute('role', 'tab'); panel.setAttribute('role', 'tabpanel'); button.addEventListener('click', () => activate(button));
      }
      activate(people);
      for (const event of ['click', 'pointerdown', 'keydown']) modal.addEventListener(event, e => e.stopPropagation());
      state = { body, sync: api.sync }; managers.set(modal, state);
    }
    state.sync(raw, wallets); return state.body;
  }
  globalThis.GdhBuyStrategies = { normalize, normalizeGlobal, validateGlobal, normalizeGroups, enabled, parseWallets, searchWallets, create, fromRow, tagFeed, readFields, createEditor, mountManager };
})();
