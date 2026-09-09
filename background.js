'use strict';

const NATIVE_HOST = 'com.xuezhang985.gmgn_helper';
const RELEASES_URL = 'https://github.com/0xuezhang985/985gmgn-helper/releases/latest';
const UPDATE_ALARM = '985gmgn-update-check';
const MONITOR985_SYNC_ALARM = '985gmgn-account-sync';
const CHECK_INTERVAL_MINUTES = 360;
const RUNNING_VERSION_KEY = 'gdhRunningVersion';
const BREW_FACTORY = '0xeea6c3bfb29fd9a35380438956bae7b109c63d85';
const BREW_CHECKPOINT_URL = 'https://brewfamily.app/launch-checkpoint.json';
const BREW_BASELINE_PATH = 'brew-launch-baseline.json';
const BREW_CHAIN_CACHE_KEY = 'brewChainCheckpointV1';
const BREW_LOG_RPC_URLS = ['https://rpc-bsc.48.club', 'https://bsc.rpc.blxrbdn.com'];
const BREW_LAUNCH_TOPIC = '0xb091239373ed76ea7dc39ecbeef35cafced5943a8f7c9c5d88e711192f16910c';
const BREW_LOG_BLOCK_SPAN = 5000;
const BREW_LOG_MAX_CHUNKS = 8;
const BREW_MAX_TOKENS = 300;
const BREW_LOCAL_CACHE_MS = 2 * 60 * 1000;
let brewLocalCache = null;
let brewLocalPending = null;

/**
 * v0.46.44 曾把 Brew 面板误注入 brew.family。扩展升级会让旧脚本失效，
 * 但它已插入的 DOM 不会自动消失；版本变化时只清理这些遗留节点，不刷新页面。
 */
async function cleanupLegacyBrewPageUi() {
  try {
    const tabs = await chrome.tabs.query({ url: ['https://brew.family/*'] });
    await Promise.allSettled(
      tabs.filter((tab) => Number.isInteger(tab.id)).map((tab) => chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
          document.querySelectorAll('.gdh-brew-launcher, .gdh-brew-panel').forEach((node) => node.remove());
        },
      })),
    );
  } catch {
    // 清理失败不影响 GMGN / DeBot 正常升级
  }
}

/**
 * 一键升级会先替换扩展文件，再 chrome.runtime.reload()。已打开的支持站点
 * 页里还是旧 content script，扩展重载后它的 runtime 上下文已失效，不会
 * 自己变成新版。新后台首次启动时只刷新一次标签页，让新脚本真正注入。
 */
async function refreshSupportedTabsAfterVersionChange() {
  try {
    const version = chrome.runtime.getManifest().version;
    const stored = await chrome.storage.local.get(RUNNING_VERSION_KEY);
    if (stored?.[RUNNING_VERSION_KEY] === version) return;
    await cleanupLegacyBrewPageUi();
    const tabs = await chrome.tabs.query({ url: ['https://gmgn.ai/*', 'https://debot.ai/*'] });
    await Promise.allSettled(
      tabs.filter((tab) => Number.isInteger(tab.id)).map((tab) => chrome.tabs.reload(tab.id)),
    );
    await chrome.storage.local.set({ [RUNNING_VERSION_KEY]: version });
  } catch {
    // 下次 service worker 唤醒时重试；不影响其它功能
  }
}

refreshSupportedTabsAfterVersionChange();

function brewMarketNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function brewCheckpointIsValid(checkpoint) {
  return Boolean(checkpoint && String(checkpoint.factory || '').toLowerCase() === BREW_FACTORY
    && Array.isArray(checkpoint.tokens));
}

async function brewFetchCheckpointFile(url, timeoutMs = 0) {
  const controller = new AbortController();
  const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const response = await fetch(url, { cache: 'no-store', credentials: 'omit', signal: controller.signal });
    const checkpoint = await response.json().catch(() => null);
    if (!response.ok || !brewCheckpointIsValid(checkpoint)) throw new Error(`Brew HTTP ${response.status}`);
    return checkpoint;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function fetchBrewBaseCheckpoint() {
  const bundled = await brewFetchCheckpointFile(chrome.runtime.getURL(BREW_BASELINE_PATH));
  try {
    const official = await brewFetchCheckpointFile(BREW_CHECKPOINT_URL, 5000);
    return brewMergeCheckpoints([bundled, official]);
  } catch {
    return bundled;
  }
}

function brewCheckpointBlock(checkpoint) {
  const direct = Number.parseInt(String(checkpoint?.head?.number || ''), 16);
  if (Number.isFinite(direct) && direct > 0) return direct;
  return Math.max(0, ...(Array.isArray(checkpoint?.tokens) ? checkpoint.tokens : [])
    .map((token) => Number(token?.blockNumber) || 0));
}

function brewMergeCheckpoints(checkpoints) {
  const valid = (Array.isArray(checkpoints) ? checkpoints : []).filter(brewCheckpointIsValid);
  if (!valid.length) return null;
  const freshest = [...valid].sort((a, b) => brewCheckpointBlock(b) - brewCheckpointBlock(a))[0];
  const ordered = valid.flatMap((checkpoint) => checkpoint.tokens).filter((token) => token && typeof token === 'object')
    .sort((a, b) => Number(b.blockNumber || 0) - Number(a.blockNumber || 0)
      || Number(b.logIndex || 0) - Number(a.logIndex || 0)
      || Number(b.launchedAt || 0) - Number(a.launchedAt || 0));
  const seen = new Set();
  const tokens = [];
  for (const token of ordered) {
    const address = String(token.address || '').toLowerCase();
    if (!/^0x[a-f0-9]{40}$/.test(address) || seen.has(address)) continue;
    seen.add(address);
    tokens.push(token);
    if (tokens.length >= BREW_MAX_TOKENS) break;
  }
  return { ...freshest, factory: BREW_FACTORY, total: tokens.length, tokens };
}

function brewLogBytes(hex) {
  const body = String(hex || '').replace(/^0x/, '');
  if (!body || body.length % 2) return null;
  const bytes = new Uint8Array(body.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    const byte = Number.parseInt(body.slice(index * 2, index * 2 + 2), 16);
    if (!Number.isFinite(byte)) return null;
    bytes[index] = byte;
  }
  return bytes;
}

function brewLogWord(bytes, index) {
  return bytes?.slice(index * 32, (index + 1) * 32) || new Uint8Array();
}

function brewLogBigInt(bytes) {
  let hex = '';
  for (const byte of bytes || []) hex += byte.toString(16).padStart(2, '0');
  return BigInt(`0x${hex || '0'}`);
}

function brewLogAddress(value) {
  const hex = typeof value === 'string'
    ? value.replace(/^0x/, '')
    : [...(value || [])].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  const address = `0x${hex.slice(-40)}`.toLowerCase();
  return /^0x[a-f0-9]{40}$/.test(address) ? address : '';
}

function brewLogText(bytes, offsetWord) {
  try {
    const offset = Number(brewLogBigInt(offsetWord));
    if (!Number.isSafeInteger(offset) || offset < 0 || offset + 32 > bytes.length) return '';
    const length = Number(brewLogBigInt(bytes.slice(offset, offset + 32)));
    if (!Number.isSafeInteger(length) || length < 0 || length > 100000 || offset + 32 + length > bytes.length) return '';
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.slice(offset + 32, offset + 32 + length)).trim();
  } catch {
    return '';
  }
}

function brewMetadata(uri) {
  try {
    const match = String(uri || '').match(/^data:application\/json(?:;charset=[^;,]+)?(;base64)?,(.*)$/is);
    if (!match) return {};
    let text;
    if (match[1]) {
      const binary = atob(match[2]);
      text = new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
    } else {
      text = decodeURIComponent(match[2]);
    }
    const doc = JSON.parse(text);
    const socials = doc?.socials && typeof doc.socials === 'object' ? doc.socials : {};
    return {
      description: String(doc?.description || '').slice(0, 1000) || null,
      imageUrl: String(doc?.image || doc?.imageUrl || '').slice(0, 50000) || null,
      website: String(doc?.website || socials.website || '').slice(0, 500) || null,
      twitter: String(doc?.twitter || socials.twitter || socials.x || '').slice(0, 500) || null,
      telegram: String(doc?.telegram || socials.telegram || '').slice(0, 500) || null,
    };
  } catch {
    return {};
  }
}

function decodeBrewLaunchLog(log) {
  const topics = Array.isArray(log?.topics) ? log.topics : [];
  const bytes = brewLogBytes(log?.data);
  if (topics.length !== 4 || String(topics[0]).toLowerCase() !== BREW_LAUNCH_TOPIC || !bytes || bytes.length < 256) return null;
  const address = brewLogAddress(topics[1]);
  const creator = brewLogAddress(topics[2]);
  const quoteAddress = brewLogAddress(topics[3]);
  const pool = brewLogAddress(brewLogWord(bytes, 0));
  const name = brewLogText(bytes, brewLogWord(bytes, 5));
  const symbol = brewLogText(bytes, brewLogWord(bytes, 6));
  const metadataUri = brewLogText(bytes, brewLogWord(bytes, 7));
  const launchedAt = Number.parseInt(String(log.blockTimestamp || ''), 16) * 1000;
  const blockNumber = Number.parseInt(String(log.blockNumber || ''), 16);
  if (!address || !creator || !quoteAddress || !pool || !name || !symbol
    || !Number.isFinite(launchedAt) || !Number.isFinite(blockNumber)) return null;
  return {
    address,
    creator,
    quoteAddress,
    pool,
    name: name.slice(0, 64),
    symbol: symbol.slice(0, 32),
    ...brewMetadata(metadataUri),
    launchedAt,
    blockNumber,
    blockHash: String(log.blockHash || '').slice(0, 80),
    transactionHash: String(log.transactionHash || '').slice(0, 80),
    logIndex: Number.parseInt(String(log.logIndex || ''), 16) || 0,
  };
}

async function brewLogRpc(method, params) {
  let lastError = null;
  for (const rpcUrl of BREW_LOG_RPC_URLS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        cache: 'no-store',
        signal: controller.signal,
      });
      const body = await response.json().catch(() => null);
      if (!response.ok || body?.error || body?.result == null) throw new Error(body?.error?.message || `Brew RPC ${response.status}`);
      return body.result;
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError || new Error('Brew RPC unavailable');
}

async function hydrateBrewQuoteSymbols(tokens, knownTokens) {
  const known = new Map((Array.isArray(knownTokens) ? knownTokens : [])
    .map((token) => [String(token?.quoteAddress || '').toLowerCase(), String(token?.quoteSymbol || '')])
    .filter(([address, symbol]) => /^0x[a-f0-9]{40}$/.test(address) && symbol && symbol !== 'Quote'));
  const missing = [...new Set((Array.isArray(tokens) ? tokens : [])
    .map((token) => token.quoteAddress).filter((address) => address && !known.has(address)))];
  for (let index = 0; index < missing.length; index += 25) {
    const batch = missing.slice(index, index + 25);
    let symbols = null;
    for (const rpc of FLAP_RPCS) {
      try {
        symbols = await flapRpc(rpc, batch.map((address) => ({ to: address, data: '0x95d89b41' })));
        break;
      } catch {
        // 换公共节点；计价币符号缺失不影响发行与行情主体。
      }
    }
    if (!symbols) continue;
    batch.forEach((address, offset) => {
      const symbol = flapString(symbols[offset]);
      if (symbol) known.set(address, symbol.slice(0, 40));
    });
  }
  return (Array.isArray(tokens) ? tokens : []).map((token) => ({
    ...token,
    quoteSymbol: known.get(token.quoteAddress) || 'Quote',
  }));
}

async function advanceBrewCheckpoint(checkpoint) {
  const start = brewCheckpointBlock(checkpoint) + 1;
  const latest = Number.parseInt(await brewLogRpc('eth_blockNumber', []), 16);
  if (!Number.isFinite(latest) || start > latest) return { ...checkpoint, complete: true, catchUp: [] };
  const ranges = [];
  for (let from = start; from <= latest && ranges.length < BREW_LOG_MAX_CHUNKS; from += BREW_LOG_BLOCK_SPAN) {
    ranges.push({ from, to: Math.min(latest, from + BREW_LOG_BLOCK_SPAN - 1) });
  }
  const logs = [];
  for (let index = 0; index < ranges.length; index += 4) {
    const wave = ranges.slice(index, index + 4);
    const results = await Promise.all(wave.map(({ from, to }) => brewLogRpc('eth_getLogs', [{
      fromBlock: `0x${from.toString(16)}`,
      toBlock: `0x${to.toString(16)}`,
      address: BREW_FACTORY,
      topics: [BREW_LAUNCH_TOPIC],
    }])));
    results.forEach((rows) => logs.push(...(Array.isArray(rows) ? rows : [])));
  }
  const decoded = await hydrateBrewQuoteSymbols(logs.map(decodeBrewLaunchLog).filter(Boolean), checkpoint.tokens);
  const scannedTo = ranges.at(-1)?.to || latest;
  const merged = brewMergeCheckpoints([checkpoint, {
    factory: BREW_FACTORY,
    head: { number: `0x${scannedTo.toString(16)}` },
    complete: scannedTo >= latest,
    tokens: decoded,
  }]);
  return {
    ...merged,
    complete: scannedTo >= latest,
    catchUp: scannedTo < latest ? [{ from: scannedTo + 1, to: latest }] : [],
  };
}

async function loadBrewCheckpoint() {
  const base = await fetchBrewBaseCheckpoint();
  const stored = await chrome.storage.local.get({ [BREW_CHAIN_CACHE_KEY]: null }).catch(() => ({}));
  let checkpoint = brewMergeCheckpoints([base, stored[BREW_CHAIN_CACHE_KEY]]) || base;
  let chainPartial = false;
  try {
    checkpoint = await advanceBrewCheckpoint(checkpoint);
    await chrome.storage.local.set({ [BREW_CHAIN_CACHE_KEY]: checkpoint });
  } catch {
    chainPartial = true;
  }
  return { ...checkpoint, chainPartial };
}

const BREW_ARTWORK_RE = /^onchain:\/\/56\/(0x[a-fA-F0-9]{40})$/;
const BREW_ARTWORK_DATA_RE = /^data:image\/(?:png|jpeg|webp);base64,[a-zA-Z0-9+/=]+$/;
const BREW_ARTWORK_MAX_DATA_URL = 40000;
const brewArtworkCache = new Map();

