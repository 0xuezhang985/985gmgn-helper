/* Persistent, local-only priority alerts. No network requests or native row mutation. */
(() => {
  'use strict';
  const PREFIX = 'gdhPriorityPushV1:';
  const sites = new Set(['gmgn.ai', 'debot.ai']);
  const clean = (value, max) => String(value || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);
  const siteOf = (url) => {
    try { const u = new URL(url); return u.protocol === 'https:' && sites.has(u.hostname) ? u.hostname : ''; }
    catch { return ''; }
  };
  const imageUrl = (value, site) => {
    if (!value) return '';
    try { const u = new URL(String(value).slice(0, 1000), `https://${site}`); return u.protocol === 'https:' && !u.username && !u.password ? u.href : ''; }
    catch { return ''; }
  };
  const visualData = (value, site) => {
    if (!value || typeof value !== 'object') return null;
    const v = {};
    for (const key of ['name', 'symbol', 'action', 'amount', 'mc']) v[key] = clean(value[key], 64);
    v.chain = /^[a-z][a-z0-9]{1,23}$/.test(value.chain) ? value.chain : '';
    v.side = ['buy', 'sell'].includes(value.side) ? value.side : '';
    v.source = ['fomo', 'pump'].includes(value.source) ? value.source : '';
    for (const key of ['avatar', 'tokenImage', 'amountImage']) v[key] = imageUrl(value[key], site);
    v.color = /^(?:#[a-f0-9]{3,8}|rgba?\([\d.,%\s]+\))$/i.test(value.color) ? value.color : '';
    v.ts = Number.isFinite(Number(value.ts)) && Number(value.ts) > 0 && Number(value.ts) <= 8.64e15 ? Number(value.ts) : 0;
    return v;
  };

  if (typeof document === 'undefined') {
    // A single worker queue makes add/dismiss atomic across tabs. A dismissed event
    // keeps a small tombstone, so later scans cannot resurrect it.
    let queue = Promise.resolve();
    chrome.runtime.onMessage.addListener((message, sender, respond) => {
      if (!['priority-push-list', 'priority-push-add', 'priority-push-dismiss', 'priority-push-clear'].includes(message?.type)) return;
      const site = sender.id === chrome.runtime.id && siteOf(sender.url);
      if (!site) { respond({ ok: false, error: '无效的提醒来源' }); return; }
      queue = queue.then(async () => {
        const prefix = `${PREFIX}${site}:`;
        if (message.type === 'priority-push-clear') {
          // Same serialized queue as add/dismiss. Keep tombstones, never delete settings
          // or clear a new event queued after this operation.
          const stored = await chrome.storage.local.get(null);
          const values = {}, ids = [];
          for (const [key, value] of Object.entries(stored)) {
            if (!key.startsWith(prefix) || !value || value.dismissed) continue;
            const id = key.slice(prefix.length);
            values[key] = { id, dismissed: true }; ids.push(id);
          }
          if (ids.length) await chrome.storage.local.set(values);
          return { ok: true, ids };
        }
        if (message.type === 'priority-push-list') {
          const stored = await chrome.storage.local.get(null);
          return { ok: true, records: Object.entries(stored)
            .filter(([key, value]) => key.startsWith(prefix) && value && !value.dismissed)
            .map(([, value]) => value) };
        }
        const id = clean(message.id, 500);
        if (!id || id !== message.id) throw new Error('无效的推送标识');
        const key = prefix + id;
        const old = (await chrome.storage.local.get(key))[key];
        if (message.type === 'priority-push-dismiss') {
          await chrome.storage.local.set({ [key]: { id, dismissed: true } });
          return { ok: true };
        }
        if (old) return { ok: true, record: old };
        const data = message.record || {};
        const href = new URL(String(data.href || ''), `https://${site}`);
        if (href.origin !== `https://${site}` || !href.pathname.includes('/token/')) throw new Error('无效的代币链接');
        const wallet = clean(data.wallet, 64);
        if (!/^(?:0x[a-fA-F0-9]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})$/.test(wallet)) throw new Error('无效的钱包地址');
        const record = { id, wallet, strategy: data.strategy === true, href: href.pathname + href.search, name: clean(data.name, 64),
          detail: clean(data.detail, 500), at: Date.now() };
        const visual = visualData(data.visual, site);
        if (visual) record.visual = visual;
        if (record.strategy && /^[a-zA-Z0-9_-]{1,64}$/.test(String(data.strategyGroup || ''))) record.strategyGroup = data.strategyGroup;
        await chrome.storage.local.set({ [key]: record });
        return { ok: true, record };
      }).then(respond, (error) => respond({ ok: false, error: String(error?.message || error) }));
      return true;
    });
    return;
  }

  if (!sites.has(location.hostname) || globalThis.GdhPriorityPush) return;
  const usd = value => {
    const n = Number(value);
    if (!(n > 0) || !Number.isFinite(n)) return '';
    for (const [unit, suffix] of [[1e9, 'B'], [1e6, 'M'], [1e3, 'K']]) if (n >= unit) return `$${+(n / unit).toFixed(2)}${suffix}`;
    return `$${+n.toFixed(2)}`;
  };
  function describe(row) {
    const d = row.dataset, own = d.gdhStrategyWallet !== undefined;
    const prefix = own ? 'gdhStrategy' : location.hostname === 'debot.ai' ? 'gdhDebotTrack' : 'gdhTrack';
    const get = key => d[prefix + key];
    const who = row.querySelector('[data-testid="follow-tracking-row-maker"], .gdh-fomofeed__twho, .gdh-fomofeed__r1, .gdh-debot-feed__who, .gdh-debot-sidefeed__who')
      || row.querySelector('a[href*="/address/"]')?.parentElement;
    const token = row.querySelector('[data-testid="follow-tracking-row-symbol"], .gdh-fomofeed__tsym, .gdh-fomofeed__r2, .gdh-debot-feed__token, .gdh-debot-sidefeed__token')
      || row.querySelector('a[href*="/token/"]');
    const amount = row.querySelector('[data-testid="follow-tracking-row-amount"], .gdh-fomofeed__tamt, .gdh-fomofeed__usd, .gdh-debot-feed__amount, .gdh-debot-sidefeed__amount');
    const name = who?.querySelector('a[href*="/address/"], .gdh-fomofeed__name, .gdh-debot-feed__name, .gdh-debot-sidefeed__name');
    const stripe = row.querySelector('.gdh-fomofeed__stripe, .gdh-debot-feed__stripe, .gdh-debot-sidefeed__stripe, :scope > span[style*="background"]');
    let ts = Number(get('Ts')) || 0; if (ts && ts < 1e11) ts *= 1000;
    return visualData({ name: get('Nick') || name?.textContent, symbol: get('Symbol'), chain: get('Chain'), side: get('Side'), ts,
      action: row.querySelector('[data-testid="follow-tracking-row-side"], .gdh-fomofeed__tag, .gdh-debot-feed__action')?.textContent,
      amount: amount?.textContent || usd(get('Usd')), amountImage: amount?.querySelector('img')?.getAttribute('src'),
      mc: usd(get('Mc')) || row.querySelector('.gdh-fomofeed__mc, .gdh-fomofeed__tmc, .gdh-debot-feed__mc, .gdh-debot-sidefeed__mc')?.textContent?.replace(/^MC:\s*/i, ''),
      avatar: who?.querySelector('img')?.getAttribute('src'), tokenImage: token?.querySelector('img')?.getAttribute('src'),
      source: d.gdhFeedSource || (row.matches('[data-gdh-debot-fomo-key]') ? 'fomo' : ''), color: stripe?.style.backgroundColor,
    }, location.hostname);
  }
  function renderCard(link, record) {
    const v = visualData(record.visual, location.hostname) || {};
    const cell = (cls, value = '', tag = 'span') => { const e = document.createElement(tag); e.className = `gdh-priority-${cls}`; e.textContent = value; return e; };
    const image = (src, cls, fallback = '') => {
      const wrap = cell(cls, fallback);
      if (src) {
        const img = document.createElement('img'); img.src = src; img.alt = ''; img.loading = 'lazy'; img.referrerPolicy = 'no-referrer';
        img.addEventListener('error', () => { img.remove(); wrap.textContent = fallback; }, { once: true });
        wrap.replaceChildren(img);
      }
      return wrap;
    };
    link.className = `gdh-priority-card${v.side ? ` is-${v.side}` : ''}`;
    if (v.color) link.style.setProperty('--gdh-priority-chain', v.color);
    const name = (record.strategy ? v.name || record.name : record.name || v.name) || record.wallet;
    const who = cell('who'); who.append(image(v.avatar, 'avatar', name.slice(0, 1)), cell('name', name, 'b'));
    if (v.source) who.append(cell('source', v.source === 'pump' ? 'Pump' : 'fomo'));
    const action = cell('action', v.action || ({ buy: '买入', sell: '卖出' }[v.side] || ''));
    who.append(action);
    const at = v.ts || record.at, seconds = Math.max(0, Math.floor((Date.now() - at) / 1000));
    const time = cell('time', seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.floor(seconds / 60)}m` : seconds < 86400 ? `${Math.floor(seconds / 3600)}h` : `${Math.floor(seconds / 86400)}d`, 'time');
    time.dateTime = new Date(at).toISOString(); time.title = new Date(at).toLocaleString('zh-CN');
    const amount = cell('amount'); if (v.amountImage) amount.append(image(v.amountImage, 'quote')); amount.append(document.createTextNode(v.amount || '—'));
    const token = cell('token');
    if (v.tokenImage) token.append(image(v.tokenImage, 'avatar'));
    const ca = record.href.split('?')[0].split('/').pop() || '';
    token.append(cell('symbol', v.symbol || `${ca.slice(0, 6)}…${ca.slice(-4)}`));
    const mc = cell('mc', v.mc || '—'); mc.title = '市值';
    link.append(time, who, amount, token, mc);
    if (record.strategy || !record.visual) {
      const detail = cell('detail', record.strategy ? `${record.name} · ${record.detail}` : record.detail);
      link.append(detail);
    }
  }
  globalThis.GdhPriorityPush = {
    create(navigate, options = {}) {
      const records = new Map();
      const sent = new Set();
      const pending = new Set();
      let root = null, box = null, wallets = new Map(), dirty = true, page = 0, walletKey = '', error = '', offsetTop = '0px';
      const strategies = globalThis.GdhBuyStrategies?.create();
      const strategyPending = new Map();
      let strategyActive = false;
      let strategyGroups = new Set();
      let clearing = false, view = {}, viewKey = '', minute = 0;
      const request = async (type, extra = {}) => {
        const result = await chrome.runtime.sendMessage({ type, ...extra });
        if (!result?.ok) throw new Error(result?.error || '扩展连接失效');
        return result;
      };
      const remember = (record) => {
        if (!record?.id) return;
        sent.add(record.id);
        if (record.dismissed) records.delete(record.id);
        else records.set(record.id, record);
        dirty = true;
      };
      const ready = request('priority-push-list').then(({ records: list }) => {
        for (const record of list || []) if (!sent.has(record.id)) remember(record);
      }).catch(() => { error = '读取本地提醒失败，请重新加载扩展'; }).finally(() => { dirty = true; render(); });

      function render() {
        if (!root?.isConnected) { box?.remove(); box = null; return; }
        if (!dirty && (!box || box.isConnected)) return;
        const active = [...records.values()].filter((record) => record.strategy ? strategyGroups.has(record.strategyGroup || 'legacy') : wallets.get(record.wallet)?.persistentPin === true)
          .sort((a, b) => b.at - a.at || a.id.localeCompare(b.id));
        if (!active.length && (!error || (!walletKey && !strategyActive))) { box?.remove(); box = null; dirty = false; return; }
        if (!box?.isConnected) {
          box = document.createElement('section');
          box.className = 'gdh-priority-push';
          box.style.top = offsetTop;
          box.setAttribute('aria-label', '重点提醒');
          root.appendChild(box);
          dirty = true;
        }
        if (!dirty) return;
        dirty = false;
        box.classList.toggle('is-table', view.table === true);
        for (const key of ['--gdh-feed-table-columns', '--gdh-feed-table-left', '--gdh-feed-table-right']) {
          const value = view.columns?.[key] || '';
          if (box.style.getPropertyValue(key) !== value) box.style.setProperty(key, value);
        }
        const lastPage = Math.max(0, Math.ceil(active.length / 20) - 1);
        page = Math.min(page, lastPage);
        const header = document.createElement('header');
        const title = document.createElement('strong');
        title.textContent = error || `重点提醒 · ${active.length} 条`;
        header.appendChild(title);
        const hint = document.createElement('small');
        hint.textContent = '点 × 关闭';
        header.appendChild(hint);
        const clear = document.createElement('button'); clear.type = 'button';
        clear.className = 'gdh-priority-clear'; clear.textContent = clearing ? '清除中…' : '全部清除';
        clear.title = '清除本站全部已保存的重点提醒（含其他页和隐藏提醒），不删除人物或策略；新提醒仍会出现';
        clear.disabled = clearing || !records.size;
        clear.addEventListener('click', async (event) => {
          event.preventDefault(); event.stopPropagation(); if (clearing) return;
          clearing = true; dirty = true; render();
          try {
            await ready;
            const result = await request('priority-push-clear');
            for (const id of result.ids || []) remember({ id, dismissed: true });
            error = ''; page = 0;
          } catch { error = '全部清除未保存，请重试'; }
          finally { clearing = false; dirty = true; render(); }
        });
        header.appendChild(clear);
        if (lastPage) {
          for (const [label, step] of [['上一页', -1], ['下一页', 1]]) {
            const button = document.createElement('button');
            button.type = 'button'; button.textContent = label;
            button.disabled = step < 0 ? page === 0 : page === lastPage;
            button.addEventListener('click', () => { page += step; dirty = true; render(); });
            header.appendChild(button);
          }
        }
        const list = document.createElement('div');
        list.className = 'gdh-priority-push__list';
        for (const record of active.slice(page * 20, page * 20 + 20)) {
          const row = document.createElement('article');
          row.dataset.priorityId = record.id;
          const link = document.createElement('a');
          link.href = record.href;
          renderCard(link, record);
          link.addEventListener('click', (event) => {
            if (event.button || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
            event.preventDefault(); event.stopPropagation(); navigate(record.href);
          });
          const close = document.createElement('button'); close.type = 'button'; close.textContent = '×';
          close.title = '关闭这条重点提醒'; close.setAttribute('aria-label', `关闭 ${record.name || '钱包'} 的重点提醒`);
          close.addEventListener('click', async (event) => {
            event.preventDefault(); event.stopPropagation(); close.disabled = true;
            try {
              await request('priority-push-dismiss', { id: record.id });
              remember({ id: record.id, dismissed: true }); error = '';
            } catch { error = '关闭未保存，请重试'; }
            dirty = true; render();
          });
          row.append(link, close); list.appendChild(row);
        }
        box.replaceChildren(header, list);
      }

      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local') return;
        const prefix = `${PREFIX}${location.hostname}:`;
        let changed = false;
        for (const [key, change] of Object.entries(changes)) {
          if (!key.startsWith(prefix)) continue;
          remember(change.newValue || { id: key.slice(prefix.length), dismissed: true }); changed = true;
        }
        if (changed) render();
      });

      const api = {
        setContext(panel, top, map, strategyConfig) {
          const nextView = options.view?.() || {}, nextViewKey = JSON.stringify(nextView);
          const nextMinute = Math.floor(Date.now() / 60000);
          if (nextViewKey !== viewKey || nextMinute !== minute) dirty = true;
          view = nextView; viewKey = nextViewKey; minute = nextMinute;
          const nextStrategyActive = globalThis.GdhBuyStrategies?.enabled(strategyConfig) === true;
          if (strategies?.configure(strategyConfig)) {
            for (const [key, alert] of strategyPending) if (!strategies.current(alert)) strategyPending.delete(key);
            dirty = true;
          }
          strategyGroups = new Set((globalThis.GdhBuyStrategies?.normalizeGroups(strategyConfig).groups || [])
            .filter(g => g.enabled && (g.conditions.group.enabled || g.conditions.amount.enabled)).map(g => g.id));
          strategyActive = nextStrategyActive;
          const nextKey = [...map].filter(([, meta]) => meta.persistentPin === true).map(([address]) => address).sort().join('|');
          if (root !== panel || walletKey !== nextKey) dirty = true;
          if (root !== panel) { box?.remove(); box = null; }
          root = panel; wallets = map; walletKey = nextKey;
          offsetTop = `${Math.max(0, Math.round(top || 0))}px`;
          render();
          if (box && box.style.top !== offsetTop) box.style.top = offsetTop;
        },
        async capture(id, record) {
          if (!id || pending.has(id)) return false;
          if (sent.has(id)) return true;
          pending.add(id);
          try {
            await ready;
            if (sent.has(id)) return true;
            const result = await request('priority-push-add', { id, record });
            remember(result.record); error = ''; render(); return true;
          } catch { error = '本地保存失败，请检查扩展存储'; dirty = true; render(); return false; }
          finally { pending.delete(id); }
        },
        scanBuys(rows) {
          if (!strategyActive || !root?.isConnected || !strategies) return;
          const events = rows.map(row => {
            const event = globalThis.GdhBuyStrategies.fromRow(row, location.hostname);
            return event && { ...event, visual: describe(row) };
          }).filter(Boolean);
          for (const alert of strategies.ingest(events)) if (!strategyPending.has(alert.key)) strategyPending.set(alert.key, alert);
          for (const alert of strategyPending.values()) {
            if (alert.sending) continue;
            alert.sending = true;
            (async () => {
              const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(alert.key));
              if (!strategyActive || strategyPending.get(alert.key) !== alert) return;
              const id = 'buy-strategy:' + [...new Uint8Array(digest)].map(n=>n.toString(16).padStart(2,'0')).join('');
              if (await api.capture(id, alert.record)) strategyPending.delete(alert.key);
            })().catch(() => { error = '策略提醒保存失败，请重试'; dirty = true; render(); })
              .finally(() => { alert.sending = false; });
          }
        },
      };
      return api;
    },
    describe,
    snapshot(row) {
      const copy = row.cloneNode(true);
      copy.querySelectorAll('button, .gdh-color-button, .gdh-debot-special-swatch').forEach((node) => node.remove());
      const walker = document.createTreeWalker(copy, NodeFilter.SHOW_TEXT);
      const parts = [];
      while (walker.nextNode()) parts.push(walker.currentNode.textContent);
      return clean(parts.join(' ').replace(/\s+/g, ' '), 500);
    },
  };
  const style = document.createElement('style');
  style.textContent = `
    .gdh-priority-push{position:absolute;z-index:98;left:0;right:0;max-height:48%;display:flex;flex-direction:column;background:rgb(var(--color-bg,18 18 18));color:rgb(var(--color-text-100,245 245 245));border:1px solid rgb(var(--color-line-100,36 36 36));border-radius:4px;box-shadow:0 4px 12px #0003;font-family:inherit;font-size:13px;line-height:18px;overflow:hidden}
    .gdh-priority-push>header{display:flex;flex-wrap:wrap;align-items:center;gap:4px 8px;padding:5px 8px;border-bottom:1px solid rgb(var(--color-line-100,36 36 36));flex-shrink:0}
    .gdh-priority-push>header strong{flex:1;min-width:0}.gdh-priority-push small,.gdh-priority-push time{color:rgb(var(--color-text-300,128 128 128));font-size:11px}
    .gdh-priority-push__list{overflow:auto;overscroll-behavior:contain;min-height:0}
    .gdh-priority-push article{position:relative;border-bottom:1px solid rgb(var(--color-line-100,36 36 36))}
    .gdh-priority-push a.gdh-priority-card{position:relative;display:grid;grid-template-columns:auto minmax(0,1fr) auto;grid-template-areas:'who who time' 'amount token mc';align-items:center;gap:4px 6px;box-sizing:border-box;min-height:64.5px;padding:10px 28px 10px 12px;color:inherit;text-decoration:none;font-size:13px;line-height:18px}
    .gdh-priority-card::before{content:'';position:absolute;left:0;top:0;bottom:0;width:5px;background:var(--gdh-priority-chain,transparent);pointer-events:none}
    .gdh-priority-who{grid-area:who;display:flex;align-items:center;gap:4px;min-width:0}
    .gdh-priority-name,.gdh-priority-symbol{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500}
    .gdh-priority-action{flex:none;font-size:12px}
    .gdh-priority-time{grid-area:time;white-space:nowrap}.gdh-priority-amount{grid-area:amount;display:flex;align-items:center;gap:2px;font-size:14px;white-space:nowrap}
    .gdh-priority-token{grid-area:token;display:flex;align-items:center;gap:4px;min-width:0}.gdh-priority-mc{grid-area:mc;white-space:nowrap;text-align:right}
    .gdh-priority-push:not(.is-table) .gdh-priority-mc::before{content:'MC:';color:rgb(var(--color-text-300,128 128 128))}
    .gdh-priority-avatar{display:inline-flex;align-items:center;justify-content:center;flex:none;width:16px;height:16px;border-radius:50%;overflow:hidden;font-size:10px;background:rgb(var(--color-card-100,23 23 23))}
    .gdh-priority-avatar img,.gdh-priority-quote img{width:100%;height:100%;object-fit:cover;display:block}.gdh-priority-quote{width:12px;height:12px;flex:none}
    .gdh-priority-source{font-size:9px;line-height:12px;border:1px solid currentColor;border-radius:2px;padding:0 2px;color:rgb(var(--color-text-300,128 128 128));flex:none}
    .gdh-priority-card.is-buy .gdh-priority-amount,.gdh-priority-card.is-buy .gdh-priority-action{color:rgb(var(--color-increase-200,70 184 125))}
    .gdh-priority-card.is-sell .gdh-priority-amount,.gdh-priority-card.is-sell .gdh-priority-action{color:rgb(var(--color-decrease-200,222 87 89))}
    .gdh-priority-detail{grid-column:1/-1;font-size:11px;color:rgb(var(--color-text-300,128 128 128));overflow-wrap:anywhere}
    .gdh-priority-push.is-table a.gdh-priority-card{grid-template-areas:none;grid-template-columns:var(--gdh-feed-table-columns,8% 1% 29% 1% 25% 1% 18% 1% 16%);gap:0;min-height:40px;padding:8px 24px 8px max(6px,var(--gdh-feed-table-left,6px));font-size:12px;line-height:16px}
    .gdh-priority-push.is-table .gdh-priority-time{grid-area:auto;grid-column:1}.gdh-priority-push.is-table .gdh-priority-who{grid-area:auto;grid-column:3;padding-right:3px}
    .gdh-priority-push.is-table .gdh-priority-token{grid-area:auto;grid-column:5}.gdh-priority-push.is-table .gdh-priority-amount{grid-area:auto;grid-column:7;font-size:12px;overflow:hidden;text-overflow:ellipsis}
    .gdh-priority-push.is-table .gdh-priority-mc{grid-area:auto;grid-column:9;overflow:hidden;text-overflow:ellipsis}.gdh-priority-push.is-table .gdh-priority-action{display:none}
    .gdh-priority-push.is-table .gdh-priority-card>:not(.gdh-priority-detail){grid-row:1}
    .gdh-priority-push.is-table .gdh-priority-detail{grid-row:2;padding-top:4px}
    .gdh-priority-push button{background:transparent;border:0;color:inherit;cursor:pointer;padding:4px 6px;flex-shrink:0;font:inherit}
    .gdh-priority-push article>button{position:absolute;right:0;top:5px;font-size:18px;width:24px;min-height:28px;padding:0}
    .gdh-priority-push button:disabled{opacity:.4;cursor:default}.gdh-priority-push a:hover,.gdh-priority-push button:hover{background:#ffffff0d}
    .gdh-priority-push :focus-visible{outline:2px solid #f2ce81;outline-offset:-2px}
  `;
  document.documentElement.appendChild(style);
})();
