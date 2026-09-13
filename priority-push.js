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

  if (typeof document === 'undefined') {
    // A single worker queue makes add/dismiss atomic across tabs. A dismissed event
    // keeps a small tombstone, so later scans cannot resurrect it.
    let queue = Promise.resolve();
    chrome.runtime.onMessage.addListener((message, sender, respond) => {
      if (!['priority-push-list', 'priority-push-add', 'priority-push-dismiss'].includes(message?.type)) return;
      const site = sender.id === chrome.runtime.id && siteOf(sender.url);
      if (!site) { respond({ ok: false, error: '无效的提醒来源' }); return; }
      queue = queue.then(async () => {
        const prefix = `${PREFIX}${site}:`;
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
        const record = { id, wallet, href: href.pathname + href.search, name: clean(data.name, 64),
          detail: clean(data.detail, 500), at: Date.now() };
        await chrome.storage.local.set({ [key]: record });
        return { ok: true, record };
      }).then(respond, (error) => respond({ ok: false, error: String(error?.message || error) }));
      return true;
    });
    return;
  }

  if (!sites.has(location.hostname) || globalThis.GdhPriorityPush) return;
  globalThis.GdhPriorityPush = {
    create(navigate) {
      const records = new Map();
      const sent = new Set();
      const pending = new Set();
      let root = null, box = null, wallets = new Map(), dirty = true, page = 0, walletKey = '', error = '', offsetTop = '0px';
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
        const active = [...records.values()].filter((record) => wallets.get(record.wallet)?.persistentPin === true)
          .sort((a, b) => b.at - a.at || a.id.localeCompare(b.id));
        if (!active.length && (!error || !walletKey)) { box?.remove(); box = null; dirty = false; return; }
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
        const lastPage = Math.max(0, Math.ceil(active.length / 20) - 1);
        page = Math.min(page, lastPage);
        const header = document.createElement('header');
        const title = document.createElement('strong');
        title.textContent = error || `重点提醒 · ${active.length} 条`;
        header.appendChild(title);
        const hint = document.createElement('small');
        hint.textContent = '点 × 关闭';
        header.appendChild(hint);
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
          const link = document.createElement('a');
          link.href = record.href;
          const name = document.createElement('b'); name.textContent = record.name || record.wallet;
          const time = document.createElement('time');
          time.textContent = new Date(record.at).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
          const detail = document.createElement('span'); detail.textContent = record.detail;
          link.append(name, time, detail);
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

      return {
        setContext(panel, top, map) {
          const nextKey = [...map].filter(([, meta]) => meta.persistentPin === true).map(([address]) => address).sort().join('|');
          if (root !== panel || walletKey !== nextKey) dirty = true;
          if (root !== panel) { box?.remove(); box = null; }
          root = panel; wallets = map; walletKey = nextKey;
          offsetTop = `${Math.max(0, Math.round(top || 0))}px`;
          render();
          if (box && box.style.top !== offsetTop) box.style.top = offsetTop;
        },
        async capture(id, record) {
          if (!id || pending.has(id) || sent.has(id)) return;
          pending.add(id);
          try {
            await ready;
            if (sent.has(id)) return;
            const result = await request('priority-push-add', { id, record });
            remember(result.record); error = ''; render();
          } catch { error = '本地保存失败，请检查扩展存储'; dirty = true; render(); }
          finally { pending.delete(id); }
        },
      };
    },
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
    .gdh-priority-push{position:absolute;z-index:98;left:4px;right:4px;max-height:48%;display:flex;flex-direction:column;background:#16181d;color:#e6e8ed;border:1px solid #856b36;border-radius:8px;box-shadow:0 6px 18px #0005;font:12px/1.5 system-ui;overflow:hidden}
    .gdh-priority-push>header{display:flex;align-items:center;gap:8px;padding:5px 8px;border-bottom:1px solid #ffffff18;flex-shrink:0}
    .gdh-priority-push>header strong{flex:1}.gdh-priority-push small,.gdh-priority-push time{color:#a9b1bf;font-size:10px}
    .gdh-priority-push__list{overflow:auto;overscroll-behavior:contain;min-height:0}
    .gdh-priority-push article{display:flex;border-bottom:1px solid #ffffff18;align-items:flex-start}
    .gdh-priority-push a{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:2px 8px;min-width:0;flex:1;padding:7px 8px;color:inherit;text-decoration:none}
    .gdh-priority-push b{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#f2ce81}
    .gdh-priority-push a>span{grid-column:1/-1;overflow-wrap:anywhere;white-space:normal}
    .gdh-priority-push button{background:transparent;border:0;color:inherit;cursor:pointer;padding:4px 6px;flex-shrink:0;font:inherit}
    .gdh-priority-push article>button{font-size:18px;min-width:28px;min-height:28px}
    .gdh-priority-push button:disabled{opacity:.4;cursor:default}.gdh-priority-push a:hover,.gdh-priority-push button:hover{background:#ffffff0d}
    .gdh-priority-push :focus-visible{outline:2px solid #f2ce81;outline-offset:-2px}
  `;
  document.documentElement.appendChild(style);
})();
