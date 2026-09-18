/* Genius.fun BSC fee policy, verified against the official 4.1.0 ABI (2026-09-18).
 * https://genius.fun/docs/integrate and /contracts/manifest.json
 * The four policy fields are actual trade basis points, NOT shares of feeBps.
 * Official UI: Creator payout = creatorBps + (toFoundation ? 0 : destinationBps).
 * No API/login, remote code, wallet access, signing or server relay.
 */
(function (root) {
  'use strict';
  const FACTORY = '0x78eae9537c0ef90dfe9b7ae964682fe8138afe31';
  const SELECTORS = { launch: '0x3cf28b5a', foundation: '0xb3287c09' };
  const ZERO = '0x' + '0'.repeat(40);
  const ADDRESS = /^0x[0-9a-f]{40}$/;
  const TTL = 5 * 60 * 1000;
  function words(raw, count) {
    if (typeof raw !== 'string' || !/^0x[0-9a-f]+$/i.test(raw) || raw.length !== 2 + count * 64) throw Error('bad-data');
    return raw.slice(2).match(/.{64}/g);
  }
  function number(word, max) {
    const n = BigInt('0x' + word);
    if (n > BigInt(max)) throw Error('bad-data');
    return Number(n);
  }
  function address(word) {
    if (!/^0{24}[0-9a-f]{40}$/i.test(word)) throw Error('bad-data');
    return '0x' + word.slice(24).toLowerCase();
  }
  function parseLaunch(raw, token) {
    const w = words(raw, 15);
    if (!number(w[14], 1)) return null;
    if (address(w[0]) !== token || address(w[1]) === ZERO) throw Error('bad-data');
    // Unknown future tax models must not receive an affirmative badge.
    if (number(w[8], 10000) !== 0) throw Error('unsupported-policy');
    return { curve: address(w[1]), creator: address(w[3]), quoteToken: address(w[4]), phase: number(w[10], 3) };
  }
  function parsePolicy(raw) {
    const w = words(raw, 6);
    const [destinationBps, platformBps, creatorBps, buybackBps] = w.slice(0, 4).map(v => number(v, 10000));
    const toFoundation = !!number(w[5], 1), foundationVault = address(w[4]);
    const totalBps = destinationBps + platformBps + creatorBps + buybackBps;
    if (totalBps <= 0 || totalBps > 10000 || (toFoundation && foundationVault === ZERO)) throw Error('bad-data');
    const creatorPayoutBps = creatorBps + (toFoundation ? 0 : destinationBps);
    return { destinationBps, platformBps, creatorBps, buybackBps, totalBps, toFoundation, foundationVault,
      creatorPayoutBps, warning: creatorPayoutBps > 25 };
  }
  function createReader({ rpcUrls, fetchImpl = (...args) => fetch(...args), now = Date.now,
    sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
    const cache = new Map(), pending = new Map(), cooldown = new Map();
    let tail = Promise.resolve(), lastStart = -Infinity;
    function remember(key, data, ttl) {
      cache.delete(key); cache.set(key, { data, expires: now() + ttl });
      while (cache.size > 400) cache.delete(cache.keys().next().value);
      return data;
    }
    async function call(rpc, data) {
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 6000);
      try {
        const res = await fetchImpl(rpc, { method: 'POST', headers: { 'Content-Type': 'application/json' },
          credentials: 'omit', signal: controller.signal,
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: FACTORY, data }, 'latest'] }) });
        if (!res.ok) throw Error(res.status === 429 ? 'rate-limited' : 'rpc-failed');
        const body = await res.json();
        if (body.id !== 1 || body.error || typeof body.result !== 'string') throw Error('rpc-failed');
        return body.result;
      } finally { clearTimeout(timer); }
    }
    async function read(token) {
      const delay = 750 - (now() - lastStart);
      if (delay > 0) await sleep(delay);
      lastStart = now();
      const arg = token.slice(2).padStart(64, '0');
      for (const rpc of rpcUrls) {
        if ((cooldown.get(rpc) || 0) > now()) continue;
        try {
          const launch = parseLaunch(await call(rpc, SELECTORS.launch + arg), token);
          if (!launch) return remember(token, { ok: false, reason: 'not-genius' }, 60 * 60 * 1000);
          const policy = parsePolicy(await call(rpc, SELECTORS.foundation + arg));
          return remember(token, { ok: true, kind: 'genius', token, factory: FACTORY, ...launch, ...policy, fetchedAt: now() }, TTL);
        } catch (e) {
          if (e.message === 'bad-data' || e.message === 'unsupported-policy') {
            return remember(token, { ok: false, reason: e.message }, 60000);
          }
          cooldown.set(rpc, now() + (e.message === 'rate-limited' ? 5 * 60000 : 30000));
        }
      }
      return remember(token, { ok: false, reason: 'rpc-failed' }, 30000);
    }
    return { get(token) {
      token = String(token || '').toLowerCase();
      if (!ADDRESS.test(token) || token === ZERO) return Promise.resolve({ ok: false, reason: 'bad-token' });
      const hit = cache.get(token);
      if (hit && hit.expires > now()) return Promise.resolve(hit.data);
      if (pending.has(token)) return pending.get(token);
      if (pending.size >= 64) return Promise.resolve({ ok: false, reason: 'busy' });
      const job = tail.then(() => read(token));
      tail = job.catch(() => {});
      pending.set(token, job);
      job.finally(() => pending.delete(token)).catch(() => {});
      return job;
    } };
  }
  const api = { FACTORY, SELECTORS, parseLaunch, parsePolicy, createReader };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.GDHGeniusFees = api;
})(globalThis);