function brewArtworkMime(bytes) {
  if (bytes.length > 12 && bytes[0] === 82 && bytes[1] === 73 && bytes[2] === 70
    && bytes[3] === 70 && bytes[8] === 87 && bytes[9] === 69 && bytes[10] === 66 && bytes[11] === 80) {
    return 'image/webp';
  }
  if (bytes.length > 8 && bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71) {
    return 'image/png';
  }
  if (bytes.length > 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  return '';
}

function brewDecodeArtworkCode(code) {
  const hex = String(code || '');
  if (!hex.startsWith('0x00') || hex.length < 30 || hex.length > 47004 || (hex.length - 4) % 2 !== 0) return '';
  const body = hex.slice(4);
  const bytes = new Uint8Array(body.length / 2);
  let binary = '';
  for (let index = 0; index < bytes.length; index += 1) {
    const byte = Number.parseInt(body.slice(index * 2, index * 2 + 2), 16);
    if (!Number.isFinite(byte)) return '';
    bytes[index] = byte;
    binary += String.fromCharCode(byte);
  }
  const mime = brewArtworkMime(bytes);
  return mime ? `data:${mime};base64,${btoa(binary)}` : '';
}

async function brewArtworkRpc(rpc, contracts) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(rpc, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(contracts.map((contract, index) => ({
        jsonrpc: '2.0', id: index + 1, method: 'eth_getCode', params: [contract, 'latest'],
      }))),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`http-${response.status}`);
    const body = await response.json();
    const list = Array.isArray(body) ? body : [body];
    const byId = new Map(list.map((item) => [item.id, item]));
    return contracts.map((_, index) => byId.get(index + 1)?.result || '');
  } finally {
    clearTimeout(timer);
  }
}

async function hydrateBrewArtwork(tokens) {
  const list = Array.isArray(tokens) ? tokens : [];
  const contracts = [...new Set(list.map((token) => String(token?.imageUrl || '').match(BREW_ARTWORK_RE)?.[1]?.toLowerCase())
    .filter((contract) => contract && !brewArtworkCache.has(contract)))];
  for (let index = 0; index < contracts.length; index += 30) {
    const batch = contracts.slice(index, index + 30);
    let codes = null;
    for (const rpc of FLAP_RPCS) {
      try {
        codes = await brewArtworkRpc(rpc, batch);
        break;
      } catch {
        // 当前公共节点不可用时换下一个，头像失败不影响代币与行情主体。
      }
    }
    if (!codes) continue;
    batch.forEach((contract, offset) => {
      const dataUrl = brewDecodeArtworkCode(codes[offset]);
      if (dataUrl) brewArtworkCache.set(contract, dataUrl);
    });
  }
  return list.map((token) => {
    const raw = String(token?.imageUrl || '');
    const direct = raw.length <= BREW_ARTWORK_MAX_DATA_URL && BREW_ARTWORK_DATA_RE.test(raw) ? raw : '';
    const contract = raw.match(BREW_ARTWORK_RE)?.[1]?.toLowerCase();
    return { ...token, imageUrl: direct || (contract ? brewArtworkCache.get(contract) || '' : '') };
  });
}

function compactBrewGmgnMarket(item) {
  const address = String(item?.address || '').toLowerCase();
  const pairAddress = String(item?.pool?.pool_address || item?.biggest_pool_address || '').toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(address) || !/^0x[a-f0-9]{40}$/.test(pairAddress)) return null;
  const price = brewMarketNumber(item?.price?.price);
  const price24h = brewMarketNumber(item?.price?.price_24h);
  const circulatingSupply = brewMarketNumber(item?.circulating_supply);
  const totalSupply = brewMarketNumber(item?.total_supply);
  return {
    pairAddress,
    baseToken: { address },
    priceUsd: price,
    marketCap: price != null && circulatingSupply != null ? price * circulatingSupply : null,
    fdv: price != null && totalSupply != null ? price * totalSupply : null,
    volume: { h24: brewMarketNumber(item?.price?.volume_24h) },
    liquidity: { usd: brewMarketNumber(item?.liquidity) },
    priceChange: { h24: price != null && price24h > 0 ? ((price / price24h) - 1) * 100 : null },
    txns: {
      h24: {
        buys: brewMarketNumber(item?.price?.buys_24h),
        sells: brewMarketNumber(item?.price?.sells_24h),
      },
    },
    dexId: String(item?.pool?.exchange || '').slice(0, 30),
    labels: [],
  };
}

async function requestBrewMarketsInGmgnPage(addresses) {
  const batches = [];
  for (let index = 0; index < addresses.length; index += 10) batches.push(addresses.slice(index, index + 10));
  const items = [];
  let failedBatches = 0;
  for (let index = 0; index < batches.length; index += 4) {
    const wave = await Promise.allSettled(batches.slice(index, index + 4).map(async (batch) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      try {
        const response = await fetch('/api/v1/mutil_window_token_info', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ chain: 'bsc', addresses: batch }),
          cache: 'no-store',
          signal: controller.signal,
        });
        const body = await response.json().catch(() => null);
        if (!response.ok || body?.code !== 0 || !Array.isArray(body?.data)) throw new Error(`HTTP ${response.status}`);
        return body.data;
      } finally {
        clearTimeout(timer);
      }
    }));
    for (const result of wave) {
      if (result.status === 'fulfilled') items.push(...result.value);
      else failedBatches += 1;
    }
  }
  return { items, failedBatches, totalBatches: batches.length };
}

async function waitForBrewGmgnTab(tabId) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (tab?.status === 'complete') return true;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return false;
}

async function fetchBrewGmgnMarkets(tokens) {
  const addresses = [...new Set((Array.isArray(tokens) ? tokens : [])
    .map((token) => String(token?.address || '').toLowerCase())
    .filter((address) => /^0x[a-f0-9]{40}$/.test(address)))].slice(0, 300);
  if (!addresses.length) return { pairs: [], failedBatches: 0, totalBatches: 0 };
  let temporaryTabId = null;
  try {
    const openTabs = await chrome.tabs.query({ url: ['https://gmgn.ai/*'] });
    let tab = openTabs.find((candidate) => Number.isInteger(candidate.id) && candidate.status === 'complete')
      || openTabs.find((candidate) => Number.isInteger(candidate.id));
    if (!tab) {
      tab = await chrome.tabs.create({ url: 'https://gmgn.ai/?chain=bsc', active: false });
      temporaryTabId = tab?.id;
    }
    if (!Number.isInteger(tab?.id) || (tab.status !== 'complete' && !await waitForBrewGmgnTab(tab.id))) {
      throw new Error('GMGN 本地资源页加载超时');
    }
    const execution = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      func: requestBrewMarketsInGmgnPage,
      args: [addresses],
    });
    const result = execution?.[0]?.result;
    if (!result || !Array.isArray(result.items)) throw new Error('GMGN 本地行情无响应');
    return {
      pairs: result.items.map(compactBrewGmgnMarket).filter(Boolean),
      failedBatches: Number(result.failedBatches) || 0,
      totalBatches: Number(result.totalBatches) || 0,
    };
  } catch {
    return { pairs: [], failedBatches: 1, totalBatches: Math.ceil(addresses.length / 10) };
  } finally {
    if (Number.isInteger(temporaryTabId)) chrome.tabs.remove(temporaryTabId).catch(() => {});
  }
}

async function fetchBrewTrenches(force = false) {
  if (!force && brewLocalCache && Date.now() - brewLocalCache.fetchedAt < BREW_LOCAL_CACHE_MS) return brewLocalCache;
  if (brewLocalPending) return brewLocalPending;
  brewLocalPending = (async () => {
    try {
      const checkpoint = await loadBrewCheckpoint();
      const [market, tokens] = await Promise.all([
        fetchBrewGmgnMarkets(checkpoint.tokens),
        hydrateBrewArtwork(checkpoint.tokens),
      ]);
      brewLocalCache = {
        ok: true,
        checkpoint: { ...checkpoint, tokens },
        pairs: market.pairs,
        marketPartial: market.failedBatches > 0,
        launchPartial: checkpoint.chainPartial === true || checkpoint.complete === false,
        fetchedAt: Date.now(),
        localSource: true,
      };
      return brewLocalCache;
    } catch (error) {
      if (brewLocalCache) return { ...brewLocalCache, stale: true };
      return { ok: false, reason: 'request', message: String(error?.message || '本地 Brew 数据暂时不可用') };
    } finally {
      brewLocalPending = null;
    }
  })();
  return brewLocalPending;
}

/**
 * 985monitor 标签页可能在扩展升级前就已打开。扩展重载后旧 content script 的
 * chrome.runtime 上下文会失效，而页面本身不刷新，导致明明登录却一直显示未连接。
 * 先 ping 现有脚本让它主动同步；只有收不到响应时才重新注入 content.js，避免
 * 重复监听器/定时器，也不打断用户正在看的 985monitor 页面。
 */
async function wakeOpenMonitor985Tabs() {
  try {
    const tabs = await chrome.tabs.query({
      url: ['https://985monitor.xyz/*', 'https://*.985monitor.xyz/*'],
    });
    await Promise.allSettled(tabs.filter((tab) => Number.isInteger(tab.id)).map(async (tab) => {
      const alive = await new Promise((resolve) => {
        chrome.tabs.sendMessage(tab.id, { type: '985-monitor-sync-now' }, (response) => {
          resolve(!chrome.runtime.lastError && response?.ok === true);
        });
      });
      if (alive) return;
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => { window.__gdhContentStarted = false; },
      });
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
    }));
  } catch {
    // 没有打开 985monitor、页面正在关闭或浏览器尚未恢复标签时无需打扰其它功能。
  }
}

wakeOpenMonitor985Tabs();

function sendNativeMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendNativeMessage(NATIVE_HOST, message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(response);
    });
  });
}

async function saveUpdateState(state) {
  await chrome.storage.local.set({ updateState: state });
  if (state.updateAvailable) {
    await chrome.action.setBadgeBackgroundColor({ color: '#29d17d' });
    await chrome.action.setBadgeText({ text: 'UP' });
    await chrome.action.setTitle({ title: `better gmgn：发现 v${state.latestVersion}` });
    return;
  }
  await chrome.action.setBadgeText({ text: '' });
  await chrome.action.setTitle({ title: 'better gmgn' });
}

async function checkForUpdate() {
  const currentVersion = chrome.runtime.getManifest().version;
  try {
    const response = await sendNativeMessage({
      action: 'check',
      currentVersion,
    });
    if (!response?.ok) {
      throw new Error(response?.error || '更新器未返回有效结果');
    }

    const state = {
      status: response.updateAvailable ? 'available' : 'latest',
      currentVersion,
      latestVersion: response.latestVersion || currentVersion,
      updateAvailable: Boolean(response.updateAvailable),
      updaterInstalled: true,
      releaseUrl: response.releaseUrl || RELEASES_URL,
      checkedAt: Date.now(),
    };
    await saveUpdateState(state);
    return state;
  } catch (error) {
    const state = {
      status: 'updater_missing',
      currentVersion,
      updateAvailable: false,
      updaterInstalled: false,
      releaseUrl: RELEASES_URL,
      error: error.message || '本地更新器不可用',
      checkedAt: Date.now(),
    };
    await saveUpdateState(state);
    return state;
  }
}

async function installUpdate() {
  const currentVersion = chrome.runtime.getManifest().version;
  const response = await sendNativeMessage({
    action: 'update',
    currentVersion,
  });
  if (!response?.ok) {
    throw new Error(response?.error || '升级失败');
  }
  return response;
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(UPDATE_ALARM, { periodInMinutes: CHECK_INTERVAL_MINUTES });
  chrome.alarms.create(MONITOR985_SYNC_ALARM, { periodInMinutes: 5 });
  checkForUpdate();
  refreshMonitor985Config(true).then(() => restartFomoSse());
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(UPDATE_ALARM, { periodInMinutes: CHECK_INTERVAL_MINUTES });
  chrome.alarms.create(MONITOR985_SYNC_ALARM, { periodInMinutes: 5 });
  checkForUpdate();
  // 浏览器关着的时间不跑任何代码，开机时令牌多半已经过期，先补一次
  fomoKeepAlive(true);
  refreshMonitor985Config(true).then(() => restartFomoSse());
});

// fomo 登录态保活：privy access 令牌约 1 小时过期。原来只在用到 fomo 接口时
// 被动续期——几天不开 fomo 面板，refresh 链会闲置到过期，又得回去重新登录。
// 这里改成主动：每 10 分钟查一次，只在快过期（剩余 <12 分钟）时才续——
// 每次续期都会轮换 refresh（旧的作废），续得越勤、和网页 localStorage 失同步的
// 分叉窗口越多，所以把轮换压到每小时恰好一次。写回照旧 + fomo-early.js 在页面
// 加载最早时刻抢先同步，双保险。
const FOMO_KEEPALIVE_ALARM = '985gmgn-fomo-keepalive';
// 用 create 的幂等性：同名闹钟已存在时不会重置计时。
// 之前直接在模块顶层 create——service worker 每次休眠/唤醒都重跑一遍模块，
// 闹钟被反复重建、计时永远归零，10 分钟的周期实际从来没走到过。
chrome.alarms.get(FOMO_KEEPALIVE_ALARM).then((existing) => {
  if (!existing) chrome.alarms.create(FOMO_KEEPALIVE_ALARM, { periodInMinutes: 5 });
}).catch(() => {});
chrome.alarms.get(MONITOR985_SYNC_ALARM).then((existing) => {
  if (!existing) chrome.alarms.create(MONITOR985_SYNC_ALARM, { periodInMinutes: 5 });
}).catch(() => {});

// 令牌实测寿命整 60 分钟（iat→exp 恰好 3600 秒）。SW 会被浏览器随时挂起，
// 挂起期间不跑任何代码，所以剩 20 分钟就确保页面 owner 已存在且不可丢弃；
// 真正的轮换时机仍由页面 Privy SDK 自己决定。
const FOMO_REFRESH_AHEAD_MS = 20 * 60000;
const FOMO_KEEPER_URL = 'https://fomo.family/?gdh_keeper=1';
let fomoKeepAliveAt = 0;

/** 开着的 fomo.family 标签页 */
async function fomoOpenTabs() {
  try {
    return await chrome.tabs.query({ url: ['https://fomo.family/*', 'https://*.fomo.family/*'] });
  } catch {
    return [];
  }
}

/**
 * fomo 页面还活着吗——活着它就是 privy 轮换链的主人。
 * 靠 content script 的 15 秒心跳判断，不靠 tabs.query：标签页在不在是一回事，
 * 里面的 JS 还跑不跑是另一回事（Chrome 会冻结长期后台标签页，冻住的页面不会续期）。
 */
async function fomoPageAlive() {
  try {
    const { fomoPage } = await chrome.storage.local.get('fomoPage');
    return !!(fomoPage?.at && Date.now() - fomoPage.at < 45000);
  } catch {
    return false;
  }
}

/**
 * Privy 的 refresh 不是一个可脱离页面裸调的公开契约。实测页面 SDK 会额外带
 * Authorization / privy-ca-id / privy-client-id 等会话上下文，后台只交 refresh_token
 * 会稳定返回 403。这里确保恰好有一个真实页面承担续期，并阻止 Chrome 丢弃它。
 */
