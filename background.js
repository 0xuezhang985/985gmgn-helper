'use strict';

const NATIVE_HOST = 'com.xuezhang985.gmgn_helper';
const RELEASES_URL = 'https://github.com/0xuezhang985/985gmgn-helper/releases/latest';
const UPDATE_ALARM = '985gmgn-update-check';
const CHECK_INTERVAL_MINUTES = 360;

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
  checkForUpdate();
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(UPDATE_ALARM, { periodInMinutes: CHECK_INTERVAL_MINUTES });
  checkForUpdate();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === UPDATE_ALARM) checkForUpdate();
});

// ---- fomo 代币数据（在后台取，避开页面 CORS/CSP；令牌由 fomo.family 上的脚本捕获）----
const FOMO_API = 'https://prod-api.fomo.family';
// fomo 自己每个请求都带这个头（少了它 /hodlers/top 会返回空）：eth,bnb,monad,robinhood,base,solana
const FOMO_CHAINS = '1,56,143,4663,8453,1399811149';
const FOMO_CACHE_MS = 20000;
const fomoCache = new Map();

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
// fomo 用 privy 登录，访问令牌约一小时就过期。捕获时连 refresh_token 一起存下来，
// 过期或被拒时用它去 privy 换新的，这样不必反复回 fomo 页面手动刷。
const PRIVY_APP_ID = 'cm6h485o300n3zj9yl6vpedq7';
const PRIVY_CLIENT = 'react-auth:3.34.0';
let fomoRefreshInFlight = null;

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
    const refresh = fomoToken?.refresh;
    if (!refresh) return null;
    const res = await fetch('https://auth.privy.io/api/v1/sessions', {
      method: 'POST',
      headers: {
        'privy-app-id': PRIVY_APP_ID,
        'privy-client': PRIVY_CLIENT,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ refresh_token: refresh }),
    });
    if (!res.ok) return null;
    const body = await res.json().catch(() => null);
    // privy 明确说会话作废时才清，其它情况宁可留着旧的
    if (body?.session_update_action === 'clear') {
      await chrome.storage.local.set({ fomoToken: null });
      return null;
    }
    const token = body?.token;
    if (!token) return null;
    const next = {
      token,
      refresh: body.refresh_token || refresh,
      at: Date.now(),
      exp: jwtExpMs(token),
      renewed: true,
    };
    await chrome.storage.local.set({ fomoToken: next });
    // 新令牌写回开着的 fomo.family 页，网页和插件共用同一条 privy 轮换链
    try {
      const tabs = await chrome.tabs.query({ url: ['https://fomo.family/*', 'https://*.fomo.family/*'] });
      for (const tab of tabs) {
        chrome.tabs.sendMessage(
          tab.id,
          { type: 'gdh-privy-writeback', token: next.token, refresh: next.refresh },
          () => void chrome.runtime.lastError,
        );
      }
    } catch {
      // 没有 tabs 权限或没有开着的页面：跳过，等下次同步
    }
    return next;
  })().catch(() => null);
  try {
    return await fomoRefreshInFlight;
  } finally {
    fomoRefreshInFlight = null;
  }
}

