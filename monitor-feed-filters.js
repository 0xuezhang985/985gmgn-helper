(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.GdhMonitorFeedFilters = api;
})(globalThis, function () {
  'use strict';
  // Match 985monitor's push-chain groups, not GMGN's route names. Arc and other
  // unlisted chains belong to "other" until the website adds a separate choice.
  const chains = ['solana', 'bnb', 'eth', 'base', 'robinhood', 'hyperliquid', 'monad', 'other'];
  const names = {
    sol: 'solana', solana: 'solana', bnb: 'bnb', bsc: 'bnb', bnbchain: 'bnb', binancesmartchain: 'bnb',
    eth: 'eth', ethereum: 'eth', base: 'base', robinhood: 'robinhood', robinhoodchain: 'robinhood',
    hyperliquid: 'hyperliquid', hyperevm: 'hyperliquid', monad: 'monad',
  };
  const ids = { 1: 'eth', 56: 'bnb', 8453: 'base', 4663: 'robinhood', 999: 'hyperliquid',
    143: 'monad', 1399811149: 'solana', 792703809: 'solana' };
  const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const accountKey = value => String(value || '').trim().replace(/^0x[\da-f]{40}$/i, x => x.toLowerCase());

  function captureChannels(raw, accountId) {
    const prefs = object(raw), groups = object(prefs.chainFilters);
    const result = { accountId: accountKey(accountId) };
    for (const source of ['fomo', 'pump']) {
      const group = object(groups[source]);
      result[source] = {
        enabled: prefs[source === 'pump' ? 'pump-trade' : 'fomo'] !== false,
        blockedChains: chains.filter(chain => Object.hasOwn(group, chain) && group[chain] === false),
      };
    }
    return result;
  }

  function chainOf(event) {
    // Prefer a classification retained before slimming the original event.
    if (chains.includes(event?.monitorChain)) return event.monitorChain;
    for (const id of [event?.networkId, event?.chainId]) {
      if ((typeof id === 'number' || typeof id === 'string') && Object.hasOwn(ids, Number(id))) return ids[Number(id)];
    }
    for (const name of [event?.chain, event?.chainName]) {
      const key = String(name || '').toLowerCase().replace(/[\s_-]+/g, '');
      if (Object.hasOwn(names, key)) return names[key];
    }
    return 'other';
  }

  function allowed(event, source, snapshot, config) {
    // Never apply another 985monitor account's cached choices to this feed.
    if (!config?.connected) return false;
    if (!snapshot?.accountId || accountKey(snapshot.accountId) !== accountKey(config.wallet)) return true;
    const rule = object(snapshot[source]);
    return rule.enabled !== false && !(Array.isArray(rule.blockedChains) && rule.blockedChains.includes(chainOf(event)));
  }

  return { captureChannels, chainOf, allowed, accountKey };
});