async function fomoEnsureSdkOwner(requireDedicated = false) {
  try {
    const tabs = await fomoOpenTabs();
    const keepers = tabs.filter((tab) => String(tab.url || '').includes('gdh_keeper='));
    let owner = keepers.find((tab) => !tab.discarded) || keepers[0];
    let created = false;
    if (!owner && !requireDedicated) owner = tabs.find((tab) => !tab.discarded && tab.status === 'complete');
    if (!owner && !requireDedicated) owner = tabs.find((tab) => !tab.discarded);
    if (!owner) {
      owner = await chrome.tabs.create({ url: FOMO_KEEPER_URL, active: false, pinned: true });
      created = true;
      await fomoAuthNote('keeper-created');
    }
    const dedicated = String(owner.url || '').includes('gdh_keeper=');
    const wasDiscarded = !!owner.discarded;
    owner = await chrome.tabs.update(owner.id, {
      autoDiscardable: false,
      ...(dedicated ? { pinned: true } : {}),
    });
    if (wasDiscarded || (requireDedicated && dedicated && !created)) {
      await chrome.tabs.reload(owner.id);
      await fomoAuthNote(wasDiscarded ? 'keeper-reloaded' : 'keeper-woken');
    }
    return owner;
  } catch (error) {
    await fomoAuthNote('keeper-failed', { message: String(error?.message || '').slice(0, 80) });
    return null;
  }
}

/** 等页面把它续出来的新令牌镜像过来（content.js 每 5 秒同步一次）。 */
async function fomoWaitMirror(prevToken, timeoutMs = 35000) {
  const attempts = Math.max(1, Math.ceil(timeoutMs / 1000));
  for (let i = 0; i < attempts; i += 1) {
    await new Promise((r) => setTimeout(r, 1000));
    const { fomoToken } = await chrome.storage.local.get('fomoToken');
    if (fomoToken?.token && fomoToken.token !== prevToken) return fomoToken;
  }
  return null;
}

async function fomoKeepAlive(force) {
  try {
    // 同一分钟内被多个入口触发时只做一次
    if (!force && Date.now() - fomoKeepAliveAt < 60000) return;
    fomoKeepAliveAt = Date.now();
    const { fomoToken } = await chrome.storage.local.get('fomoToken');
    if (!fomoToken?.refresh) return; // 从未登录/会话已被 privy 作废，无从保活
    const exp = Number(fomoToken.exp) || 0;
    const left = exp ? exp - Date.now() : 0;
    if (exp && left > FOMO_REFRESH_AHEAD_MS) return; // 还很新鲜，不动

    // 页面 SDK 是唯一 refresh owner。没有活页时创建一个后台守护页；已有普通 fomo 页
    // 就只设为不可丢弃，不擅自把用户正在看的页钉住或刷新。
    const owner = await fomoEnsureSdkOwner();
    if (!owner) return;
    if (await fomoPageAlive()) {
      await fomoAuthNote('defer-to-page', { leftMin: Math.round(left / 60000) });
      if (force) await fomoRefreshSession();
      return;
    }
    // 普通标签页可能只是“未丢弃”但 JS 已冻结。心跳断了就确保专用 keeper 存在；
    // 专用页可以安全重载，不会打断用户正在看的 FOMO 页面。
    await fomoEnsureSdkOwner(true);
    if (force) await fomoRefreshSession();
  } catch {
    // 网络抖动等，下一轮再试
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === UPDATE_ALARM) checkForUpdate();
  if (alarm.name === FOMO_KEEPALIVE_ALARM) fomoKeepAlive();
  if (alarm.name === MONITOR985_SYNC_ALARM) {
    refreshMonitor985Config(true).then(() => restartFomoSse());
  }
});

// ---- fomo 代币数据（在后台取，避开页面 CORS/CSP；令牌由 fomo.family 上的脚本捕获）----
const FOMO_API = 'https://prod-api.fomo.family';
// fomo 自己每个请求都带这个头（少了它 /hodlers/top 会返回空）：eth,bnb,monad,robinhood,base,solana
const FOMO_CHAINS = '1,56,143,4663,8453,1399811149';
const FOMO_CACHE_MS = 90 * 1000;
const FOMO_CACHE_MAX = 60;
const fomoCache = new Map();
const fomoTokenPending = new Map();
// Fomo 首次打开持仓者页时还会补每个用户的 7 天 PnL。旧版由 GMGN/DeBot
// 各自并发发送，请求会瞬间堆到官方 API，命中 Cloudflare 429 后又被 30 秒轮询
// 持续续打，导致限流一直无法自行解除。所有 Fomo API 请求统一走这条串行闸门。
const FOMO_REQUEST_GAP_MS = 1500;
const FOMO_429_BASE_MS = 5 * 60 * 1000;
const FOMO_429_MAX_MS = 30 * 60 * 1000;
const FOMO_RATE_LIMIT_KEY = 'fomoRateLimitStateV1';
let fomoRequestTail = Promise.resolve();
let fomoNextRequestAt = 0;
let fomoRateLimitUntil = 0;
let fomoRateLimitLevel = 0;
let fomoRateLimitLastAt = 0;
let fomoRateLimitReady = null;

async function fomoLoadRateLimit() {
  if (fomoRateLimitReady) return fomoRateLimitReady;
  fomoRateLimitReady = chrome.storage.local.get(FOMO_RATE_LIMIT_KEY).then((stored) => {
    const state = stored?.[FOMO_RATE_LIMIT_KEY];
    const now = Date.now();
    const until = Number(state?.until) || 0;
    if (until > now) fomoRateLimitUntil = Math.min(until, now + FOMO_429_MAX_MS);
    fomoRateLimitLevel = Math.max(0, Math.min(4, Math.trunc(Number(state?.level) || 0)));
    fomoRateLimitLastAt = Math.max(0, Number(state?.lastAt) || 0);
  }).catch(() => {});
  return fomoRateLimitReady;
}

function fomoRetryAfterMs(response, now = Date.now()) {
  const raw = String(response?.headers?.get?.('Retry-After') || '').trim();
  let serverDelay = 0;
  if (/^\d+$/.test(raw)) serverDelay = Number(raw) * 1000;
  else if (raw) {
    const at = Date.parse(raw);
    if (Number.isFinite(at)) serverDelay = Math.max(0, at - now);
  }
  const exponential = FOMO_429_BASE_MS * (2 ** Math.max(0, fomoRateLimitLevel - 1));
  return Math.min(FOMO_429_MAX_MS, Math.max(FOMO_429_BASE_MS, serverDelay, exponential));
}

function fomoBackoffResponse(now = Date.now()) {
  const seconds = Math.max(1, Math.ceil((fomoRateLimitUntil - now) / 1000));
  return new Response(JSON.stringify({ error: 'rate_limited' }), {
    status: 429,
    headers: {
      'Content-Type': 'application/json',
      'Retry-After': String(seconds),
      'X-GDH-Fomo-Backoff': '1',
    },
  });
}

async function fomoQueuedFetch(run) {
  await fomoLoadRateLimit();
  const task = fomoRequestTail.then(async () => {
    let now = Date.now();
    if (now < fomoRateLimitUntil) return fomoBackoffResponse(now);
    const wait = Math.max(0, fomoNextRequestAt - now);
    if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
    now = Date.now();
    if (now < fomoRateLimitUntil) return fomoBackoffResponse(now);

    const response = await run();
    fomoNextRequestAt = Date.now() + FOMO_REQUEST_GAP_MS;
    if (response?.status === 429) {
      const hitAt = Date.now();
      if (hitAt - fomoRateLimitLastAt > FOMO_429_MAX_MS) fomoRateLimitLevel = 0;
      fomoRateLimitLevel = Math.min(4, fomoRateLimitLevel + 1);
      fomoRateLimitLastAt = hitAt;
      fomoRateLimitUntil = hitAt + fomoRetryAfterMs(response, hitAt);
      await chrome.storage.local.set({
        [FOMO_RATE_LIMIT_KEY]: {
          until: fomoRateLimitUntil,
          level: fomoRateLimitLevel,
          lastAt: fomoRateLimitLastAt,
        },
      }).catch(() => {});
    }
    return response;
  });
  fomoRequestTail = task.catch(() => {});
  return task;
}

function setBoundedMap(map, key, value, max) {
  if (map.has(key)) map.delete(key);
  map.set(key, value);
  while (map.size > max) map.delete(map.keys().next().value);
}

// 985monitor 的 Robinhood RWA 目录。只把 203 个资产及浮窗所需的核心字段
// 传给内容脚本，不把 1MB+ 的池子明细塞进消息；目录按合约地址匹配，绝不凭 symbol 猜。
const ROBINHOOD_RWA_CATALOG_URL = 'https://www.985monitor.xyz/rwa/data.json';
const ROBINHOOD_RWA_CATALOG_TTL = 15 * 60 * 1000;
let robinhoodRwaCatalogCache = null;
let robinhoodRwaCatalogPending = null;

function compactRobinhoodRwaCatalog(payload) {
  return (Array.isArray(payload?.rwa) ? payload.rwa : [])
    .map((item) => {
      const description = String(item?.ds || '').replace(/[\r\n\t]/g, ' ').slice(0, 240);
      const numeric = (value) => value !== null && value !== undefined && value !== ''
        && Number.isFinite(Number(value)) ? Number(value) : null;
      return {
        address: String(item?.c || '').toLowerCase(),
        symbol: String(item?.s || '').replace(/[\r\n\t]/g, '').slice(0, 24),
        description: description.includes('\uFFFD') ? '' : description,
        onchainPrice: numeric(item?.on),
        referencePrice: numeric(item?.r),
        premiumPct: numeric(item?.p),
        liquidityUsd: numeric(item?.l),
        volume24hUsd: numeric(item?.v),
        onchainMarketCapUsd: numeric(item?.cmc),
        referenceMarketCapUsd: numeric(item?.cap),
        onchainSupply: numeric(item?.u),
        referenceSharePct: numeric(item?.sh),
        deployedAt: String(item?.dep || '').replace(/[\r\n\t]/g, '').slice(0, 24),
      };
    })
    .filter((item) => /^0x[a-f0-9]{40}$/.test(item.address) && item.symbol);
}

