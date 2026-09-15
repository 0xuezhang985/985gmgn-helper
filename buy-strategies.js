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

  // One editor per open manager; feed scans only sync committed settings, never rebuild drafts.
  const managers = new WeakMap();
  function mountManager(modal, raw, wallets) {
    let state = managers.get(modal);
    if (!state) {
      const node = (tag, className, value) => {
        const el = document.createElement(tag);
        if (className) el.className = className;
        if (value) el.textContent = value;
        if (tag === 'button') el.type = 'button';
        return el;
      };
      const body = node('div', 'gdh-manager-wallets');
      while (modal.children.length > 1) body.append(modal.children[1]);
      const tabs = node('div', 'gdh-manager-tabs'); tabs.setAttribute('role', 'tablist');
      const people = node('button', '', '特别关注');
      const strategy = node('button', '', '策略追踪');
      strategy.append(node('em', 'gdh-manager-new', 'NEW'));
      const editor = node('div', 'gdh-strategy-editor');
      editor.append(node('p', 'gdh-strategy-hint', '命中任一策略即重点置顶，直到手动关闭。仅处理开启后的新买入，不自动交易。'));
      const fields = {}, boxes = [];
      for (const [type, title, hint, valueKey, valueTitle, min, max, step] of [
        ['group', '指定人物共同买入', '指定的所有人，在窗口内买入同链同一个币。', 'window', '时间窗口（秒）', '10', '3600', '1'],
        ['amount', '指定人物大额买入', '任一指定人物的单笔买入严格大于金额门槛。', 'usd', '单笔金额门槛（USD）', '0', '', 'any'],
      ]) {
        const box = node('fieldset'); boxes.push(box);
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
        box.append(toggle, node('p', 'gdh-strategy-hint', hint), numberLabel, picker, input); editor.append(box);
      }
      for (const [key, el] of Object.entries(fields)) el.dataset.buy = key;
      const actions = node('div', 'gdh-strategy-actions');
      const save = node('button', 'gdh-strategy-save', '保存策略');
      const reset = node('button', '', '重新读取');
      const status = node('div', 'gdh-strategy-status'); status.setAttribute('role', 'status');
      const show = (message, error = false) => { status.textContent = message; status.classList.toggle('is-error', error); };
      let dirty = false, conflict = false, saving = false, latest = normalize(raw), signature = JSON.stringify(latest), pickerKey = '';
      const fill = (config) => {
        for (const type of ['group', 'amount']) {
          fields[`${type}-enabled`].checked = config[type].enabled;
          fields[`${type}-wallets`].value = config[type].wallets.map(p => `${p.address} ${p.label}`.trim()).join('\n');
        }
        fields['group-window'].value = config.group.windowSeconds; fields['amount-usd'].value = config.amount.minUsd;
        dirty = conflict = false; save.disabled = false;
      };
      fill(latest);
      editor.addEventListener('input', () => { dirty = true; if (!conflict) show('尚未保存'); });
      reset.addEventListener('click', () => { fill(latest); show('已读取最新保存的策略'); });
      save.addEventListener('click', async () => {
        if (saving || conflict) return;
        let next;
        try { next = normalize(readFields(key => fields[key])); }
        catch (error) { show(error.message, true); return; }
        saving = true; save.disabled = reset.disabled = true; boxes.forEach(box => { box.disabled = true; });
        try {
          // Catch an external save even when the feed's next scheduled scan has not run yet.
          const stored = await chrome.storage.local.get('priorityBuyStrategies');
          const current = normalize(stored.priorityBuyStrategies);
          if (JSON.stringify(current) !== signature) {
            latest = current; signature = JSON.stringify(current); conflict = true;
            show('策略已在其他页面修改，请重新读取后再编辑。当前草稿未覆盖。', true);
          } else {
            await chrome.storage.local.set({ priorityBuyStrategies: next });
            latest = next; signature = JSON.stringify(next); fill(next); show('已保存，与插件设置同步');
          }
        } catch { show('保存失败，请重试；当前草稿已保留。', true); }
        finally { saving = false; save.disabled = conflict; reset.disabled = false; boxes.forEach(box => { box.disabled = false; }); }
      });
      actions.append(save, reset); editor.append(actions, status);
      tabs.append(people, strategy); modal.append(tabs, body, editor);
      const activate = button => {
        for (const [tab, content] of [[people, body], [strategy, editor]]) {
          const active = tab === button; tab.setAttribute('aria-selected', String(active)); content.hidden = !active;
        }
      };
      for (const [button, panel] of [[people, body], [strategy, editor]]) {
        button.setAttribute('role', 'tab'); panel.setAttribute('role', 'tabpanel');
        button.addEventListener('click', () => activate(button));
      }
      activate(people);
      for (const event of ['click', 'pointerdown', 'keydown']) modal.addEventListener(event, e => e.stopPropagation());
      state = { body, sync(config, list) {
        const next = normalize(config), key = JSON.stringify(next);
        if (!saving && key !== signature) {
          latest = next; signature = key;
          if (dirty) { conflict = true; save.disabled = true; show('策略已在其他页面修改，请重新读取后再编辑。当前草稿未覆盖。', true); }
          else { fill(next); show('已同步最新策略'); }
        }
        const entries = Array.isArray(list) ? list : [], listKey = JSON.stringify(entries);
        if (listKey === pickerKey) return;
        pickerKey = listKey;
        for (const type of ['group', 'amount']) {
          const picker = fields[`${type}-picker`]; picker.replaceChildren(new Option('从特别关注添加人物…', ''));
          for (const person of entries) {
            if (!address(person?.address)) continue;
            const label = text(person.label), a = address(person.address);
            picker.append(new Option(`${label || '未命名'} · ${a.slice(0, 6)}…${a.slice(-4)}`, `${a} ${label}`.trim()));
          }
        }
      } };
      managers.set(modal, state);
    }
    state.sync(raw, wallets);
    return state.body;
  }
  globalThis.GdhBuyStrategies = { normalize, enabled, parseWallets, create, fromRow, tagFeed, readFields, mountManager };
})();