/** 带令牌打 fomo 接口：快过期先续，被拒再续一次并重试。 */
async function fomoAuthedFetch(path) {
  let stored = (await chrome.storage.local.get('fomoToken')).fomoToken || null;
  // 剩不到一分钟就当已过期，先换新的再发，省掉一次注定失败的请求
  if (stored?.refresh && stored.exp && stored.exp - Date.now() < 60000) {
    // 续期失败要区分两种：privy 把会话作废了（存储已被清空，应引导重新登录）
    // 还是只是这次没成（旧令牌还留着，照旧拿它试一把）
    stored = (await fomoRefreshSession())
      || (await chrome.storage.local.get('fomoToken')).fomoToken
      || null;
  }
  const send = (token) => {
    const headers = { Accept: 'application/json', 'X-Supported-Chains': FOMO_CHAINS };
    if (token) headers.Authorization = `Bearer ${token}`;
    return fetch(`${FOMO_API}${path}`, { headers, credentials: 'include' });
  };
  let res = await send(stored?.token);
  let renewed = false;
  if (res.status === 401 && stored?.refresh) {
    const next = await fomoRefreshSession();
    if (next?.token) {
      renewed = true;
      stored = next;
      res = await send(next.token);
    } else if (!(await chrome.storage.local.get('fomoToken')).fomoToken) {
      stored = null; // 会话已被 privy 作废，按「没有令牌」上报，引导重新登录
    }
  }
  return { res, stored, renewed };
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
    // 复用浏览器里的 fomo 登录态（cookie）+ Bearer 令牌；令牌过期会自动用 refresh_token 续。
    // credentials:'include' 同时让请求更像正常浏览器请求（fomo 在 Cloudflare 后面）。
    const { res, stored, renewed } = await fomoAuthedFetch(path);
    token = stored?.token;
    if (!res.ok && res.status === 401 && !token) {
      return { ok: false, reason: 'no-token', status: 401, tokenAt: 0 };
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const blocked = /cloudflare|cf-ray|<!DOCTYPE html/i.test(text);
      return {
        ok: false,
        reason: blocked ? 'blocked' : (res.status === 401 ? 'expired' : `http-${res.status}`),
        status: res.status,
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
    fomoCache.set(key, { at: Date.now(), data });
    return data;
  } catch (error) {
    return {
      ok: false,
      reason: 'network',
      message: String(error?.message || '').slice(0, 80),
    };
  }
}

// ---- 单个用户的 7 天盈亏（给持仓者打标记用）----
// fomo 悬浮卡是「实时余额算的累计 PnL − 7 天前快照的 PnL」，要两个请求。
// 这里用同一条快照序列的首末差，一个请求就够，代价是最多滞后一小时——打标记足够了。
const FOMO_PNL_TTL = 10 * 60 * 1000;
const fomoPnlCache = new Map();

async function fomoUserPnl7d({ userId }) {
  if (!userId) return { ok: false, reason: 'no-user' };
  const hit = fomoPnlCache.get(userId);
  if (hit && Date.now() - hit.at < FOMO_PNL_TTL) return hit.data;

  const since = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
  const path = `/v2/userTokens/aggregatedSnapshot?userId=${encodeURIComponent(userId)}&timestamp=${encodeURIComponent(since)}`;
  try {
    const { res } = await fomoAuthedFetch(path);
    if (!res.ok) return { ok: false, reason: res.status === 401 ? 'expired' : `http-${res.status}` };
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
      fomoPnlCache.set(userId, { at: Date.now(), data });
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
    fomoPnlCache.set(userId, { at: Date.now(), data });
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
const FLAP_TTL = 60000;
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
          missing.forEach((a, i) => flapSymbolCache.set(a, flapString(syms[i])));
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
      flapCache.set(address, { at: Date.now(), data });
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
  flapCache.set(address, { at: Date.now(), data });
  return data;
}

// 代币总供应量（人类可读口径，和 fomo 的 humanAmount 对齐），用于算 fomo 持仓占比。
// 供应量基本不变，长缓存；只支持 EVM 链（沿用 Flap 那条 RPC 通道）。
const supplyCache = new Map();

async function tokenSupply({ chain, address, rpc }) {
  // 前缀也放宽大小写：校验和地址本身就是混合大小写，没必要在这里卡人
  if (chain !== 'bsc' || !/^0x[a-fA-F0-9]{40}$/i.test(address || '')) {
    return { ok: false, reason: 'unsupported-chain' };
  }
  const key = address.toLowerCase();
  if (supplyCache.has(key)) return { ok: true, supply: supplyCache.get(key) };
  // flapRpc 只打单个节点，节点回退在调用方——这里同样要逐个试，
  // 否则一个节点抽风整项就没了。用户自定义 RPC 优先。
  const endpoints = [rpc, ...FLAP_RPCS].filter(Boolean);
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
      supplyCache.set(key, supply);
      return { ok: true, supply };
    } catch (error) {
      lastError = String(error?.message || '').slice(0, 80);
    }
  }
  return { ok: false, reason: 'rpc', message: lastError };
}


// ---- 985monitor fomo 事件源 ----
// 985monitor 的 fomo 采集器把最近事件整体发布成一个静态 JSON（无鉴权，~1 分钟一更）。
// 这里做唯一的取数口：控频 + ETag 条件请求（304 就不拉 800KB 全量）+ 失败指数退避。
const FOMO_FEED_URL = 'https://www.985monitor.xyz/fomo-events.json';
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
};