async function fetchRobinhoodRwaCatalog() {
  if (robinhoodRwaCatalogCache
    && Date.now() - robinhoodRwaCatalogCache.at < ROBINHOOD_RWA_CATALOG_TTL) {
    return { ok: true, assets: robinhoodRwaCatalogCache.assets };
  }
  if (robinhoodRwaCatalogPending) return robinhoodRwaCatalogPending;
  robinhoodRwaCatalogPending = (async () => {
    try {
      const response = await fetch(ROBINHOOD_RWA_CATALOG_URL, {
        cache: 'no-store',
        credentials: 'omit',
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const assets = compactRobinhoodRwaCatalog(await response.json());
      if (!assets.length) throw new Error('empty catalog');
      robinhoodRwaCatalogCache = { at: Date.now(), assets };
      return { ok: true, assets };
    } catch (error) {
      if (robinhoodRwaCatalogCache?.assets?.length) {
        return { ok: true, stale: true, assets: robinhoodRwaCatalogCache.assets };
      }
      return { ok: false, reason: 'request', message: String(error?.message || '') };
    } finally {
      robinhoodRwaCatalogPending = null;
    }
  })();
  return robinhoodRwaCatalogPending;
}

// StonkFun 的 Solana RWA 配对资产目录。只接受站点明确标为 xstock 的报价币，
// 并保留大小写敏感的 Solana mint；不按 symbol/name 推断，避免同名币误命中。
const STONKFUN_RWA_CATALOG_URL = 'https://www.stonkfun.xyz/api/quote-tokens';
const STONKFUN_RWA_CATALOG_TTL = 15 * 60 * 1000;
let stonkfunRwaCatalogCache = null;
let stonkfunRwaCatalogPending = null;

function compactStonkfunRwaCatalog(payload) {
  return (Array.isArray(payload?.quoteTokens) ? payload.quoteTokens : [])
    .map((item) => {
      const address = String(item?.quoteMint || '').trim();
      const symbol = String(item?.symbol || '').replace(/[\r\n\t]/g, '').slice(0, 24);
      const name = String(item?.name || '').replace(/[\r\n\t]/g, ' ').slice(0, 80);
      const decimals = Number(item?.decimals);
      return {
        address,
        symbol,
        name,
        description: `${name || symbol} · StonkFun xStocks RWA 配对资产`,
        category: String(item?.category || '').toLowerCase(),
        decimals: Number.isInteger(decimals) && decimals >= 0 && decimals <= 18 ? decimals : null,
        network: 'Solana',
        source: 'stonkfun',
      };
    })
    .filter((item) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(item.address)
      && item.symbol && item.category === 'xstock');
}

async function fetchStonkfunRwaCatalog() {
  if (stonkfunRwaCatalogCache
    && Date.now() - stonkfunRwaCatalogCache.at < STONKFUN_RWA_CATALOG_TTL) {
    return { ok: true, assets: stonkfunRwaCatalogCache.assets };
  }
  if (stonkfunRwaCatalogPending) return stonkfunRwaCatalogPending;
  stonkfunRwaCatalogPending = (async () => {
    try {
      const response = await fetch(STONKFUN_RWA_CATALOG_URL, {
        cache: 'no-store',
        credentials: 'omit',
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const assets = compactStonkfunRwaCatalog(await response.json());
      if (!assets.length) throw new Error('empty catalog');
      stonkfunRwaCatalogCache = { at: Date.now(), assets };
      return { ok: true, assets };
    } catch (error) {
      if (stonkfunRwaCatalogCache?.assets?.length) {
        return { ok: true, stale: true, assets: stonkfunRwaCatalogCache.assets };
      }
      return { ok: false, reason: 'request', message: String(error?.message || '') };
    } finally {
      stonkfunRwaCatalogPending = null;
    }
  })();
  return stonkfunRwaCatalogPending;
}

/** 递归找出响应里第一个「对象数组」，避开各层包装字段名的不确定性。 */
function firstObjectArray(value, depth) {
  if (!value || typeof value !== 'object' || depth > 4) return null;
  if (Array.isArray(value)) {
    if (value.length && typeof value[0] === 'object' && value[0] !== null && !Array.isArray(value[0])) {
      // 数组元素本身还套着一层（如 [{hodlers:[...]}]）时继续往里找
      const inner = firstObjectArray(value[0], depth + 1);
      const keys = Object.keys(value[0]);
      if (inner && inner.length && keys.length <= 4) return inner;
      return value;
    }
    return null;
  }
  for (const key of Object.keys(value).slice(0, 30)) {
    const hit = firstObjectArray(value[key], depth + 1);
    if (hit && hit.length) return hit;
  }
  return null;
}

// ---- 令牌自动续期 ----
// fomo 用 Privy 登录，访问令牌约一小时过期。扩展只镜像页面 SDK 续出的令牌；
// 不再自己轮换 refresh_token，避免缺页面上下文的 403 与双 owner 分叉。
let fomoRefreshInFlight = null;

// 登录态出问题时只能靠猜，太被动：留一份最近 20 条的续期流水，面板上能看。
async function fomoAuthNote(what, extra) {
  try {
    const { fomoAuthLog } = await chrome.storage.local.get('fomoAuthLog');
    const log = Array.isArray(fomoAuthLog) ? fomoAuthLog : [];
    log.unshift({ at: Date.now(), what, ...(extra || {}) });
    await chrome.storage.local.set({ fomoAuthLog: log.slice(0, 20) });
  } catch {
    // 存不下就算了，诊断不该影响主流程
  }
}

function jwtExpMs(token) {
  try {
    const payload = JSON.parse(atob(String(token).split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    return Number(payload.exp) > 0 ? Number(payload.exp) * 1000 : 0;
  } catch {
    return 0;
  }
}

async function fomoRefreshSession() {
  if (fomoRefreshInFlight) return fomoRefreshInFlight;
  fomoRefreshInFlight = (async () => {
    const { fomoToken } = await chrome.storage.local.get('fomoToken');
    if (!fomoToken?.refresh) return null;
    const owner = await fomoEnsureSdkOwner(!(await fomoPageAlive()));
    if (!owner) return null;
    const adopted = await fomoWaitMirror(fomoToken.token);
    if (adopted) {
      await fomoAuthNote('adopt-from-page', { expMin: Math.round((adopted.exp - Date.now()) / 60000) });
      return adopted;
    }
    // 页面刚加载而旧 JWT 尚未到 exp 时，SDK 合法地选择不轮换；保留可用旧令牌。
    const latest = (await chrome.storage.local.get('fomoToken')).fomoToken || null;
    if (latest?.token && Number(latest.exp) > Date.now()) return latest;
    await fomoAuthNote('page-refresh-timeout');
    return null;
  })().catch(() => null);
  try {
    return await fomoRefreshInFlight;
  } finally {
    fomoRefreshInFlight = null;
  }
}

function fomoBodyUnauthed(body) {
  const inner = Number(body?.statusCode);
  const error = String(body?.error || body?.message || '').trim();
  return inner === 401 || inner === 403 || /\bunauthori[sz]ed\b|\bunauthenticated\b/i.test(error);
}

async function fomoResponseUnauthed(response) {
  if (response?.status === 401) return true;
  const probe = await response?.clone?.().json().catch(() => null);
  return fomoBodyUnauthed(probe);
}

/** 带令牌打 fomo 接口：快过期先交给页面 SDK 续，被拒再等待镜像并重试。 */
async function fomoAuthedFetch(path, init = {}) {
  let stored = (await chrome.storage.local.get('fomoToken')).fomoToken || null;
  // 剩不到 10 秒才等待页面续期；更早等待只会让一次正常请求白卡 35 秒。
  if (stored?.refresh && stored.exp && stored.exp - Date.now() < 10000) {
    // 续期失败要区分两种：privy 把会话作废了（存储已被清空，应引导重新登录）
    // 还是只是这次没成（旧令牌还留着，照旧拿它试一把）
    stored = (await fomoRefreshSession())
      || (await chrome.storage.local.get('fomoToken')).fomoToken
      || null;
  }
  const send = (token) => {
    const headers = {
      Accept: 'application/json',
      'X-Supported-Chains': FOMO_CHAINS,
      ...(init.headers || {}),
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    return fomoQueuedFetch(() => fetch(`${FOMO_API}${path}`, {
      ...init,
      headers,
      credentials: 'include',
    }));
  };
  let res = await send(stored?.token);
  let renewed = false;
  let unauthed = await fomoResponseUnauthed(res);
  if (unauthed && stored?.refresh) {
    const next = await fomoRefreshSession();
    if (next?.token && next.token !== stored?.token) {
      renewed = true;
      stored = next;
      res = await send(next.token);
      unauthed = await fomoResponseUnauthed(res);
    } else if (!(await chrome.storage.local.get('fomoToken')).fomoToken) {
      stored = null; // 会话已被 privy 作废，按「没有令牌」上报，引导重新登录
    }
  }
  return { res, stored, renewed, unauthed };
}

async function fomoFetchToken({ tokenAddress, networkId, kind }) {
  const key = `${kind}|${networkId}|${tokenAddress}`;
  const hit = fomoCache.get(key);
  if (hit && Date.now() - hit.at < FOMO_CACHE_MS) return hit.data;

  let token;

  let path;
  if (kind === 'thesis') {
    path = `/feed/token/thesis?tokenAddress=${tokenAddress}&networkId=${networkId}&threshold=0&limit=50`;
  } else if (kind === 'holders') {
    // fomo 内部拼写是 hodlers；tokens 是 URL 编码后的 JSON 数组
    const tokens = encodeURIComponent(JSON.stringify([{ address: tokenAddress, networkId }]));
    path = `/hodlers/top?tokens=${tokens}`;
  } else {
    path = `/feed/token?tokenAddress=${tokenAddress}&networkId=${networkId}&excludeThesis=true&limit=50`;
  }
  try {
    // 复用浏览器里的 fomo 登录态（cookie）+ Bearer；过期时等待页面 SDK 续期并镜像。
    // credentials:'include' 同时让请求更像正常浏览器请求（fomo 在 Cloudflare 后面）。
    const { res, stored, renewed, unauthed } = await fomoAuthedFetch(path);
    token = stored?.token;
    if (!res.ok && unauthed && !token) {
      return { ok: false, reason: 'no-token', status: res.status, tokenAt: 0 };
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const blocked = /cloudflare|cf-ray|<!DOCTYPE html/i.test(text);
      const rateLimited = res.status === 429;
      return {
        ok: false,
        reason: rateLimited ? 'rate-limited'
          : unauthed ? (token ? 'expired' : 'no-token')
          : (blocked ? 'blocked' : `http-${res.status}`),
        status: res.status,
        retryAfterMs: rateLimited ? Math.max(1000, fomoRateLimitUntil - Date.now()) : 0,
        tokenAt: stored?.at || 0,
        renewed,
      };
    }
    const body = await res.json().catch(() => null);
    // fomo 失败时照样回 HTTP 200，真正的结果在 body.success / body.statusCode 里。
    // 不看这两个字段就会把「登录过期」当成「没有数据」渲染成空列表。
    const inner = Number(body?.statusCode);
    if (body?.success === false || (Number.isFinite(inner) && inner !== 200)) {
      const unauth = inner === 401 || inner === 403;
      return {
        ok: false,
        reason: unauth ? (token ? 'expired' : 'no-token') : `api-${inner || 'error'}`,
        status: inner || res.status,
        message: String(body?.message || '').slice(0, 120),
        tokenAt: stored?.at || 0,
        renewed,
      };
    }
    const ro = body?.responseObject;
    // 字段名取自 fomo 前端自己的取数代码：
    //   /hodlers/top -> responseObject[0] = { totalHolders, topHolders: [...] }
    //   /feed/token* -> responseObject   = { items: [...], hasNextPage, count }
    let items;
    let total;
    if (kind === 'holders') {
      const box = Array.isArray(ro) ? ro[0] : ro;
      items = box?.topHolders;
      total = Number(box?.totalHolders);
    } else {
      items = Array.isArray(ro) ? ro : ro?.items;
    }
    // fomo 改结构时的兜底：递归找出第一个对象数组
    if (!Array.isArray(items)) items = firstObjectArray(ro, 0) || [];
    const data = { ok: true, items, count: items.length };
    if (Number.isFinite(total)) data.total = total;
    setBoundedMap(fomoCache, key, { at: Date.now(), data }, FOMO_CACHE_MAX);
    return data;
  } catch (error) {
    return {
      ok: false,
      reason: 'network',
      message: String(error?.message || '').slice(0, 80),
    };
  }
}

function fomoFetchTokenShared(payload) {
  const key = `${String(payload?.kind || '')}|${Number(payload?.networkId) || 0}|${String(payload?.tokenAddress || '')}`;
  const existing = fomoTokenPending.get(key);
  if (existing) return existing;
  const request = fomoFetchToken(payload || {});
  fomoTokenPending.set(key, request);
  return request.finally(() => {
    if (fomoTokenPending.get(key) === request) fomoTokenPending.delete(key);
  });
}

// ---- 单个用户的 7 天盈亏（给持仓者打标记用）----
// fomo 悬浮卡是「实时余额算的累计 PnL − 7 天前快照的 PnL」，要两个请求。
// 这里用同一条快照序列的首末差，一个请求就够，代价是最多滞后一小时——打标记足够了。
const FOMO_PNL_TTL = 10 * 60 * 1000;
const FOMO_PNL_CACHE_MAX = 500;
const fomoPnlCache = new Map();

async function fomoUserPnl7d({ userId }) {
  if (!userId) return { ok: false, reason: 'no-user' };
  const hit = fomoPnlCache.get(userId);
  if (hit && Date.now() - hit.at < FOMO_PNL_TTL) return hit.data;

  const since = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
  const path = `/v2/userTokens/aggregatedSnapshot?userId=${encodeURIComponent(userId)}&timestamp=${encodeURIComponent(since)}`;
  try {
    const { res, unauthed } = await fomoAuthedFetch(path);
    if (!res.ok) return {
      ok: false,
      reason: res.status === 429 ? 'rate-limited' : (unauthed ? 'expired' : `http-${res.status}`),
      status: res.status,
      retryAfterMs: res.status === 429 ? Math.max(1000, fomoRateLimitUntil - Date.now()) : 0,
    };
    const body = await res.json().catch(() => null);
    const inner = Number(body?.statusCode);
    if (body?.success === false || (Number.isFinite(inner) && inner !== 200)) {
      return { ok: false, reason: inner === 401 ? 'expired' : `api-${inner || 'error'}` };
    }
    // 快照项：{ snapshotId, equity, pnl }，pnl 是「截至该时刻的累计盈亏」
    const rows = (Array.isArray(body?.responseObject) ? body.responseObject : [])
      .filter((r) => r && Number.isFinite(Number(r.pnl)))
      .sort((a, b) => Number(a.snapshotId) - Number(b.snapshotId));
    if (rows.length < 2) {
      const data = { ok: true, pnl: null, equity: Number(rows[0]?.equity) || 0, points: rows.length };
      setBoundedMap(fomoPnlCache, userId, { at: Date.now(), data }, FOMO_PNL_CACHE_MAX);
      return data;
    }
    const first = rows[0];
    const last = rows[rows.length - 1];
    const data = {
      ok: true,
      pnl: Number(last.pnl) - Number(first.pnl),
      equity: Number(last.equity) || 0,
      points: rows.length,
    };
    setBoundedMap(fomoPnlCache, userId, { at: Date.now(), data }, FOMO_PNL_CACHE_MAX);
    return data;
  } catch (error) {
    return { ok: false, reason: 'network', message: String(error?.message || '').slice(0, 80) };
  }
}

// ---- Flap 代币税收信息（全部从公开 BSC RPC 直读，不依赖任何第三方服务）----
// 契约实测自链上已验证源码：
//   代币 FlapTaxTokenV3 —— getPoolStateData() / taxRate() / taxProcessor()
//                          / mainPool() / dividendContract() / quoteToken()
//   税收处理器 TaxProcessorUniV2 —— feeConfigV3() 给出完整分配（各收款方 bps）
const FLAP_SEL = {
  getPoolStateData: '0x65761b95',
  taxRate: '0x771a3a1d',
  taxProcessor: '0xf3635019',
  mainPool: '0xa5a302d3',
  dividendContract: '0x6124e4e7',
  quoteToken: '0x217a4b70',
  feeConfigV3: '0x46e62d07',
  symbol: '0x95d89b41',
  totalSupply: '0x18160ddd',
  decimals: '0x313ce567',
};
const FLAP_RPCS = [
  'https://bsc-dataseed.bnbchain.org',
  'https://bsc-dataseed1.defibit.io',
  'https://bsc-dataseed1.ninicoin.io',
];

// 各链公共 RPC（端点逐个实测过能读 totalSupply/decimals）。
// 供应量只用于算 fomo 持仓占比，读失败就不显示占比，不影响其它。
const SUPPLY_RPCS = {
  bsc: [...FLAP_RPCS, 'https://bsc-rpc.publicnode.com'],
  eth: ['https://ethereum-rpc.publicnode.com'],
  base: ['https://mainnet.base.org', 'https://base-rpc.publicnode.com'],
};
const FLAP_TTL = 60000;
const FLAP_CACHE_MAX = 400;
const FLAP_SYMBOL_CACHE_MAX = 600;
const flapCache = new Map();

/** 定长返回值按 32 字节切词——这些方法没有动态类型，直接按序读即可。 */
function flapWords(hex) {
  const body = String(hex || '').replace(/^0x/, '');
  const out = [];
  for (let i = 0; i + 64 <= body.length; i += 64) out.push(body.slice(i, i + 64));
  return out;
}
const flapNum = (word) => (word ? Number(BigInt('0x' + word)) : 0);

/** symbol() 返回动态 string：偏移 + 长度 + 数据。 */
function flapString(hex) {
  const w = flapWords(hex);
  if (w.length < 3) return '';
  const len = Number(BigInt('0x' + w[1]));
  if (!len || len > 64) return '';
  const bytes = w.slice(2).join('').slice(0, len * 2);
  let out = '';
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    const code = parseInt(bytes.slice(i, i + 2), 16);
    if (code) out += String.fromCharCode(code);
  }
  return out.trim();
}

// 代币符号基本不变，单独长缓存，多个币共用同一分红资产时只读一次
const flapSymbolCache = new Map();
const flapBig = (word) => (word ? BigInt('0x' + word).toString() : '0');
const flapAddr = (word) => (word ? '0x' + word.slice(24) : '');

async function flapRpc(rpc, calls) {
  const res = await fetch(rpc, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(calls.map((c, i) => ({
      jsonrpc: '2.0', id: i + 1, method: 'eth_call',
      params: [{ to: c.to, data: c.data }, 'latest'],
    }))),
  });
  if (!res.ok) throw new Error(`http-${res.status}`);
  const body = await res.json();
  const list = Array.isArray(body) ? body : [body];
  const byId = new Map(list.map((x) => [x.id, x]));
  return calls.map((_, i) => {
    const hit = byId.get(i + 1);
    if (!hit || hit.error) throw new Error(hit?.error?.message || 'rpc-error');
    return hit.result;
  });
}

// ---- 代币的全部底池 ----
// GMGN 自己的 token_pool_fee_info 只返回主池（实测 list 就一条），DexScreener 有全部，
// 但它在大陆裸网连不上，所以走 985monitor 代取（那个域名本来就在权限里，服务器直通且带缓存）。
const POOLS_URL = 'https://www.985monitor.xyz/api/extension/token-pools';
const POOLS_TTL = 60000;
const POOLS_MIN_GAP = 1500;          // 最小请求间隔，别把自己的服务器打爆
const poolsCache = new Map();
const poolsInflight = new Map();
let poolsLastAt = 0;
let poolsBackoffUntil = 0;

// DexScreener 的链名和 GMGN 的路径段不一样（实测：sol→solana、eth→ethereum，其余同名）
const DS_CHAIN = { bsc: 'bsc', sol: 'solana', eth: 'ethereum', base: 'base', robinhood: 'robinhood' };
const DS_FAIL_COOLDOWN = 10 * 60000;
let dsDirectFailedAt = 0;

/** 直连 DexScreener。失败（多半是没代理连不上）返回 null，交给 985 代取兜底。 */
async function dexScreenerDirect(chain, address) {
  const dsChain = DS_CHAIN[chain];
  if (!dsChain) return null;
  // 连不上就冷却十分钟，别每个币都白等一次超时
  if (Date.now() - dsDirectFailedAt < DS_FAIL_COOLDOWN) return null;
  const lower = String(address).toLowerCase();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(address)}`,
      { cache: 'no-store', signal: controller.signal }).finally(() => clearTimeout(timer));
    if (!res.ok) throw new Error(`http-${res.status}`);
    const body = await res.json();
    const rows = [];
    for (const p of (Array.isArray(body?.pairs) ? body.pairs : [])) {
      if (String(p?.chainId || '') !== dsChain) continue;
      // 同名币很多，必须按地址卡；且这个币可能在任一侧
      const isBase = String(p?.baseToken?.address || '').toLowerCase() === lower;
      if (!isBase && String(p?.quoteToken?.address || '').toLowerCase() !== lower) continue;
      const other = isBase ? p.quoteToken : p.baseToken;
      rows.push({
        pair: String(p.pairAddress || '').slice(0, 80),
        quote: String(other?.symbol || '').slice(0, 16),
        dex: [String(p.dexId || '')].concat(Array.isArray(p.labels) ? p.labels : []).filter(Boolean).join(' ').slice(0, 24),
        liq: Number(p?.liquidity?.usd) || 0,
        vol24h: Number(p?.volume?.h24) || 0,
        url: String(p.url || '').slice(0, 200),
      });
    }
    rows.sort((a, b) => b.liq - a.liq);
    const pools = rows.slice(0, 30);
    dsDirectFailedAt = 0;
    return { ok: true, via: 'direct', pools, total: pools.length, totalLiq: pools.reduce((sum, r) => sum + r.liq, 0) };
  } catch {
    dsDirectFailedAt = Date.now();
    return null;
  }
}

async function tokenPools({ chain, address }) {
  const key = `${chain}|${String(address || '').toLowerCase()}`;
  const hit = poolsCache.get(key);
  if (hit && Date.now() - hit.at < POOLS_TTL) return hit.data;
  const running = poolsInflight.get(key);
  if (running) return running;
  if (Date.now() < poolsBackoffUntil) return hit?.data || { ok: false, reason: 'backoff' };
  const job = (async () => {
    const wait = POOLS_MIN_GAP - (Date.now() - poolsLastAt);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    poolsLastAt = Date.now();
    // 先用用户自己的网络直连 DexScreener（它的 CORS 是 *，不用申请新权限）。
    // 通了就走本地，一点不碰服务器；大陆裸网连不上时才降级到 985 代取。
    const direct = await dexScreenerDirect(chain, address);
    if (direct) {
      poolsBackoffUntil = 0;
      poolsCache.set(key, { at: Date.now(), data: direct });
      if (poolsCache.size > 200) for (const k of [...poolsCache.keys()].slice(0, 80)) poolsCache.delete(k);
      return direct;
    }
    try {
      const res = await fetch(`${POOLS_URL}?chain=${encodeURIComponent(chain)}&address=${encodeURIComponent(address)}`, { cache: 'no-store' });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.ok) {
        // 429/5xx 一律退避，别继续硬打
        poolsBackoffUntil = Date.now() + (res.status === 429 ? 60000 : 20000);
        return { ok: false, reason: `http-${res.status}` };
      }
      poolsBackoffUntil = 0;
      const data = { ok: true, via: 'proxy', pools: body.pools || [], total: Number(body.total) || 0, totalLiq: Number(body.totalLiq) || 0 };
      poolsCache.set(key, { at: Date.now(), data });
      if (poolsCache.size > 200) for (const k of [...poolsCache.keys()].slice(0, 80)) poolsCache.delete(k);
      return data;
    } catch (error) {
      poolsBackoffUntil = Date.now() + 20000;
      return { ok: false, reason: 'network', message: String(error?.message || '').slice(0, 80) };
    }
  })().finally(() => poolsInflight.delete(key));
  poolsInflight.set(key, job);
  return job;
}

async function flapTokenInfo({ token, rpc }) {
  const address = String(token || '').toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(address)) return { ok: false, reason: 'bad-token' };
  const hit = flapCache.get(address);
  if (hit && Date.now() - hit.at < FLAP_TTL) return hit.data;

  const endpoints = [rpc, ...FLAP_RPCS].filter(Boolean);
  let lastError = '';
  for (const endpoint of endpoints) {
    try {
      const first = await flapRpc(endpoint, [
        { to: address, data: FLAP_SEL.getPoolStateData },
        { to: address, data: FLAP_SEL.taxRate },
        { to: address, data: FLAP_SEL.taxProcessor },
        { to: address, data: FLAP_SEL.mainPool },
        { to: address, data: FLAP_SEL.dividendContract },
        { to: address, data: FLAP_SEL.quoteToken },
      ]);
      const pool = flapWords(first[0]);
      if (!pool.length) throw new Error('not-flap');
      const processor = flapAddr(flapWords(first[2])[0]);

      let dist = null;
      if (/^0x[a-f0-9]{40}$/i.test(processor) && !/^0x0{40}$/i.test(processor)) {
        try {
          const [cfg] = await flapRpc(endpoint, [{ to: processor, data: FLAP_SEL.feeConfigV3 }]);
          const w = flapWords(cfg);
          if (w.length >= 15) {
            dist = {
              vault: [0, 1, 2, 3].map((i) => ({
                bps: flapNum(w[i]), address: flapAddr(w[11 + i]),
              })).filter((x) => x.bps > 0 || (x.address && !/^0x0{40}$/.test(x.address))),
              deflationBps: flapNum(w[4]),
              lpBps: flapNum(w[5]),
              dividendBps: flapNum(w[6]),
              feeRateBps: flapNum(w[7]),
              commissionBps: flapNum(w[9]),
              dividendToken: flapAddr(w[10]),
            };
          }
        } catch {
          // 分配读不到不影响主信息
        }
      }

      // 把徽章要显示的币名一次性收齐：代币自身、底池对手币（计价币）、分红资产。
      // 符号基本不变且多个币常共用同一分红资产，按地址长缓存，命中就不再请求。
      const quoteAddr = flapAddr(flapWords(first[5])[0]);
      const divToken = dist?.dividendToken || '';
      const wanted = [address, quoteAddr, divToken]
        .filter((a) => a && !/^0x0{40}$/i.test(a));
      const missing = [...new Set(wanted)].filter((a) => !flapSymbolCache.has(a));
      if (missing.length) {
        try {
          const syms = await flapRpc(endpoint, missing.map((a) => ({ to: a, data: FLAP_SEL.symbol })));
          missing.forEach((a, i) => setBoundedMap(flapSymbolCache, a, flapString(syms[i]), FLAP_SYMBOL_CACHE_MAX));
        } catch {
          // 拿不到符号就只显示比例与地址，不影响主信息
        }
      }
      const symbolOf = (a) => (a && flapSymbolCache.get(a)) || '';
      const dividendSymbol = symbolOf(divToken);

      const data = {
        ok: true,
        token: address,
        dividendSymbol,
        tokenSymbol: symbolOf(address),
        quoteSymbol: symbolOf(quoteAddr),
        state: flapNum(pool[0]),
        buyTaxBps: flapNum(pool[1]),
        sellTaxBps: flapNum(pool[2]),
        taxBps: flapNum(flapWords(first[1])[0]),
        liqThreshold: flapBig(pool[3]),
        taxExpiry: flapNum(pool[4]),
        processor,
        mainPool: flapAddr(flapWords(first[3])[0]),
        dividendContract: flapAddr(flapWords(first[4])[0]),
        quoteToken: flapAddr(flapWords(first[5])[0]),
        dist,
        rpc: endpoint,
      };
      setBoundedMap(flapCache, address, { at: Date.now(), data }, FLAP_CACHE_MAX);
      return data;
    } catch (error) {
      lastError = String(error?.message || error).slice(0, 80);
      // 合约根本没有这些方法时 eth_call 会 revert —— 这说明它不是 Flap 代币，
      // 换几个 RPC 结果都一样，不该当成节点故障去重试
      if (lastError === 'not-flap' || /revert|invalid opcode|execution error/i.test(lastError)) {
        lastError = 'not-flap';
        break;
      }
    }
  }
  const data = { ok: false, reason: lastError === 'not-flap' ? 'not-flap' : 'rpc-failed', message: lastError };
  setBoundedMap(flapCache, address, { at: Date.now(), data }, FLAP_CACHE_MAX);
  return data;
}

// 代币总供应量（人类可读口径，和 fomo 的 humanAmount 对齐），用于算 fomo 持仓占比。
// 供应量基本不变，长缓存；只支持 EVM 链（沿用 Flap 那条 RPC 通道）。
const supplyCache = new Map();
const SUPPLY_CACHE_MAX = 500;

// GMGN 自己的代币信息接口:所有链通用(sol/robinhood/evm 都返回 total_supply,
// 已是人类可读单位、不用再按 decimals 换算)。实测 Solana CATE 9.64 亿、
// Robinhood HOOD10 10 亿。参数与登录态对齐页面自身请求,否则被 Cloudflare 挡。
async function gmgnTokenSupply(chain, address, apiQuery) {
  if (!apiQuery) return 0;
  try {
    const res = await fetch(`https://gmgn.ai/api/v1/mutil_window_token_info?${apiQuery}`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chain, addresses: [address] }),
    });
    if (!res.ok) return 0;
    const body = await res.json().catch(() => null);
    const item = body?.data?.[0];
    const raw = item?.total_supply ?? item?.max_supply ?? item?.circulating_supply;
    const supply = Number(raw);
    return Number.isFinite(supply) && supply > 0 ? supply : 0;
  } catch {
    return 0;
  }
}

async function tokenSupply({ chain, address, rpc, apiQuery }) {
  // 前缀也放宽大小写：校验和地址本身就是混合大小写，没必要在这里卡人
  const chainKey = String(chain || '').toLowerCase();
  const chainRpcs = SUPPLY_RPCS[chainKey];
  // 地址格式:EVM 是 0x40 位,Solana 是 base58 32~44 位
  const looksEvm = /^0x[a-fA-F0-9]{40}$/i.test(address || '');
  const looksSol = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address || '');
  if (!chainKey || (!looksEvm && !looksSol)) {
    return { ok: false, reason: 'unsupported-chain' };
  }
  // 缓存按链隔离：不同链上可能有同名地址
  const normalizedAddress = looksEvm ? String(address).toLowerCase() : String(address);
  const key = `${chainKey}:${normalizedAddress}`;
  if (supplyCache.has(key)) return { ok: true, supply: supplyCache.get(key) };

  // 先问 GMGN 接口：所有链通用（Solana / Robinhood 只有这条路走得通）
  const viaGmgn = await gmgnTokenSupply(chain, address, apiQuery);
  if (viaGmgn > 0) {
    setBoundedMap(supplyCache, key, viaGmgn, SUPPLY_CACHE_MAX);
    return { ok: true, supply: viaGmgn };
  }

  // 兜底：EVM 链直读链上（GMGN 接口挂了/没带上页面参数时仍能出数）
  if (!chainRpcs || !looksEvm) return { ok: false, reason: 'unsupported-chain' };
  // flapRpc 只打单个节点，节点回退在调用方——这里同样要逐个试，
  // 否则一个节点抽风整项就没了。用户自定义 RPC 只对 BSC 生效。
  const endpoints = [chain === 'bsc' ? rpc : '', ...chainRpcs].filter(Boolean);
  let lastError = '';
  for (const endpoint of endpoints) {
    try {
      const [rawSupply, rawDec] = await flapRpc(endpoint, [
        { to: address, data: FLAP_SEL.totalSupply },
        { to: address, data: FLAP_SEL.decimals },
      ]);
      const raw = BigInt(rawSupply || '0x0');
      const dec = Number(BigInt(rawDec || '0x12'));
      if (!raw || !Number.isFinite(dec) || dec > 36) return { ok: false, reason: 'bad-data' };
      const supply = Number(raw) / Math.pow(10, dec);
      if (!Number.isFinite(supply) || supply <= 0) return { ok: false, reason: 'bad-data' };
      setBoundedMap(supplyCache, key, supply, SUPPLY_CACHE_MAX);
      return { ok: true, supply };
    } catch (error) {
      lastError = String(error?.message || '').slice(0, 80);
    }
  }
  return { ok: false, reason: 'rpc', message: lastError };
}


