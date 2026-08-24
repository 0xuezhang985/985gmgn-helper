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

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
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
