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
  // 浏览器关着的时间不跑任何代码，开机时令牌多半已经过期，先补一次
  fomoKeepAlive(true);
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
  return inner === 401 || inner === 403;
}

/** 带令牌打 fomo 接口：快过期先交给页面 SDK 续，被拒再等待镜像并重试。 */
async function fomoAuthedFetch(path) {
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
    const headers = { Accept: 'application/json', 'X-Supported-Chains': FOMO_CHAINS };
    if (token) headers.Authorization = `Bearer ${token}`;
    return fetch(`${FOMO_API}${path}`, { headers, credentials: 'include' });
  };
  let res = await send(stored?.token);
  let renewed = false;
  let bodyUnauthed = false;
  if (res.ok) {
    const probe = await res.clone().json().catch(() => null);
    bodyUnauthed = fomoBodyUnauthed(probe);
  }
  if ((res.status === 401 || bodyUnauthed) && stored?.refresh) {
    const next = await fomoRefreshSession();
    if (next?.token && next.token !== stored?.token) {
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
    // 复用浏览器里的 fomo 登录态（cookie）+ Bearer；过期时等待页面 SDK 续期并镜像。
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

// 各链公共 RPC（端点逐个实测过能读 totalSupply/decimals）。
// 供应量只用于算 fomo 持仓占比，读失败就不显示占比，不影响其它。
const SUPPLY_RPCS = {
  bsc: [...FLAP_RPCS, 'https://bsc-rpc.publicnode.com'],
  eth: ['https://ethereum-rpc.publicnode.com'],
  base: ['https://mainnet.base.org', 'https://base-rpc.publicnode.com'],
};
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
    supplyCache.set(key, viaGmgn);
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
  // 转入不是买入：链上腿只看得到代币进账那一条腿，空投 / 税收分红 / 别人打款
  // 形状和买入一模一样。采集端判出「不是交易」的，这边单独成一类，别混进买入。
  FOMO_TRANSFER_IN: 'transferIn',
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


// ---- 985monitor Pump 成交事件源 ----
// /api/pump-trade-events 公开返回全量实时成交；前台再按用户同步过来的关注和过滤设置裁剪。
const PUMP_FEED_URL = 'https://www.985monitor.xyz/api/pump-trade-events?limit=150';
const PUMP_DEFAULT_WATCH_URL = 'https://www.985monitor.xyz/api/pump-watch/default';
const PUMP_FEED_MIN_INTERVAL_MS = 15000;
const PUMP_FEED_KEEP = 150;
const PUMP_DEFAULT_WATCH_TTL_MS = 5 * 60 * 1000;
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
    pumpWallet: wallet.slice(0, 48),
    profileUrl: `https://pump.fun/profile/${encodeURIComponent(wallet)}`,
  };
}

async function fetchPumpDefaultWallets() {
  if (Date.now() - pumpDefaultWatchCache.fetchedAt < PUMP_DEFAULT_WATCH_TTL_MS) {
    return pumpDefaultWatchCache.wallets;
  }
  try {
    const response = await fetch(PUMP_DEFAULT_WATCH_URL, { cache: 'no-store' });
    const body = await response.json();
    if (!response.ok || body?.ok !== true || !Array.isArray(body.rules)) throw new Error(`HTTP ${response.status}`);
    const wallets = body.rules
      .filter((item) => item?.enabled !== false)
      .map((item) => String(item?.userId || '').trim())
      .filter(Boolean)
      .slice(0, 500);
    pumpDefaultWatchCache = { wallets: [...new Set(wallets)], fetchedAt: Date.now() };
  } catch {
    // 保留上一次默认名单，事件主链路仍可继续
  }
  return pumpDefaultWatchCache.wallets;
}

async function fetchPumpFeed() {
  if (pumpFeedInflight) return pumpFeedInflight;
  const now = Date.now();
  if (now - pumpFeedCache.fetchedAt < PUMP_FEED_MIN_INTERVAL_MS || now < pumpFeedBackoffUntil) {
    return { ok: true, ...pumpFeedCache, defaultWallets: await fetchPumpDefaultWallets(), stale: true };
  }
  pumpFeedInflight = (async () => {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 25000);
      let response;
      try {
        response = await fetch(PUMP_FEED_URL, { cache: 'no-store', signal: controller.signal });
      } finally {
        clearTimeout(timer);
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json();
      const events = (Array.isArray(body?.events) ? body.events : [])
        .map(slimPumpEvent)
        .filter(Boolean)
        .sort((a, b) => b.ts - a.ts)
        .slice(0, PUMP_FEED_KEEP);
      pumpFeedCache = { events, updatedAt: Number(body?.updatedAt) || Date.now(), fetchedAt: Date.now() };
      pumpFeedFailCount = 0;
      pumpFeedBackoffUntil = 0;
      return { ok: true, ...pumpFeedCache, defaultWallets: await fetchPumpDefaultWallets() };
    } catch (error) {
      pumpFeedFailCount += 1;
      pumpFeedBackoffUntil = Date.now() + Math.min(15 * 60000, 60000 * Math.pow(2, pumpFeedFailCount - 1));
      if (pumpFeedCache.events.length) {
        return { ok: true, ...pumpFeedCache, defaultWallets: await fetchPumpDefaultWallets(), stale: true };
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
// 更新对应缓存并通知 GMGN 标签页；标签页照旧用消息拿缓存（命中
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

function pumpSseNotifyTabs() {
  try {
    chrome.tabs.query({ url: 'https://gmgn.ai/*' }, (tabs) => {
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
  const rest = pumpFeedCache.events.filter((item) => item.key !== ev.key);
  rest.unshift(ev);
  rest.sort((a, b) => b.ts - a.ts);
  pumpFeedCache = { ...pumpFeedCache, events: rest.slice(0, PUMP_FEED_KEEP), updatedAt: Date.now() };
  pumpSseNotifyTabs();
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
          if ((eventType === 'fomo' || eventType === 'pump-trade') && dataLines.length) {
            try {
              const payload = JSON.parse(dataLines.join('\n'));
              if (payload?.event && eventType === 'fomo') fomoSseIngest(payload.event);
              if (payload?.event && eventType === 'pump-trade') pumpSseIngest(payload.event);
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