// ---- 985monitor 账号会话 / FOMO + Pump 事件源 ----
// 扩展只保存服务端签发的只读会话。网页钱包主令牌不会进入 chrome.storage，
// 也不会被后台拿来调用其它 985monitor 接口。
const MONITOR985_ORIGIN = 'https://www.985monitor.xyz';
const MONITOR985_CONFIG_URL = `${MONITOR985_ORIGIN}/api/extension/config`;
const FOMO_FEED_URL = `${MONITOR985_ORIGIN}/api/extension/fomo-events?limit=150`;
const PUMP_FEED_URL = `${MONITOR985_ORIGIN}/api/extension/pump-trade-events?limit=150`;
const MONITOR985_CONFIG_TTL_MS = 3 * 60 * 1000;
let monitor985ConfigInflight = null;

async function monitor985Session() {
  const stored = await chrome.storage.local.get({ monitor985SessionV1: null });
  const session = stored.monitor985SessionV1;
  if (!session?.token || Number(session.expiresAt) <= Date.now()) return null;
  return session;
}

function monitor985AuthHeaders(session, extra = {}) {
  return { ...extra, Authorization: `Bearer ${session.token}` };
}

function resetMonitor985EventCaches() {
  fomoFeedCache = { events: [], updatedAt: 0, fetchedAt: 0 };
  fomoFeedEtag = '';
  pumpFeedCache = { events: [], updatedAt: 0, fetchedAt: 0 };
  pumpDefaultWatchCache = { wallets: [], fetchedAt: 0 };
}

