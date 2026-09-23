/* GMGN's fixed-height recycler must see the final rows, not hidden/translated DOM.
 * No React state, original records, scrolling position or network calls are changed.
 */
(() => {
  'use strict';
  const address = value => /^0x/i.test(String(value || '')) ? String(value).toLowerCase() : String(value || '');
  const timestamp = value => Number(value) < 1e11 ? Number(value) * 1000 : Number(value);

  function recyclerProps(props) {
    return Array.isArray(props?.data) && typeof props.renderItem === 'function'
      && typeof props.itemKey === 'function' && props.itemHeight >= 20 && props.itemHeight <= 200;
  }

  function duplicate(feed, row) {
    if (!['buy', 'sell'].includes(feed.type)) return false;
    const tx = address(String(feed.tx || '').trim());
    const nativeTx = address(String(row.transaction_hash || row.tx_hash || '').trim());
    if (tx && nativeTx) return tx === nativeTx;
    if (feed.source !== 'pump' || !feed.pumpWallet) return false;
    const token = row.base_address || row.base_token?.address || row.token_address;
    const maker = row.maker || row.maker_info_address || row.maker_info?.address;
    const usd = Number(row.amount_usd) || Number(row.cost_usd) || 0;
    return address(feed.addr) === address(token) && address(feed.pumpWallet) === address(maker)
      && feed.type === row.side && (!feed.chain || !row.chain || feed.chain === row.chain)
      && Math.abs(feed.ts - timestamp(row.timestamp)) <= 15000 && feed.usd > 0 && usd > 0
      && Math.abs(feed.usd - usd) <= Math.max(1, Math.max(feed.usd, usd) * 0.05);
  }

  function create() {
    let revision = 0, signature = '', blocked = new Set(), feeds = [];
    let cache = new WeakMap();
    const wrapped = new WeakSet(), containers = new Map();
    const renderers = new WeakMap();
    const trackingRenderItems = new WeakSet();
    const emptyRows = Object.freeze([Object.freeze({ __gdhEmpty: true })]);

    function supported(props) {
      return recyclerProps(props) && (props['data-sentry-component'] === 'TrackerList'
        || (!props['data-sentry-component'] && trackingRenderItems.has(props.renderItem)));
    }

    function setConfig(config) {
      const next = JSON.stringify(config);
      if (next === signature) return false;
      signature = next;
      blocked = new Set((config.blocked || []).filter(value => typeof value === 'string'));
      feeds = (config.feeds || []).filter(row => row && typeof row.key === 'string' && Number(row.ts) > 0)
        .map(row => ({ ...row, __gdhFeed: true })).sort((a, b) => b.ts - a.ts);
      cache = new WeakMap();
      revision += 1;
      return true;
    }

    function project(data) {
      const cached = cache.get(data);
      if (cached) return cached;
      const native = blocked.size ? data.filter(row => {
        const token = address(row.base_address || row.base_token?.address || row.token_address);
        return !blocked.has(`|${token}`) && !blocked.has(`${row.chain || ''}|${token}`);
      }) : data;
      const extra = feeds.filter(feed => !data.some(row => duplicate(feed, row)));
      let result = native;
      if (extra.length) {
        result = [];
        let index = 0;
        for (const row of native) {
          while (index < extra.length && extra[index].ts >= timestamp(row.timestamp)) result.push(extra[index++]);
          result.push(row);
        }
        result.push(...extra.slice(index));
      } else if (native.length === data.length) result = data;
      cache.set(data, result);
      return result;
    }

    function wrap(type) {
      if (wrapped.has(type)) return;
      const render = type.render;
      type.render = function trackerRecyclerRender(props, ref) {
        if (!supported(props)) return render.call(this, props, ref);
        const projected = project(props.data);
        // GMGN's truly empty branch has no onScroll. Keep one native empty-state
        // slot so changing a block/feed setting can still use its update path.
        const data = projected.length ? projected : emptyRows;
        if (data === props.data) return render.call(this, props, ref);
        // The host element returned by this very renderer supplies React's element
        // version. Slot children render later; no React import or hook is required.
        let renderer = renderers.get(props.renderItem);
        if (!renderer || renderer.nativeKey !== props.itemKey || renderer.nativeOverlay !== props.renderItemOverlay || renderer.emptyText !== props.emptyText) {
          const nativeItem = props.renderItem, nativeKey = props.itemKey, nativeOverlay = props.renderItemOverlay;
          renderer = { nativeKey, nativeOverlay, emptyText: props.emptyText, template: null };
          const entry = renderer;
          entry.itemKey = (row, index) => row.__gdhEmpty ? 'gdh-empty' : row.__gdhFeed ? `gdh-feed:${row.key}` : nativeKey(row, index);
          entry.renderItem = (row, index) => row.__gdhEmpty ? {
            ...entry.template, type: 'div', key: null, ref: null, _owner: null,
            props: { className: 'gdh-native-tracker-empty', style: { padding: 12, opacity: 0.6 }, children: entry.emptyText || 'No matching records' },
          } : row.__gdhFeed ? {
            ...entry.template, type: 'div', key: null, ref: null, _owner: null,
            props: { 'data-gdh-native-feed-key': row.key, style: { height: '100%', overflow: 'hidden' } },
          } : nativeItem(row, index);
          entry.renderItemOverlay = nativeOverlay && ((row, index) => row.__gdhEmpty || row.__gdhFeed ? null : nativeOverlay(row, index));
          renderers.set(nativeItem, entry);
        }
        renderer.template = render.call(this, { ...props, data, itemKey: renderer.itemKey, renderItem: renderer.renderItem, renderItemOverlay: renderer.renderItemOverlay }, ref);
        return renderer.template;
      };
      wrapped.add(type);
    }

    function scan(root = document) {
      for (const element of containers.keys()) if (!element.isConnected) containers.delete(element);
      for (const element of root.querySelectorAll('.g-table-recycler-scroll')) {
        let handled = false;
        const key = Object.keys(element).find(name => name.startsWith('__reactFiber$'));
        let fiber = key && element[key];
        let current = fiber;
        for (let depth = 0; current?.return && depth < 80; depth += 1) current = current.return;
        if (current?.stateNode?.current && current.stateNode.current !== current) fiber = fiber.alternate || fiber;
        for (let depth = 0; fiber && depth < 12; depth += 1, fiber = fiber.return) {
          const props = fiber.memoizedProps;
          if (!recyclerProps(props) || typeof fiber.type?.render !== 'function') continue;
          // Current table mode has no TrackerList marker (45px). Authorize its
          // renderer only after observing complete trades inside TrackingBody.
          if (!props['data-sentry-component'] && element.closest('[data-sentry-component="TrackingBody"]')
            && props.data.length && props.data.every(row => row
              && (row.base_address || row.base_token?.address || row.token_address)
              && (row.maker || row.maker_info_address || row.maker_info?.address)
              && ['buy', 'sell'].includes(row.side) && Number(row.timestamp) > 0)) {
            trackingRenderItems.add(props.renderItem);
          }
          if (!supported(props)) continue;
          wrap(fiber.type);
          const hostKey = Object.keys(element).find(name => name.startsWith('__reactProps$'));
          if (typeof element[hostKey]?.onScroll !== 'function') break;
          handled = true;
          if (element.dataset.gdhNativeRecycler !== '1') element.dataset.gdhNativeRecycler = '1';
          if (containers.get(element) !== revision) {
            containers.set(element, revision);
            // Use the native onScroll update path once, without moving the viewport.
            element.dispatchEvent(new Event('scroll'));
          }
          break;
        }
        if (!handled && element.dataset.gdhNativeRecycler === '1') {
          delete element.dataset.gdhNativeRecycler;
          containers.delete(element);
        }
      }
    }

    return { setConfig, project, scan };
  }

  globalThis.GdhTrackingRecycler = { create };
})();