// fomo 的链名 → GMGN 的路径段
const FOMO_CHAIN_SLUG = { bnb: 'bsc', bsc: 'bsc', sol: 'sol', solana: 'sol', eth: 'eth', ethereum: 'eth', base: 'base', robinhood: 'robinhood', 'chain 143': 'monad' };

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
    type,
    handle: String(raw.handle || '').toLowerCase().slice(0, 64),
    name: String(raw.userName || raw.handle || '').slice(0, 48),
    avatar: String(raw.avatar || '').slice(0, 300),
    usd: Number(raw.usd) || 0,
    comment: String(raw.comment || content.comment || content.text || '').slice(0, 600),
    addr: String(raw.tokenAddress || '').slice(0, 64),
    chain: FOMO_CHAIN_SLUG[chainName.toLowerCase()] || chainName.toLowerCase(),
    chainName,
    symbol: String(raw.symbol || '').slice(0, 24),
    img: String(raw.tokenImage || '').slice(0, 300),
    mc: Number(raw.marketCap) || 0,
    ts,
  };
}

async function fetchFomoFeed() {
  if (fomoFeedInflight) return fomoFeedInflight;
  const now = Date.now();
  if (now - fomoFeedCache.fetchedAt < FOMO_FEED_MIN_INTERVAL_MS || now < fomoFeedBackoffUntil) {
    return { ok: true, ...fomoFeedCache, stale: true };
  }
  fomoFeedInflight = (async () => {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 25000);
      const headers = fomoFeedEtag ? { 'If-None-Match': fomoFeedEtag } : {};
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
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json();
      const events = (Array.isArray(body?.events) ? body.events : [])
        .map(slimFomoEvent)
        .filter(Boolean)
        .sort((a, b) => b.ts - a.ts)
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


// ---- 985monitor SSE 实时订阅（fomo 事件秒级到达）----
// MV3 service worker 没有 EventSource，用 fetch 流手工解析。收到 fomo 事件直接
// 更新 fomoFeedCache 并通知 GMGN 标签页；标签页照旧用 'fomo-feed' 拿缓存（命中
// 控频间隔内的 stale 分支，零额外 HTTP）。SW 被挂起时连接自然断，content 侧
// 18 秒轮询一到就会唤醒 SW 触发重连——轮询同时也是 SSE 断档期的兜底。
const FOMO_SSE_URL = 'https://www.985monitor.xyz/api/events-stream';
let fomoSseAbort = null;
let fomoSseBackoff = 5000;

function fomoSseNotifyTabs() {
  try {
    chrome.tabs.query({ url: 'https://gmgn.ai/*' }, (tabs) => {
      if (chrome.runtime.lastError || !Array.isArray(tabs)) return;
      for (const tab of tabs) {
        chrome.tabs.sendMessage(tab.id, { type: 'gdh-fomo-push' }, () => void chrome.runtime.lastError);
      }
    });
  } catch {
    // tabs 不可用
  }
}

function fomoSseIngest(raw) {
  const ev = slimFomoEvent(raw);
  if (!ev) return;
  const rest = fomoFeedCache.events.filter((e) => e.key !== ev.key);
  rest.unshift(ev);
  rest.sort((a, b) => b.ts - a.ts);
  fomoFeedCache = { ...fomoFeedCache, events: rest.slice(0, FOMO_FEED_KEEP), updatedAt: Date.now() };
  fomoSseNotifyTabs();
}

async function connectFomoSse() {
  if (fomoSseAbort) return;
  const controller = new AbortController();
  fomoSseAbort = controller;
  try {
    const response = await fetch(FOMO_SSE_URL, {
      headers: { Accept: 'text/event-stream' },
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
    fomoSseBackoff = 5000;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let eventType = '';
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
          if (eventType === 'fomo' && dataLines.length) {
            try {
              const payload = JSON.parse(dataLines.join('\n'));
              if (payload?.event) fomoSseIngest(payload.event);
            } catch {
              // 单帧坏数据不断流
            }
          }
          eventType = '';
          dataLines = [];
          continue;
        }
        if (line.startsWith('event:')) eventType = line.slice(6).trim();
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
      }
    }
  } catch {
    // 断线/超时/SW 即将挂起，都走重连
  } finally {
    fomoSseAbort = null;
  }
  // 指数退避重连（上限 2 分钟）；SW 若被挂起，这个定时器作废，
  // 由下一次 'fomo-feed' 消息唤醒时重连
  setTimeout(connectFomoSse, fomoSseBackoff);
  fomoSseBackoff = Math.min(120000, fomoSseBackoff * 2);
}


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

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'marked-holdings') {
    fetchMarkedFeed()
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, reason: 'error', message: String(error?.message || '') }));
    return true;
  }

  if (message?.type === 'fomo-feed') {
    connectFomoSse(); // SW 被唤醒时顺手把实时流接回来（已连着则立即返回）
    fetchFomoFeed()
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

  if (message?.type === 'flap-token-info') {
    flapTokenInfo(message.payload || {})
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
    fomoFetchToken(message.payload || {})
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