async function markMonitor985Disconnected(reason, clearSession = false) {
  resetMonitor985EventCaches();
  const patch = {
    monitorFomoConfig: { connected: false, at: Date.now() },
    monitorPumpConfig: { connected: false, at: Date.now() },
    monitor985SyncStateV1: { connected: false, reason, checkedAt: Date.now() },
  };
  if (clearSession) patch.monitor985SessionV1 = null;
  await chrome.storage.local.set(patch);
}

async function applyMonitor985Config(config, session) {
  if (!config?.connected || !config?.account?.userId) return false;
  const stored = await chrome.storage.local.get({ monitor985SyncStateV1: null });
  const previousAccount = String(stored.monitor985SyncStateV1?.accountId || '');
  if (previousAccount && previousAccount !== String(config.account.userId)) resetMonitor985EventCaches();
  const at = Date.now();
  await chrome.storage.local.set({
    monitorFomoConfig: { ...(config.fomo || {}), wallet: config.account.userId, connected: true, revision: config.revision, at },
    monitorPumpConfig: { ...(config.pump || {}), wallet: config.account.userId, connected: true, revision: config.revision, at },
    monitor985SyncStateV1: {
      connected: true,
      accountId: config.account.userId,
      displayName: String(config.account.displayName || ''),
      syncedAt: at,
      expiresAt: Number(session?.expiresAt || config.sessionExpiresAt) || 0,
    },
  });
  return true;
}

async function refreshMonitor985Config(force = false) {
  if (monitor985ConfigInflight) return monitor985ConfigInflight;
  monitor985ConfigInflight = (async () => {
    const stored = await chrome.storage.local.get({ monitor985SessionV1: null, monitor985SyncStateV1: null });
    const session = stored.monitor985SessionV1;
    if (!session?.token || Number(session.expiresAt) <= Date.now()) {
      await markMonitor985Disconnected('login-required', Boolean(session));
      return false;
    }
    if (!force && stored.monitor985SyncStateV1?.connected
      && Date.now() - Number(stored.monitor985SyncStateV1.syncedAt) < MONITOR985_CONFIG_TTL_MS) return true;
    try {
      const response = await fetch(MONITOR985_CONFIG_URL, {
        headers: monitor985AuthHeaders(session, { Accept: 'application/json' }),
        cache: 'no-store',
      });
      const body = await response.json().catch(() => null);
      if (response.status === 401) {
        await markMonitor985Disconnected('unauthorized', true);
        return false;
      }
      if (!response.ok || body?.ok !== true || !body?.config) throw new Error(`HTTP ${response.status}`);
      return applyMonitor985Config(body.config, session);
    } catch {
      // 网络短暂失败时保留上次已验证配置；轮询与闹钟会继续重试。
      return Boolean(stored.monitor985SyncStateV1?.connected);
    }
  })().finally(() => { monitor985ConfigInflight = null; });
  return monitor985ConfigInflight;
}

// 控频 + 失败指数退避；服务端已按账号过滤，前端仍做一次防御性过滤。
const FOMO_FEED_MIN_INTERVAL_MS = 15000;
const FOMO_FEED_KEEP = 150;
let fomoFeedCache = { events: [], updatedAt: 0, fetchedAt: 0 };
let fomoFeedEtag = '';
let fomoFeedFailCount = 0;
let fomoFeedBackoffUntil = 0;
let fomoFeedInflight = null;

const FOMO_FEED_TYPE = {
  FOMO_BUY: 'buy',
  FOMO_SELL: 'sell',
  FOMO_SWAP: 'swap',
  FOMO_THESIS: 'thesis',
  // 转入不是买入：链上腿只看得到代币进账那一条腿，空投 / 税收分红 / 别人打款
  // 形状和买入一模一样。采集端判出「不是交易」的，这边单独成一类，别混进买入。
  FOMO_TRANSFER_IN: 'transferIn',
  // Relay 回滚 / 交易执行失败也是用户刚发起的链上动作，不能因未知类型被静默丢掉。
  FOMO_REFUND: 'refund',
};

// fomo 的链名 → GMGN 的路径段
const FOMO_CHAIN_SLUG = { bnb: 'bsc', bsc: 'bsc', sol: 'sol', solana: 'sol', eth: 'eth', ethereum: 'eth', base: 'base', robinhood: 'robinhood', 'chain 143': 'monad' };
const FOMO_RANK_SNAPSHOT_KEY = 'fomoRankSnapshotV1';
const FOMO_RANK_BOARD_KEYS = new Set(['all', '30d', '7d', '24h']);
let fomoRankSnapshot = { updatedAt: 0, ranks: new Map() };
let fomoRankSnapshotLoaded = false;
let fomoRankSnapshotInflight = null;

function normalizeFomoRankSnapshot(raw) {
  const ranks = new Map();
  for (const row of (Array.isArray(raw?.ranks) ? raw.ranks : []).slice(0, 500)) {
    if (!Array.isArray(row)) continue;
    const handle = String(row[0] || '').trim().replace(/^@+/, '').toLowerCase();
    const board = String(row[1] || '');
    const rank = Math.trunc(Number(row[2]) || 0);
    if (/^[a-z0-9_.-]{1,40}$/.test(handle) && FOMO_RANK_BOARD_KEYS.has(board) && rank > 0) {
      ranks.set(handle, { board, rank });
    }
  }
  return { updatedAt: Math.max(0, Math.trunc(Number(raw?.updatedAt) || 0)), ranks };
}

const FOMO_TRENDING_CACHE_MS = 60 * 1000;
let fomoTrendingCache = null;
let fomoTrendingPending = null;

function compactFomoTrendingItems(value) {
  const chainByNetwork = new Map([
    [1, 'eth'], [56, 'bsc'], [143, 'monad'], [4663, 'robinhood'],
    [8453, 'base'], [1399811149, 'sol'],
  ]);
  const numeric = (input) => input !== null && input !== undefined && input !== ''
    && Number.isFinite(Number(input)) ? Number(input) : null;
  return (Array.isArray(value) ? value : []).slice(0, 50).map((item) => {
    const networkId = Number(item?.token?.networkId);
    const chain = chainByNetwork.get(networkId) || '';
    const address = String(item?.token?.address || '').trim();
    const evm = /^0x[a-fA-F0-9]{40}$/.test(address);
    const sol = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address);
    const image = String(item?.token?.info?.imageSmallUrl
      || item?.token?.info?.imageThumbUrl || '').trim();
    return {
      chain,
      networkId,
      address: evm ? address.toLowerCase() : address,
      symbol: String(item?.token?.symbol || '').replace(/[\r\n\t]/g, '').slice(0, 24),
      name: String(item?.token?.name || '').replace(/[\r\n\t]/g, ' ').slice(0, 80),
      image: /^https:\/\//i.test(image) ? image.slice(0, 500) : '',
      priceUsd: numeric(item?.priceUSD),
      marketCapUsd: numeric(item?.marketCap),
      change24Ratio: numeric(item?.change24),
      holders: numeric(item?.holders),
      liquidityUsd: numeric(item?.liquidity),
      volume24Usd: numeric(item?.volume24),
      createdAt: numeric(item?.createdAt),
      valid: Boolean(chain && ((networkId === 1399811149 && sol)
        || (networkId !== 1399811149 && evm))),
    };
  }).filter((item) => item.valid && item.symbol).map(({ valid, ...item }) => item);
}

async function fomoFetchTrending() {
  if (fomoTrendingCache && Date.now() - fomoTrendingCache.at < FOMO_TRENDING_CACHE_MS) {
    return fomoTrendingCache.data;
  }
  if (fomoTrendingPending) return fomoTrendingPending;
  fomoTrendingPending = (async () => {
    try {
      const { res, stored, renewed, unauthed } = await fomoAuthedFetch(
        '/proxy/trendingTokens',
        { method: 'POST' },
      );
      const token = stored?.token;
      if (!res.ok && unauthed && !token) {
        return { ok: false, reason: 'no-token', status: res.status, tokenAt: 0 };
      }
      if (!res.ok) {
        const rateLimited = res.status === 429;
        return {
          ok: false,
          reason: rateLimited ? 'rate-limited'
            : (unauthed ? (token ? 'expired' : 'no-token') : `http-${res.status}`),
          status: res.status,
          retryAfterMs: rateLimited ? Math.max(1000, fomoRateLimitUntil - Date.now()) : 0,
          tokenAt: stored?.at || 0,
          renewed,
        };
      }
      const body = await res.json().catch(() => null);
      const inner = Number(body?.statusCode);
      if (body?.success === false || (Number.isFinite(inner) && inner !== 200)) {
        const unauth = inner === 401 || inner === 403;
        return {
          ok: false,
          reason: unauth ? (token ? 'expired' : 'no-token') : `api-${inner || 'error'}`,
          status: inner || res.status,
          message: String(body?.message || '').slice(0, 120),
          tokenAt: stored?.at || 0,
          renewed,
        };
      }
      const items = compactFomoTrendingItems(body?.responseObject);
      const data = { ok: true, items, count: items.length, at: Date.now() };
      fomoTrendingCache = { at: Date.now(), data };
      return data;
    } catch (error) {
      return { ok: false, reason: 'network', message: String(error?.message || '').slice(0, 80) };
    } finally {
      fomoTrendingPending = null;
    }
  })();
  return fomoTrendingPending;
}

function fomoRankSnapshotForStorage(snapshot = fomoRankSnapshot) {
  return {
    updatedAt: snapshot.updatedAt,
    ranks: [...snapshot.ranks].map(([handle, mark]) => [handle, mark.board, mark.rank]),
  };
}

async function ensureFomoRankSnapshot() {
  if (fomoRankSnapshotLoaded) return fomoRankSnapshot;
  if (fomoRankSnapshotInflight) return fomoRankSnapshotInflight;
  fomoRankSnapshotInflight = chrome.storage.local.get({ [FOMO_RANK_SNAPSHOT_KEY]: null })
    .then((stored) => {
      fomoRankSnapshot = normalizeFomoRankSnapshot(stored[FOMO_RANK_SNAPSHOT_KEY]);
      fomoRankSnapshotLoaded = true;
      return fomoRankSnapshot;
    })
    .finally(() => { fomoRankSnapshotInflight = null; });
  return fomoRankSnapshotInflight;
}

function applyFomoRankSnapshotToEvent(event, snapshot = fomoRankSnapshot) {
  if (!event || typeof event !== 'object') return event;
  const handle = String(event.handle || '').trim().replace(/^@+/, '').toLowerCase();
  const mark = snapshot?.ranks?.get(handle);
  const { fomoRankBoard, fomoRank, fomoRankUpdatedAt, ...clean } = event;
  if (!mark) return clean;
  return { ...clean, fomoRankBoard: mark.board, fomoRank: mark.rank, fomoRankUpdatedAt: snapshot.updatedAt };
}

function slimFomoEvent(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const type = FOMO_FEED_TYPE[String(raw.eventType || '')];
  if (!type) return null;
  const ts = Number(raw.ts) || Date.parse(raw.createdAt || '') || 0;
  if (!ts) return null;
  const chainName = String(raw.chainName || '').trim();
  const content = raw.content && typeof raw.content === 'object' ? raw.content : {};
  return {
    key: String(raw.key || '').slice(0, 120),
    source: 'fomo',
    type,
    handle: String(raw.handle || '').toLowerCase().slice(0, 64),
    name: String(raw.userName || raw.handle || '').slice(0, 48),
    avatar: String(raw.avatar || '').slice(0, 300),
    usd: Number(raw.usd) || 0,
    comment: String(raw.comment || content.comment || content.text
      || (type === 'refund' ? `链上交易失败 · ${String(raw.failReason || '已退款')}` : '')).slice(0, 1500),
    addr: String(raw.tokenAddress || '').slice(0, 64),
    chain: FOMO_CHAIN_SLUG[chainName.toLowerCase()] || chainName.toLowerCase(),
    chainName,
    symbol: String(raw.symbol || '').slice(0, 24),
    img: String(raw.tokenImage || '').slice(0, 300),
    mc: Number(raw.marketCap) || 0,
    ts,
    tx: String(raw.txHash || raw.transactionHash || raw.transaction_hash
      || content.txHash || content.transactionHash || content.transaction_hash || '').trim().slice(0, 180),
  };
}

async function fetchFomoFeed() {
  if (fomoFeedInflight) return fomoFeedInflight;
  const session = await monitor985Session();
  if (!session) return { ok: false, reason: 'not-connected', events: [] };
  await ensureFomoRankSnapshot();
  await refreshMonitor985Config(false);
  const now = Date.now();
  if (now - fomoFeedCache.fetchedAt < FOMO_FEED_MIN_INTERVAL_MS || now < fomoFeedBackoffUntil) {
    return { ok: true, ...fomoFeedCache, stale: true };
  }
  fomoFeedInflight = (async () => {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 25000);
      const headers = monitor985AuthHeaders(session, fomoFeedEtag ? { 'If-None-Match': fomoFeedEtag } : {});
      let response;
      try {
        response = await fetch(FOMO_FEED_URL, { headers, cache: 'no-store', signal: controller.signal });
      } finally {
        clearTimeout(timer);
      }
      if (response.status === 304) {
        fomoFeedCache.fetchedAt = Date.now();
        fomoFeedFailCount = 0;
        return { ok: true, ...fomoFeedCache };
      }
      if (response.status === 401) {
        await markMonitor985Disconnected('unauthorized', true);
        return { ok: false, reason: 'not-connected', events: [] };
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json();
      const events = dedupeTrackingFeedEvents((Array.isArray(body?.events) ? body.events : [])
        .map(slimFomoEvent)
        .filter(Boolean)
        .map((event) => applyFomoRankSnapshotToEvent(event))
        .sort((a, b) => b.ts - a.ts))
        .slice(0, FOMO_FEED_KEEP);
      fomoFeedCache = { events, updatedAt: Number(body?.updatedAt) || Date.now(), fetchedAt: Date.now() };
      fomoFeedEtag = response.headers.get('ETag') || '';
      fomoFeedFailCount = 0;
      fomoFeedBackoffUntil = 0;
      return { ok: true, ...fomoFeedCache };
    } catch (error) {
      fomoFeedFailCount += 1;
      fomoFeedBackoffUntil = Date.now() + Math.min(15 * 60000, 60000 * Math.pow(2, fomoFeedFailCount - 1));
      if (fomoFeedCache.events.length) return { ok: true, ...fomoFeedCache, stale: true };
      return { ok: false, reason: 'fetch-failed', message: String(error?.message || '').slice(0, 120) };
    } finally {
      fomoFeedInflight = null;
    }
  })();
  return fomoFeedInflight;
}


