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
  const conditionEnabled = raw => { const c = normalize(raw); return c.group.enabled || c.amount.enabled; };
  const groupId = value => /^[a-zA-Z0-9_-]{1,64}$/.test(String(value || '')) ? String(value) : '';
  function normalizeGroups(raw) {
    if (!Array.isArray(raw?.groups)) {
      const conditions = normalize(raw);
      return { version: 2, groups: [{ id: 'legacy', name: '策略 1', enabled: conditionEnabled(conditions), conditions }] };
    }
    const seen = new Set();
    const groups = raw.groups.slice(0, 20).filter(g => groupId(g?.id) && !seen.has(g.id) && seen.add(g.id)).map((g, i) => ({
      id: g.id, name: text(g.name, 40) || `策略 ${i + 1}`, enabled: g.enabled === true,
      conditions: normalize(g.conditions),
    }));
    return { version: 2, groups };
  }
  const enabled = raw => normalizeGroups(raw).groups.some(g => g.enabled && conditionEnabled(g.conditions));
  function create(now = Date.now) {
    const runners = new Map();
    return {
      configure(raw) {
        const groups = normalizeGroups(raw).groups.filter(g => g.enabled && conditionEnabled(g.conditions));
        let changed = false;
        for (const id of runners.keys()) if (!groups.some(g => g.id === id)) { runners.delete(id); changed = true; }
        for (const group of groups) {
          let runner = runners.get(group.id);
          if (!runner) { runner = { engine: createSingle(now) }; runners.set(group.id, runner); changed = true; }
          changed = runner.engine.configure(group.conditions) || changed;
          runner.group = group; runner.key = JSON.stringify(group.conditions);
        }
        return changed;
      },
      current(alert) { return runners.get(alert.record.strategyGroup)?.key === alert.groupKey; },
      ingest(events) {
        if (!runners.size) return [];
        const ordered = orderedEvents(events), out = [];
        for (const [id, runner] of runners) for (const alert of runner.engine.ingest(ordered)) {
          out.push({ ...alert, key: id + '|' + alert.key, groupKey: runner.key,
            record: { ...alert.record, strategyGroup: id, name: `${runner.group.name} · ${alert.record.name.replace(/^买入策略 · /, '')}` } });
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
  function readFields(field) {
    const result = {};
    for (const type of ['group', 'amount']) {
      const on = field(`${type}-enabled`).checked;
      let wallets;
      try { wallets = parseWallets(field(`${type}-wallets`).value); }
      catch (error) { throw new Error(`${type === 'group' ? '共同买入' : '大额买入'}：${error.message}`); }
      if (on && wallets.length < (type === 'group' ? 2 : 1)) throw new Error(type === 'group' ? '共同买入至少需要 2 个不同钱包' : '大额买入至少需要 1 个钱包');
      result[type] = { enabled: on, wallets };
    }
    result.group.windowSeconds = Number(field('group-window').value);
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
  function createEditor(editor, raw, wallets) {
    editor.classList.add('gdh-strategy-editor');
    const intro = node('p', 'gdh-strategy-hint', '最多 20 组，各组独立保存和开关。组内满足任一条件即重点置顶；只读取当前页面新买入，不自动交易。');
    const toolbar = node('div', 'gdh-strategy-actions');
    const add = node('button', '', '+ 新增策略'); toolbar.append(add);
    const list = node('div', 'gdh-strategy-groups');
    const form = node('div', 'gdh-strategy-form');
    const nameLabel = node('label', 'gdh-strategy-number', '策略名称');
    const nameInput = node('input'); nameInput.type = 'text'; nameInput.maxLength = 40; nameInput.dataset.buy = 'name'; nameInput.setAttribute('aria-label', '策略名称'); nameLabel.append(nameInput); form.append(nameLabel);
    const fields = {};
      for (const [type, title, hint, valueKey, valueTitle, min, max, step] of [
        ['group', '指定人物共同买入', '指定的所有人，在窗口内买入同链同一个币。', 'window', '时间窗口（秒）', '10', '3600', '1'],
        ['amount', '指定人物大额买入', '任一指定人物的单笔买入严格大于金额门槛。', 'usd', '单笔金额门槛（USD）', '0', '', 'any'],
      ]) {
        const box = node('fieldset');
        const toggle = node('label', 'gdh-strategy-toggle');
        const check = node('input'); check.type = 'checkbox'; fields[`${type}-enabled`] = check;
        toggle.append(check, document.createTextNode(title));
        const numberLabel = node('label', 'gdh-strategy-number', valueTitle);
        const number = node('input'); number.type = 'number'; number.min = min; number.step = step;
        if (max) number.max = max;
        number.setAttribute('aria-label', valueTitle); fields[`${type}-${valueKey}`] = number; numberLabel.append(number);
        const picker = node('select'); picker.setAttribute('aria-label', `${title}：选择人物`);
        const input = node('textarea'); input.rows = 3; input.spellcheck = false;
        input.placeholder = '每行：完整钱包地址 备注（可选）'; input.setAttribute('aria-label', `${title}：钱包列表`);
        fields[`${type}-wallets`] = input; fields[`${type}-picker`] = picker;
        picker.addEventListener('change', () => {
          if (!picker.value) return;
          try {
            input.value = parseWallets(`${input.value}\n${picker.value}`).map(p => `${p.address} ${p.label}`.trim()).join('\n');
            input.dispatchEvent(new Event('input', { bubbles: true }));
          } catch (error) { show(error.message, true); }
          picker.value = '';
        });
        box.append(toggle, node('p', 'gdh-strategy-hint', hint), numberLabel, picker, input); form.append(box);
      }

    for (const [key, el] of Object.entries(fields)) el.dataset.buy = key;
    const actions = node('div', 'gdh-strategy-actions');
    const save = node('button', 'gdh-strategy-save', '保存本组');
    const reset = node('button', '', '重新读取');
    const remove = node('button', '', '删除本组');
    const status = node('div', 'gdh-strategy-status'); status.setAttribute('role', 'status');
    const show = (message, error = false) => { status.textContent = message; status.classList.toggle('is-error', error); };
    actions.append(save, reset, remove); form.append(actions);
    editor.append(intro, toolbar, list, form, status);
    let latest = normalizeGroups(raw), selected = latest.groups[0]?.id || '', busy = false, people = wallets, pickerKey = '', listKey = '';
    const drafts = new Map();
    const valuesOf = group => ({ name: group.name, ...Object.fromEntries(Object.keys(fields).filter(k => !k.endsWith('-picker')).map(key => {
      const [type, field] = key.split('-'), c = group.conditions[type];
      return [key, field === 'enabled' ? c.enabled : field === 'wallets' ? c.wallets.map(p => `${p.address} ${p.label}`.trim()).join('\n') : String(field === 'window' ? c.windowSeconds : c.minUsd)];
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
    };
    function renderList() {
      const rows = ids(), key = JSON.stringify(rows.map(id => { const d = draft(id); return [id,d.values.name,d.base?.enabled,d.dirty,d.conflict,selected===id]; }));
      if (key === listKey) return;
      listKey = key; list.replaceChildren(); add.disabled = rows.length >= 20;
      if (!rows.length) list.append(node('p', 'gdh-strategy-hint', '还没有策略，点击上方新增。'));
      for (const id of rows) {
        const d = draft(id), row = node('div', 'gdh-strategy-group'); row.dataset.groupId = id; row.classList.toggle('is-selected', id === selected);
        const select = node('button', '', `${d.values.name || '未命名策略'}${d.dirty ? ' · 未保存' : ''}`);
        select.title = d.values.name; select.setAttribute('aria-pressed', String(id === selected));
        select.addEventListener('click', () => { selected = id; fill(); renderList(); show(d.conflict ? '本组已在其他页面修改，请重新读取。草稿已保留。' : d.dirty ? '本组尚未保存' : '开关即时生效；修改条件后请保存本组。', d.conflict); });
        const label = node('label'); const toggle = node('input'); toggle.type = 'checkbox'; toggle.checked = d.base?.enabled === true; toggle.disabled = !d.base;
        toggle.setAttribute('aria-label', `启用 ${d.values.name}`);
        toggle.addEventListener('change', () => {
          const on = toggle.checked; toggle.checked = d.base?.enabled === true;
          if (d.dirty || d.conflict) { show('请先保存或重新读取本组，再切换开关。', true); return; }
          write(id, 'toggle', { enabled: on });
        });
        label.append(toggle, document.createTextNode(d.base?.enabled ? '开启' : '关闭')); row.append(select, label); list.append(row);
      }
    }
    const sync = (config, walletList) => {
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
      for (const type of ['group', 'amount']) {
        const picker = fields[`${type}-picker`]; picker.replaceChildren(new Option('从特别关注添加人物…', ''));
        for (const person of entries) {
          if (!address(person?.address)) continue;
          const label = text(person.label), a = address(person.address);
          picker.append(new Option(`${label || '未命名'} · ${a.slice(0, 6)}…${a.slice(-4)}`, `${a} ${label}`.trim()));
        }
      }
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
        show(error ? `保存失败：${error}；未保存的输入已保留。` : action === 'toggle' ? '本组开关已保存，不影响其他组。' : action === 'remove' ? '已删除本组。' : '本组已保存，与插件设置同步。', !!error);
        // Include any other group saved immediately after our worker response.
        try { const value = await chrome.storage.local.get('priorityBuyStrategies'); sync(value.priorityBuyStrategies, people); } catch { /* Keep confirmed result and drafts. */ }
      }
    }
    form.addEventListener('input', () => {
      const d = draft(selected); if (!d) return;
      d.values = { name: nameInput.value, ...Object.fromEntries(Object.entries(fields).filter(([k]) => !k.endsWith('-picker')).map(([key, el]) => [key,key.endsWith('-enabled') ? el.checked : el.value])) };
      d.dirty = true; renderList(); if (!d.conflict) show('本组尚未保存，切换策略不会丢失草稿。');
    });
    add.addEventListener('click', () => {
      if (ids().length >= 20) return;
      selected = crypto.randomUUID();
      drafts.set(selected, { base: null, values: valuesOf({ name: `策略 ${ids().length + 1}`, conditions: normalize() }), dirty: true, conflict: false });
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
      const d = draft(selected); if (!d || !confirm(`删除「${d.values.name || '未命名策略'}」？此操作仅删除本组。`)) return;
      if (!d.base) { drafts.delete(selected); selected = ids()[0] || ''; fill(); renderList(); show('已移除未保存的策略。'); }
      else write(selected, 'remove');
    });
    fill(); sync(raw, wallets);
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
  globalThis.GdhBuyStrategies = { normalize, normalizeGroups, enabled, parseWallets, create, fromRow, tagFeed, readFields, createEditor, mountManager };
})();