// ---- 985monitor Pump 成交事件源 ----
// 专用接口在服务端先按登录账号过滤；插件侧保留同样条件作第二层防线。
const PUMP_FEED_MIN_INTERVAL_MS = 15000;
const PUMP_FEED_KEEP = 150;
let pumpFeedCache = { events: [], updatedAt: 0, fetchedAt: 0 };
let pumpFeedFailCount = 0;
let pumpFeedBackoffUntil = 0;
let pumpFeedInflight = null;
let pumpDefaultWatchCache = { wallets: [], fetchedAt: 0 };

function pumpFeedHttpsUrl(raw, allowLocalAvatar = false) {
  const value = String(raw || '').trim();
  if (allowLocalAvatar && value.startsWith('/pump-avatars/')) {
    return `https://www.985monitor.xyz${value}`.slice(0, 400);
  }
  return /^https:\/\//i.test(value) ? value.slice(0, 400) : '';
}

function pumpFeedChainSlug(trade) {
  const direct = String(trade?.chainSlug || trade?.chain || '').trim().toLowerCase();
  if (/^(sol|bsc|base|eth|robinhood|hyperevm)$/.test(direct)) return direct;
  const byName = {
    sol: 'sol', solana: 'sol', bnb: 'bsc', bsc: 'bsc', binance: 'bsc',
    base: 'base', eth: 'eth', ethereum: 'eth', robinhood: 'robinhood',
    hyperliquid: 'hyperevm', hyperevm: 'hyperevm',
  };
  const named = byName[String(trade?.chainName || '').trim().toLowerCase()];
  if (named) return named;
  return ({ 1: 'eth', 56: 'bsc', 8453: 'base', 1399811149: 'sol' })[Number(trade?.chainId)] || '';
}

function slimPumpEvent(raw) {
  if (!raw || String(raw.eventType || '').toUpperCase() !== 'PUMP_TRADE') return null;
  const trade = raw?.content?.pumpTrade;
  if (!trade || typeof trade !== 'object') return null;
  const type = String(trade.side || '').trim().toLowerCase();
  if (type !== 'buy' && type !== 'sell') return null;
  const ts = Date.parse(trade.tradeTime || raw.createdAt || '') || Number(raw.ts) || 0;
  const chain = pumpFeedChainSlug(trade);
  const addr = String(trade.mint || trade.tokenAddress || trade.contractAddress || '').trim();
  const wallet = String(trade.wallet || '').trim();
  const key = String(raw.key || (trade.tx ? `pump:trade:${trade.tx}` : '')).slice(0, 180);
  if (!key || !ts || !chain || !addr || !wallet) return null;
  return {
    key,
    source: 'pump',
    type,
    handle: String(trade.username || trade.watchName || trade.walletName || '').trim().toLowerCase().slice(0, 64),
    name: String(trade.watchName || trade.walletName || trade.username || wallet).slice(0, 48),
    avatar: pumpFeedHttpsUrl(trade.avatar, true),
    usd: Number(trade.amountUsd) || 0,
    comment: '',
    addr: addr.slice(0, 80),
    chain,
    chainName: String(trade.chainName || '').slice(0, 32),
    symbol: String(trade.symbol || '').slice(0, 24),
    img: pumpFeedHttpsUrl(trade.image),
    mc: Number(trade.marketCapUsd) || 0,
    ts,
    tx: String(trade.tx || '').trim().slice(0, 180),
    pumpWallet: wallet.slice(0, 48),
    profileUrl: `https://pump.fun/profile/${encodeURIComponent(wallet)}`,
  };
}

async function fetchPumpFeed() {
  if (pumpFeedInflight) return pumpFeedInflight;
  const session = await monitor985Session();
  if (!session) return { ok: false, reason: 'not-connected', events: [], defaultWallets: [] };
  await refreshMonitor985Config(false);
  const now = Date.now();
  if (now - pumpFeedCache.fetchedAt < PUMP_FEED_MIN_INTERVAL_MS || now < pumpFeedBackoffUntil) {
    return { ok: true, ...pumpFeedCache, defaultWallets: [], stale: true };
  }
  pumpFeedInflight = (async () => {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 25000);
      let response;
      try {
        response = await fetch(PUMP_FEED_URL, {
          headers: monitor985AuthHeaders(session),
          cache: 'no-store',
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      if (response.status === 401) {
        await markMonitor985Disconnected('unauthorized', true);
        return { ok: false, reason: 'not-connected', events: [], defaultWallets: [] };
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json();
      const events = dedupeTrackingFeedEvents((Array.isArray(body?.events) ? body.events : [])
        .map(slimPumpEvent)
        .filter(Boolean)
        .sort((a, b) => b.ts - a.ts))
        .slice(0, PUMP_FEED_KEEP);
      pumpFeedCache = { events, updatedAt: Number(body?.updatedAt) || Date.now(), fetchedAt: Date.now() };
      pumpFeedFailCount = 0;
      pumpFeedBackoffUntil = 0;
      return { ok: true, ...pumpFeedCache, defaultWallets: [] };
    } catch (error) {
      pumpFeedFailCount += 1;
      pumpFeedBackoffUntil = Date.now() + Math.min(15 * 60000, 60000 * Math.pow(2, pumpFeedFailCount - 1));
      if (pumpFeedCache.events.length) {
        return { ok: true, ...pumpFeedCache, defaultWallets: [], stale: true };
      }
      return { ok: false, reason: 'fetch-failed', message: String(error?.message || '').slice(0, 120) };
    } finally {
      pumpFeedInflight = null;
    }
  })();
  return pumpFeedInflight;
}


// ---- 985monitor SSE 实时订阅（fomo / Pump 事件秒级到达）----
// MV3 service worker 没有 EventSource，用 fetch 流手工解析。收到事件直接
// 更新对应缓存并通知 GMGN / DeBot 标签页；标签页照旧用消息拿缓存（命中
// 控频间隔内的 stale 分支，零额外 HTTP）。SW 被挂起时连接自然断，content 侧
// 18 秒轮询一到就会唤醒 SW 触发重连——轮询同时也是 SSE 断档期的兜底。
const FOMO_SSE_URL = `${MONITOR985_ORIGIN}/api/extension/events-stream`;
let fomoSseAbort = null;
let fomoSseBackoff = 5000;
let fomoSseReconnectTimer = 0;
let fomoSseGeneration = 0;
let monitor985LastEventId = '';

function restartFomoSse() {
  fomoSseGeneration += 1;
  if (fomoSseReconnectTimer) clearTimeout(fomoSseReconnectTimer);
  fomoSseReconnectTimer = 0;
  try { fomoSseAbort?.abort(); } catch {}
  fomoSseAbort = null;
  setTimeout(connectFomoSse, 0);
}

function trackingFeedComparableId(ev) {
  const tx = String(ev?.tx || '').trim();
  if (tx) return `tx:${tx.startsWith('0x') ? tx.toLowerCase() : tx}`;
  const key = String(ev?.key || '').trim();
  return key ? `key:${key}` : '';
}

const TRACKING_FEED_BURST_MS = 20000;

function trackingFeedNormalizedAddress(raw) {
  const value = String(raw || '').trim();
  return /^0x[a-fA-F0-9]+$/.test(value) ? value.toLowerCase() : value;
}

function trackingFeedBurstDuplicate(a, b) {
  const type = String(a?.type || '').trim().toLowerCase();
  if (type !== 'buy' && type !== 'sell') return false;
  if (type !== String(b?.type || '').trim().toLowerCase()) return false;
  if (String(a?.source || 'fomo') !== String(b?.source || 'fomo')) return false;
  const address = trackingFeedNormalizedAddress(a?.addr);
  if (!address || address !== trackingFeedNormalizedAddress(b?.addr)) return false;
  const chainA = String(a?.chain || '').trim().toLowerCase();
  const chainB = String(b?.chain || '').trim().toLowerCase();
  if (chainA && chainB && chainA !== chainB) return false;
  const principalA = trackingFeedNormalizedAddress(a?.pumpWallet || a?.handle);
  const principalB = trackingFeedNormalizedAddress(b?.pumpWallet || b?.handle);
  if (!principalA || principalA !== principalB) return false;
  const tsA = Number(a?.ts) || 0;
  const tsB = Number(b?.ts) || 0;
  if (!tsA || !tsB || Math.abs(tsA - tsB) > TRACKING_FEED_BURST_MS) return false;
  const usdA = Number(a?.usd) || 0;
  const usdB = Number(b?.usd) || 0;
  if (!(usdA > 0) || !(usdB > 0)) return false;
  return Math.abs(usdA - usdB) <= Math.max(2, Math.max(usdA, usdB) * 0.05);
}

function trackingFeedDuplicate(a, b) {
  if (a?.key && a.key === b?.key) return true;
  const comparableId = trackingFeedComparableId(a);
  if (comparableId && comparableId === trackingFeedComparableId(b)) return true;
  return trackingFeedBurstDuplicate(a, b);
}

function dedupeTrackingFeedEvents(events) {
  const out = [];
  for (const event of events) {
    if (!out.some((existing) => trackingFeedDuplicate(event, existing))) out.push(event);
  }
  return out;
}

function fomoSseNotifyTabs() {
  try {
    chrome.tabs.query({ url: ['https://gmgn.ai/*', 'https://debot.ai/*'] }, (tabs) => {
      if (chrome.runtime.lastError || !Array.isArray(tabs)) return;
      for (const tab of tabs) {
        chrome.tabs.sendMessage(tab.id, { type: 'gdh-fomo-push' }, () => void chrome.runtime.lastError);
      }
    });
  } catch {
    // tabs 不可用
  }
}

function fomoRankSseNotifyTabs(snapshot) {
  const ranks = fomoRankSnapshotForStorage(snapshot).ranks;
  try {
    chrome.tabs.query({ url: ['https://gmgn.ai/*'] }, (tabs) => {
      if (chrome.runtime.lastError || !Array.isArray(tabs)) return;
      for (const tab of tabs) {
        chrome.tabs.sendMessage(tab.id, { type: 'gdh-fomo-ranks', ranks }, () => void chrome.runtime.lastError);
      }
    });
  } catch {
    // tabs 不可用
  }
}

function fomoSseIngestRanks(raw) {
  const next = normalizeFomoRankSnapshot(raw);
  if (!next.updatedAt || !next.ranks.size) return;
  if (next.updatedAt === fomoRankSnapshot.updatedAt && next.ranks.size === fomoRankSnapshot.ranks.size) return;
  fomoRankSnapshot = next;
  fomoRankSnapshotLoaded = true;
  fomoFeedCache = {
    ...fomoFeedCache,
    events: fomoFeedCache.events.map((event) => applyFomoRankSnapshotToEvent(event, next)),
  };
  void chrome.storage.local.set({ [FOMO_RANK_SNAPSHOT_KEY]: fomoRankSnapshotForStorage(next) });
  fomoRankSseNotifyTabs(next);
}

function fomoSseIngest(raw) {
  const ev = applyFomoRankSnapshotToEvent(slimFomoEvent(raw));
  if (!ev) return;
  const duplicate = fomoFeedCache.events.some((item) => trackingFeedDuplicate(ev, item));
  const rest = fomoFeedCache.events.filter((item) => !trackingFeedDuplicate(ev, item));
  rest.unshift(ev);
  rest.sort((a, b) => b.ts - a.ts);
  fomoFeedCache = { ...fomoFeedCache, events: rest.slice(0, FOMO_FEED_KEEP), updatedAt: Date.now() };
  if (!duplicate) fomoSseNotifyTabs();
}

function pumpSseNotifyTabs() {
  try {
    chrome.tabs.query({ url: ['https://gmgn.ai/*', 'https://debot.ai/*'] }, (tabs) => {
      if (chrome.runtime.lastError || !Array.isArray(tabs)) return;
      for (const tab of tabs) {
        chrome.tabs.sendMessage(tab.id, { type: 'gdh-pump-push' }, () => void chrome.runtime.lastError);
      }
    });
  } catch {
    // tabs 不可用
  }
}

function pumpSseIngest(raw) {
  const ev = slimPumpEvent(raw);
  if (!ev) return;
  const duplicate = pumpFeedCache.events.some((item) => trackingFeedDuplicate(ev, item));
  const rest = pumpFeedCache.events.filter((item) => !trackingFeedDuplicate(ev, item));
  rest.unshift(ev);
  rest.sort((a, b) => b.ts - a.ts);
  pumpFeedCache = { ...pumpFeedCache, events: rest.slice(0, PUMP_FEED_KEEP), updatedAt: Date.now() };
  if (!duplicate) pumpSseNotifyTabs();
}

async function connectFomoSse() {
  if (fomoSseAbort) return;
  const session = await monitor985Session();
  if (!session || fomoSseAbort) return;
  await refreshMonitor985Config(false);
  await ensureFomoRankSnapshot();
  const generation = fomoSseGeneration;
  const controller = new AbortController();
  fomoSseAbort = controller;
  try {
    const sseUrl = new URL(FOMO_SSE_URL);
    if (fomoRankSnapshot.updatedAt) sseUrl.searchParams.set('fomoRankUpdatedAt', String(fomoRankSnapshot.updatedAt));
    const response = await fetch(sseUrl.href, {
      headers: monitor985AuthHeaders(session, {
        Accept: 'text/event-stream',
        ...(monitor985LastEventId ? { 'Last-Event-ID': monitor985LastEventId } : {}),
      }),
      cache: 'no-store',
      signal: controller.signal,
    });
    if (response.status === 401) {
      await markMonitor985Disconnected('unauthorized', true);
      return;
    }
    if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
    fomoSseBackoff = 5000;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let eventType = '';
    let eventId = '';
    let dataLines = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).replace(/\r$/, '');
        buffer = buffer.slice(idx + 1);
        if (line === '') {
          if ((eventType === 'fomo' || eventType === 'pump-trade' || eventType === 'fomo-ranks') && dataLines.length) {
            try {
              const payload = JSON.parse(dataLines.join('\n'));
              if (payload?.event && eventType === 'fomo') fomoSseIngest(payload.event);
              if (payload?.event && eventType === 'pump-trade') pumpSseIngest(payload.event);
              if (payload?.event && eventType === 'fomo-ranks') fomoSseIngestRanks(payload.event);
            } catch {
              // 单帧坏数据不断流
            }
          }
          if (eventId) monitor985LastEventId = eventId;
          eventType = '';
          eventId = '';
          dataLines = [];
          continue;
        }
        if (line.startsWith('id:')) eventId = line.slice(3).trim();
        else if (line.startsWith('event:')) eventType = line.slice(6).trim();
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
      }
    }
  } catch {
    // 断线/超时/SW 即将挂起，都走重连
  } finally {
    if (fomoSseAbort === controller) fomoSseAbort = null;
  }
  if (generation !== fomoSseGeneration || !(await monitor985Session())) return;
  // 指数退避重连（上限 2 分钟）；SW 若被挂起，这个定时器作废，
  // 由下一次 'fomo-feed' 消息唤醒时重连
  fomoSseReconnectTimer = setTimeout(() => {
    fomoSseReconnectTimer = 0;
    connectFomoSse();
  }, fomoSseBackoff);
  fomoSseBackoff = Math.min(120000, fomoSseBackoff * 2);
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local' || !changes.monitor985SessionV1) return;
  resetMonitor985EventCaches();
  monitor985LastEventId = '';
  fomoSseBackoff = 5000;
  restartFomoSse();
});


// ---- 标注人物完整持仓（985monitor 服务器发布，GMGN 官方 API 采集）----
// 服务器每 3 分钟翻页拉全名单完整持仓；插件只读这份共享产物，
// 不再各自打 GMGN 的接口（旧的前 50 条上限也随之消失）。
const MARKED_FEED_URL = 'https://www.985monitor.xyz/marked-holdings.json';
const MARKED_FEED_MIN_INTERVAL_MS = 120000;
let markedFeedCache = { doc: null, fetchedAt: 0 };
let markedFeedEtag = '';
let markedFeedFailCount = 0;
let markedFeedBackoffUntil = 0;
let markedFeedInflight = null;

async function fetchMarkedFeed() {
  if (markedFeedInflight) return markedFeedInflight;
  const now = Date.now();
  if ((now - markedFeedCache.fetchedAt < MARKED_FEED_MIN_INTERVAL_MS || now < markedFeedBackoffUntil)) {
    return markedFeedCache.doc ? { ok: true, ...markedFeedCache.doc, stale: true } : { ok: false, reason: 'not-ready' };
  }
  markedFeedInflight = (async () => {
    try {
      const headers = markedFeedEtag ? { 'If-None-Match': markedFeedEtag } : {};
      const response = await fetch(MARKED_FEED_URL, { headers, cache: 'no-store' });
      if (response.status === 304) {
        markedFeedCache.fetchedAt = Date.now();
        markedFeedFailCount = 0;
        return { ok: true, ...markedFeedCache.doc };
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const doc = await response.json();
      if (!doc || !Array.isArray(doc.holdings)) throw new Error('bad-body');
      markedFeedCache = { doc, fetchedAt: Date.now() };
      markedFeedEtag = response.headers.get('ETag') || '';
      markedFeedFailCount = 0;
      markedFeedBackoffUntil = 0;
      return { ok: true, ...doc };
    } catch (error) {
      markedFeedFailCount += 1;
      markedFeedBackoffUntil = Date.now() + Math.min(15 * 60000, 60000 * Math.pow(2, markedFeedFailCount - 1));
      if (markedFeedCache.doc) return { ok: true, ...markedFeedCache.doc, stale: true };
      return { ok: false, reason: 'fetch-failed', message: String(error?.message || '').slice(0, 120) };
    } finally {
      markedFeedInflight = null;
    }
  })();
  return markedFeedInflight;
}

// ---- 持仓提醒清单的跨标签页串行写入 ----
const HOLDING_WATCH_PER_CHAIN_MAX = 100;
let holdingWatchWriteQueue = Promise.resolve();

function normalizeHoldingWatchItem(raw, forcedChain = '') {
  const chain = String(forcedChain || raw?.chain || '').trim().toLowerCase();
  const sourceAddress = String(raw?.address || '').trim();
  const evm = /^0x[a-fA-F0-9]{40}$/.test(sourceAddress);
  const sol = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(sourceAddress);
  if (!/^[a-z0-9]{2,16}$/.test(chain) || (!evm && !sol)) return null;
  const address = evm ? sourceAddress.toLowerCase() : sourceAddress;
  const cost = Number(raw?.cost);
  return {
    chain,
    address,
    symbol: String(raw?.symbol || '').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 24),
    cost: Number.isFinite(cost) && cost > 0 ? cost : 0,
    at: Number(raw?.at) > 0 ? Number(raw.at) : Date.now(),
  };
}

function mergeHoldingWatchList(current, chain, incoming, replace) {
  const normalizedChain = String(chain || '').trim().toLowerCase();
  if (!/^[a-z0-9]{2,16}$/.test(normalizedChain)) return Array.isArray(current) ? current : [];
  const map = new Map();
  for (const raw of (Array.isArray(current) ? current : [])) {
    const item = normalizeHoldingWatchItem(raw);
    if (!item || (replace && item.chain === normalizedChain)) continue;
    map.set(`${item.chain}:${item.address}`, item);
  }
  for (const raw of (Array.isArray(incoming) ? incoming : [])) {
    const item = normalizeHoldingWatchItem(raw, normalizedChain);
    if (!item) continue;
    map.set(`${item.chain}:${item.address}`, item);
  }
  const counts = new Map();
  return [...map.values()]
    .sort((a, b) => b.at - a.at)
    .filter((item) => {
      const count = counts.get(item.chain) || 0;
      if (count >= HOLDING_WATCH_PER_CHAIN_MAX) return false;
      counts.set(item.chain, count + 1);
      return true;
    });
}

function updateHoldingWatchList(payload) {
  const chain = String(payload?.chain || '').trim().toLowerCase();
  const items = Array.isArray(payload?.items) ? payload.items.slice(0, HOLDING_WATCH_PER_CHAIN_MAX) : [];
  const replace = payload?.replace === true;
  holdingWatchWriteQueue = holdingWatchWriteQueue.then(async () => {
    const { holdingWatchList } = await chrome.storage.local.get({ holdingWatchList: [] });
    const next = mergeHoldingWatchList(holdingWatchList, chain, items, replace);
    await chrome.storage.local.set({ holdingWatchList: next });
    return { ok: true, count: next.length };
  });
  return holdingWatchWriteQueue;
}

// ---- 提醒历史：由后台串行落库，避免多个 GMGN 标签页互相覆盖 ----
const NOTIFICATION_HISTORY_KEY = 'notificationHistoryV1';
const NOTIFICATION_HISTORY_READ_AT_KEY = 'notificationHistoryReadAtV1';
const NOTIFICATION_HISTORY_MAX = 100;
let notificationHistoryWriteQueue = Promise.resolve();

function cleanNotificationText(value, maxLength) {
  return String(value || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, maxLength);
}

function normalizeNotificationHistoryItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const at = Number(raw.at) > 0 ? Number(raw.at) : Date.now();
  const tag = cleanNotificationText(raw.tag, 24);
  const symbol = cleanNotificationText(raw.symbol, 32);
  const label = cleanNotificationText(raw.label, 32);
  const value = cleanNotificationText(raw.value, 96);
  const bell = cleanNotificationText(raw.bell, 8);
  const dir = raw.dir === 'up' || raw.dir === 'down' ? raw.dir : '';
  const rawHref = cleanNotificationText(raw.href, 512);
  const href = /^\/[a-z0-9]+\/token\/[A-Za-z0-9]+(?:[/?#].*)?$/.test(rawHref) ? rawHref : '';
  if (!tag && !symbol && !label && !value) return null;
  const fallbackId = `${at}-${tag}-${symbol}-${value}`.slice(0, 160);
  const id = cleanNotificationText(raw.id, 160) || fallbackId;
  return { id, at, tag, symbol, label, value, bell, dir, href };
}

function notificationHistoryFingerprint(item) {
  return [item.tag, item.symbol, item.label, item.value, item.dir, item.href].join('\n');
}

function mergeNotificationHistory(current, incoming) {
  const next = normalizeNotificationHistoryItem(incoming);
  const normalized = (Array.isArray(current) ? current : [])
    .map(normalizeNotificationHistoryItem)
    .filter(Boolean)
    .sort((a, b) => b.at - a.at);
  if (!next) return normalized.slice(0, NOTIFICATION_HISTORY_MAX);
  const duplicate = normalized.find((item) => (
    Math.abs(next.at - item.at) < 5000
    && notificationHistoryFingerprint(item) === notificationHistoryFingerprint(next)
  ));
  const combined = duplicate ? normalized : [next, ...normalized];
  const seen = new Set();
  return combined.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  }).slice(0, NOTIFICATION_HISTORY_MAX);
}

function appendNotificationHistory(payload) {
  notificationHistoryWriteQueue = notificationHistoryWriteQueue.catch(() => {}).then(async () => {
    const stored = await chrome.storage.local.get({ [NOTIFICATION_HISTORY_KEY]: [] });
    const next = mergeNotificationHistory(stored[NOTIFICATION_HISTORY_KEY], {
      ...payload,
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`,
      at: Date.now(),
    });
    await chrome.storage.local.set({ [NOTIFICATION_HISTORY_KEY]: next });
    return { ok: true, count: next.length };
  });
  return notificationHistoryWriteQueue;
}

function markNotificationHistoryRead() {
  notificationHistoryWriteQueue = notificationHistoryWriteQueue.catch(() => {}).then(async () => {
    const readAt = Date.now();
    await chrome.storage.local.set({ [NOTIFICATION_HISTORY_READ_AT_KEY]: readAt });
    return { ok: true, readAt };
  });
  return notificationHistoryWriteQueue;
}

function clearNotificationHistory() {
  notificationHistoryWriteQueue = notificationHistoryWriteQueue.catch(() => {}).then(async () => {
    const readAt = Date.now();
    await chrome.storage.local.set({
      [NOTIFICATION_HISTORY_KEY]: [],
      [NOTIFICATION_HISTORY_READ_AT_KEY]: readAt,
    });
    return { ok: true, readAt };
  });
  return notificationHistoryWriteQueue;
}

async function recordFomoPageHeartbeat(message, sender) {
  try {
    const tabId = Number(sender?.tab?.id);
    const pageUrl = new URL(String(sender?.tab?.url || ''));
    if (!Number.isInteger(tabId) || !(pageUrl.hostname === 'fomo.family' || pageUrl.hostname.endsWith('.fomo.family'))) return;
    const keeper = message?.keeper === true || pageUrl.searchParams.has('gdh_keeper');
    await chrome.storage.local.set({
      fomoPage: { at: Date.now(), visible: message?.visible === true, tabId, keeper },
    });
    // 用户打开真实 FOMO 页时，它接管 SDK 会话；关闭扩展专用 keeper，避免两个页面
    // 同时在 exp 附近轮换同一个 refresh_token。只关带 gdh_keeper 标记的扩展页。
    if (!keeper) {
      const tabs = await fomoOpenTabs();
      const extraIds = tabs
        .filter((tab) => tab.id !== tabId && String(tab.url || '').includes('gdh_keeper='))
        .map((tab) => tab.id)
        .filter(Number.isInteger);
      if (extraIds.length) {
        await chrome.tabs.remove(extraIds);
        await fomoAuthNote('keeper-closed-for-page', { tabs: extraIds.length });
      }
    }
  } catch {
    // 标签页在异步查询期间关闭，下一次心跳/闹钟会收敛
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === '985-monitor-session-updated') {
    refreshMonitor985Config(true)
      .then((ok) => { restartFomoSse(); sendResponse({ ok: Boolean(ok) }); })
      .catch(() => sendResponse({ ok: false }));
    return true;
  }
  if (message?.type === 'fomo-page-heartbeat') {
    recordFomoPageHeartbeat(message, sender)
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }
  // 每次页面来消息都顺手看一眼要不要续期。用户在用 GMGN 就一定有消息流（fomo 拉取、
  // 徽章、混排…），比只靠 alarms 可靠得多——SW 被唤醒执行消息时闹钟可能还没到点。
  fomoKeepAlive();

  // 面板遇到 expired 时主动求续一次，续上就不用打扰用户重新登录
  if (message?.type === 'fomo-force-refresh') {
    fomoKeepAlive(true)
      .then(() => chrome.storage.local.get('fomoToken'))
      .then(({ fomoToken }) => {
        const exp = Number(fomoToken?.exp) || 0;
        sendResponse({ ok: !!fomoToken?.token && exp > Date.now(), exp });
      })
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (message?.type === 'marked-holdings') {
    fetchMarkedFeed()
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, reason: 'error', message: String(error?.message || '') }));
    return true;
  }

  if (message?.type === 'holding-watch-update') {
    updateHoldingWatchList(message.payload || {})
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, reason: 'error', message: String(error?.message || '') }));
    return true;
  }

  if (message?.type === 'notification-history-add') {
    appendNotificationHistory(message.payload || {})
      .then(sendResponse)
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (message?.type === 'notification-history-read') {
    markNotificationHistoryRead()
      .then(sendResponse)
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (message?.type === 'notification-history-clear') {
    clearNotificationHistory()
      .then(sendResponse)
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (message?.type === 'fomo-feed') {
    connectFomoSse(); // SW 被唤醒时顺手把实时流接回来（已连着则立即返回）
    fetchFomoFeed()
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, reason: 'error', message: String(error?.message || '') }));
    return true;
  }

  if (message?.type === 'pump-feed') {
    connectFomoSse(); // fomo 与 Pump 共用 985monitor 的同一条 SSE
    fetchPumpFeed()
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, reason: 'error', message: String(error?.message || '') }));
    return true;
  }

  if (message?.type === 'token-supply') {
    tokenSupply(message.payload || {})
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, reason: 'error', message: String(error?.message || '') }));
    return true;
  }

  if (message?.type === 'token-pools') {
    tokenPools(message.payload || {})
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, reason: 'error', message: String(error?.message || '') }));
    return true;
  }

  if (message?.type === 'flap-token-info') {
    flapTokenInfo(message.payload || {})
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, reason: 'error', message: String(error?.message || '') }));
    return true;
  }

  if (message?.type === 'robinhood-rwa-catalog') {
    fetchRobinhoodRwaCatalog()
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, reason: 'error', message: String(error?.message || '') }));
    return true;
  }

  if (message?.type === 'stonkfun-rwa-catalog') {
    fetchStonkfunRwaCatalog()
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, reason: 'error', message: String(error?.message || '') }));
    return true;
  }

  if (message?.type === 'brew-trenches') {
    fetchBrewTrenches(message.force === true)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, reason: 'error', message: String(error?.message || '') }));
    return true;
  }

  if (message?.type === 'fomo-user-pnl') {
    fomoUserPnl7d(message.payload || {})
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, reason: 'error', message: String(error?.message || '') }));
    return true;
  }

  if (message?.type === 'fomo-token-feed') {
    fomoFetchTokenShared(message.payload || {})
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, reason: 'error', message: String(error?.message || '') }));
    return true;
  }

  if (message?.type === 'fomo-trending') {
    fomoFetchTrending()
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, reason: 'error', message: String(error?.message || '') }));
    return true;
  }

  if (message?.type === 'check-update') {
    checkForUpdate().then(sendResponse);
    return true;
  }

  if (message?.type === 'install-update') {
    installUpdate()
      .then((response) => sendResponse({ ...response, shouldReload: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message || '升级失败' }));
    return true;
  }

  if (message?.type === 'get-update-state') {
    chrome.storage.local.get('updateState').then(({ updateState }) => {
      sendResponse(updateState || null);
    });
    return true;
  }

  return false;
});
