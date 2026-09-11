import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8').replace(/\r\n/g, '\n');
const background = read('background.js');
const content = read('content.js');
const bridge = read('page-bridge.js');
const monitorAggregate = read('monitor-aggregate.js');
const monitorAggregateStyles = read('monitor-aggregate.css');
const debotContent = read('debot-content.js');
const debotBridge = read('debot-bridge.js');
const debotStyles = read('debot-styles.css');
const brewContent = read('brew-content.js');
const brewStyles = read('brew-styles.css');
const brewBaseline = JSON.parse(read('brew-launch-baseline.json'));
const brewLaunchFixture = JSON.parse(read('scripts/fixtures/brew-token-launched.json'));
const manifest = JSON.parse(read('manifest.json'));
const releaseBuild = read('scripts/build-release.ps1');
const popup = read('popup.js');
const popupHtml = read('popup.html');
const popupStyles = read('popup.css');
const styles = read('styles.css');
const site = read('site/index.html');
const bgmSync = read('scripts/sync-bgm-download.py');
const privacy = read('PRIVACY.md');

function extractFunction(source, name) {
  const functionStart = source.indexOf(`function ${name}(`);
  assert.ok(functionStart >= 0, `missing function ${name}`);
  const start = source.slice(Math.max(0, functionStart - 6), functionStart) === 'async '
    ? functionStart - 6 : functionStart;
  const bodyStart = source.indexOf('{', start);
  let depth = 0;
  let quote = '';
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let i = bodyStart; i < source.length; i += 1) {
    const ch = source[i];
    const next = source[i + 1];
    if (lineComment) {
      if (ch === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (ch === '*' && next === '/') { blockComment = false; i += 1; }
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '/' && next === '/') { lineComment = true; i += 1; continue; }
    if (ch === '/' && next === '*') { blockComment = true; i += 1; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`unterminated function ${name}`);
}

function evaluate(functions, expression, extras = {}) {
  const context = vm.createContext({ ...extras });
  return vm.runInContext(`${functions.join('\n')}\n(${expression})`, context);
}

let passed = 0;
const test = async (name, fn) => {
  await fn();
  passed += 1;
  process.stdout.write(`ok ${passed} - ${name}\n`);
};

await test('追踪流 FOMO 卡片优先显示最佳榜单排名', () => {
  const boardMatch = content.match(/const FOMO_BOARD = JSON\.parse\('([^']+)'\);/);
  assert.ok(boardMatch, 'missing FOMO_BOARD data');
  const fomoBoard = JSON.parse(boardMatch[1]);
  const fn = extractFunction(content, 'fomoFeedRankMark');
  const rankBoard = {
    all: { label: '总榜', short: '总' },
    '30d': { label: '30天', short: '30天' },
    '7d': { label: '7天', short: '7天' },
    '24h': { label: '24h', short: '24h' },
  };
  const run = (handle, liveBoard = '', liveRank = 0) => JSON.parse(JSON.stringify(evaluate(
    [fn],
    `fomoFeedRankMark(${JSON.stringify(handle)}, ${JSON.stringify(liveBoard)}, ${JSON.stringify(liveRank)})`,
    {
      FOMO_BOARD: fomoBoard,
      FOMO_BOARD_LABEL: { a: '总榜', m: '30天', w: '7天', d: '24h' },
      FOMO_FEED_RANK_BOARD: rankBoard,
    },
  )));

  assert.deepEqual(run('change', '30d', 7), { text: '30天#7', title: 'fomo 30天盈利榜第 7 名', top: true });
  assert.deepEqual(run('@change'), { text: '总#1', title: 'fomo 总榜盈利榜第 1 名', top: true });
  assert.deepEqual(run('metaversejoji'), { text: '7天#9', title: 'fomo 7天盈利榜第 9 名', top: true });
  assert.deepEqual(run('_cr0wbar_'), { text: '聪#1', title: '聪明钱榜第 1 名', top: true });
  const multiBoard = JSON.parse(JSON.stringify(evaluate([fn], "fomoFeedRankMark('multi')", {
    FOMO_BOARD: { multi: 'd1w2m3a99s1' },
    FOMO_BOARD_LABEL: { a: '总榜', m: '30天', w: '7天', d: '24h' },
    FOMO_FEED_RANK_BOARD: rankBoard,
  })));
  assert.deepEqual(multiBoard, { text: '总#99', title: 'fomo 总榜盈利榜第 99 名', top: false });
  assert.equal(run('not-on-any-board'), null);
  assert.equal((extractFunction(content, 'buildFomoFeedTableRow').match(/attachFomoFeedRank/g) || []).length, 1);
  assert.equal((extractFunction(content, 'buildFomoFeedCard').match(/attachFomoFeedRank/g) || []).length, 1);
  assert.ok(styles.includes('.gdh-fomofeed__rank.is-top'));
});

await test('FOMO 排名通过每日 SSE 快照缓存且不随每笔事件重复请求', () => {
  const functions = [
    extractFunction(background, 'normalizeFomoRankSnapshot'),
    extractFunction(background, 'fomoRankSnapshotForStorage'),
    extractFunction(background, 'applyFomoRankSnapshotToEvent'),
  ];
  const result = evaluate(functions, `(() => {
    const snapshot = normalizeFomoRankSnapshot({
      updatedAt: 1770000000000,
      ranks: [['@Alice', 'all', 2], ['bob', '7d', 9], ['long.handle-name', '30d', 7], ['bad user', 'all', 1], ['mallory', 'evil', 1]]
    });
    return {
      stored: fomoRankSnapshotForStorage(snapshot),
      ranked: applyFomoRankSnapshotToEvent({ key: 'one', handle: 'alice' }, snapshot),
      plain: applyFomoRankSnapshotToEvent({ key: 'two', handle: 'nobody' }, snapshot),
    };
  })()`, { FOMO_RANK_BOARD_KEYS: new Set(['all', '30d', '7d', '24h']) });
  const normalized = JSON.parse(JSON.stringify(result));
  assert.deepEqual(normalized.ranked, {
    key: 'one', handle: 'alice', fomoRankBoard: 'all', fomoRank: 2, fomoRankUpdatedAt: 1770000000000,
  });
  assert.deepEqual(normalized.plain, { key: 'two', handle: 'nobody' });
  assert.equal(normalized.stored.ranks.length, 3);
  assert.deepEqual(normalized.stored.ranks[2], ['long.handle-name', '30d', 7]);
  const connect = extractFunction(background, 'connectFomoSse');
  assert.ok(connect.includes("searchParams.set('fomoRankUpdatedAt'"));
  assert.ok(connect.includes("eventType === 'fomo-ranks'"));
  assert.ok(extractFunction(background, 'fomoSseIngestRanks').includes('chrome.storage.local.set'));
  assert.ok(content.includes("msg?.type === 'gdh-fomo-ranks'"));
});

await test('隐藏闪电交易按钮默认关闭且已保存选择仍优先', () => {
  assert.match(popup, /hideLightningTrade:\s*false,/);
  assert.match(content, /hideLightningTrade:\s*false,/);
  assert.ok(popupHtml.includes('隐藏 frontrun 注入的“闪电交易”按钮（默认关闭）'));
  assert.ok(popup.includes('chrome.storage.local.get(DEFAULTS, (stored) =>'));
  assert.ok(content.includes('settings = { ...DEFAULTS, ...stored };'));
});

await test('部分卖出后的成本按累计买入数量计算并含手续费', () => {
  const fn = extractFunction(bridge, 'readHoldingCost');
  const result = evaluate([fn], 'readHoldingCost({ balance: 40, accu_amount: 100, accu_cost: 100, accu_fee: 2 })');
  assert.equal(result, 1.02);
});

await test('已清仓记录不使用 history_avg_cost 冒充当前仓位', () => {
  const fn = extractFunction(bridge, 'readHoldingCost');
  const result = evaluate([fn], 'readHoldingCost({ balance: 0, history_avg_cost: 9 })');
  assert.equal(result, 0);
});

await test('API 成本聚合函数与页面桥接口径一致', () => {
  const fn = extractFunction(content, 'holdingCostFromApi');
  const result = evaluate([fn], 'holdingCostFromApi({ balance: 40, accu_amount: 100, accu_cost: 100, accu_fee: 2 })');
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { balance: 40, average: 1.02 });
});

await test('持仓暴涨同时校验购买成本收益和最近 5 分钟涨幅', () => {
  const costFn = extractFunction(content, 'holdingCostChange');
  const fiveMinuteFn = extractFunction(content, 'holdingFiveMinuteChange');
  assert.ok(Math.abs(evaluate([costFn], "holdingCostChange('1.2', '1')") - 20) < 1e-9);
  assert.equal(evaluate([costFn], "holdingCostChange('2', '4')"), -50);
  assert.equal(Number.isNaN(evaluate([costFn], "holdingCostChange('2', '0')")), true);
  assert.ok(Math.abs(evaluate([fiveMinuteFn], "holdingFiveMinuteChange({ price5m: 1 }, 1.05)") - 5) < 1e-9);
  assert.equal(evaluate([fiveMinuteFn], "holdingFiveMinuteChange({ pct5m: -2 }, 1.05)"), -2);
  assert.equal(Number.isNaN(evaluate([fiveMinuteFn], "holdingFiveMinuteChange({}, 1.05)")), true);
  const handler = extractFunction(content, 'handleHoldingPriceUpdate');
  assert.ok(handler.includes('holdingCostChange(price, meta?.cost)'));
  assert.ok(handler.includes('holdingFiveMinuteChange(update, price)'));
  assert.ok(handler.includes('pct5m > 0'));
  assert.ok(content.includes('price5m: Number(p.price_5m)'));
});

await test('购买成本实质变化会重置提醒基准，微小数值抖动不会', () => {
  const fn = extractFunction(content, 'holdingCostMateriallyChanged');
  assert.equal(evaluate([fn], 'holdingCostMateriallyChanged(0, 1)'), true);
  assert.equal(evaluate([fn], 'holdingCostMateriallyChanged(1, 1.0005)'), false);
  assert.equal(evaluate([fn], 'holdingCostMateriallyChanged(1, 1.002)'), true);
  assert.equal(evaluate([fn], 'holdingCostMateriallyChanged(1, 0)'), false);
  const put = extractFunction(content, 'putHolding');
  assert.ok(put.includes('holdingAlertedAt.delete(key)'));
  assert.ok(put.includes('holdingAlertLevel.delete(key)'));
  const rebuild = extractFunction(content, 'rebuildHoldingWatch');
  assert.ok(rebuild.includes('holdingCostMateriallyChanged(old.cost, item.cost)'));
  assert.ok(rebuild.includes('if (next.has(key)) continue'));
});

await test('持仓暴涨首包静默、越档提醒、回落后可再次提醒', () => {
  const fn = extractFunction(content, 'holdingSurgeDecision');
  const call = (previous, pct, ready = true, rising = true) => evaluate([fn], `holdingSurgeDecision(${previous}, ${pct}, 20, ${ready}, ${rising})`);
  assert.deepEqual(JSON.parse(JSON.stringify(call('null', 25))), { nextLevel: 1, alert: false });
  assert.deepEqual(JSON.parse(JSON.stringify(call('null', 25, true, false))), { nextLevel: 0, alert: false });
  assert.deepEqual(JSON.parse(JSON.stringify(call('0', 21))), { nextLevel: 1, alert: true });
  assert.deepEqual(JSON.parse(JSON.stringify(call('0', 21, true, false))), { nextLevel: 0, alert: false });
  assert.deepEqual(JSON.parse(JSON.stringify(call('1', 45, false))), { nextLevel: 1, alert: false });
  assert.deepEqual(JSON.parse(JSON.stringify(call('1', 45, true, false))), { nextLevel: 1, alert: false });
  assert.deepEqual(JSON.parse(JSON.stringify(call('1', 5))), { nextLevel: 0, alert: false });
});

await test('持仓暴涨候选必须经当前正余额确认，清仓或接口失败不提醒', async () => {
  const confirm = extractFunction(content, 'confirmHoldingStillOwned');
  const run = (apiResult, stillCached = true) => evaluate(
    [confirm],
    "confirmHoldingStillOwned('bsc', 'bsc:0xabc')",
    {
      holdingAlertConfirming: new Set(),
      syncHoldingWatchFromApi: async () => apiResult,
      holdingWatchMap: new Map(stillCached ? [['bsc:0xabc', { cost: 1 }]] : []),
    },
  );
  assert.equal(await run({ ok: true, present: true }), true);
  assert.equal(await run({ ok: true, present: false }), false);
  assert.equal(await run({ ok: false, present: false }), false);
  assert.equal(await run({ ok: true, present: true }, false), false);

  const handler = extractFunction(content, 'handleHoldingPriceUpdate');
  assert.ok(handler.startsWith('async function'));
  assert.ok(handler.includes('await confirmHoldingStillOwned(chain, key)'));
  assert.ok(handler.indexOf('await confirmHoldingStillOwned') < handler.indexOf('showRemindCard'));
  const sync = extractFunction(content, 'syncHoldingWatchFromApi');
  assert.ok(sync.includes('if (!(balance > 0)) continue'));
  assert.ok(sync.includes('present: expectedKey ? result.seen?.has(expectedKey) === true : null'));
  const start = extractFunction(content, 'startHoldingPoll');
  assert.ok(start.includes('await syncHoldingWatchFromApi()'));
});

await test('FOMO 退款/失败事件不再被未知类型过滤', () => {
  const fn = extractFunction(background, 'slimFomoEvent');
  const raw = {
    key: 'refund:1', eventType: 'FOMO_REFUND', ts: 1770000000000,
    handle: 'alice', chainName: 'BSC', tokenAddress: '0xabc', symbol: 'ABC',
    failReason: 'TRANSACTION_REVERTED',
  };
  const result = evaluate([fn], `slimFomoEvent(${JSON.stringify(raw)})`, {
    FOMO_FEED_TYPE: { FOMO_REFUND: 'refund' },
    FOMO_CHAIN_SLUG: { bsc: 'bsc' },
  });
  assert.equal(result.type, 'refund');
  assert.equal(result.comment, '链上交易失败 · TRANSACTION_REVERTED');
  assert.ok(background.includes("FOMO_REFUND: 'refund'"));
  assert.ok(content.includes("refund: { label: '退款/失败'"));
  assert.ok(popupHtml.includes('id="fomo-feed-refund"'));
});

await test('推送历史清洗危险字段、跨标签去重并限制为 100 条', () => {
  const functions = [
    extractFunction(background, 'cleanNotificationText'),
    extractFunction(background, 'normalizeNotificationHistoryItem'),
    extractFunction(background, 'notificationHistoryFingerprint'),
    extractFunction(background, 'mergeNotificationHistory'),
  ];
  const sanitized = evaluate(functions, `normalizeNotificationHistoryItem({
    id: 'safe-id', at: 1000, tag: '持仓暴涨\\u0000', symbol: 'TEST', label: '较购买成本',
    value: '+25%', dir: 'sideways', href: 'javascript:alert(1)'
  })`);
  assert.equal(sanitized.tag, '持仓暴涨');
  assert.equal(sanitized.dir, '');
  assert.equal(sanitized.href, '');

  const merged = evaluate(functions, `mergeNotificationHistory([
    { id: 'old', at: 1000, tag: '持仓暴涨', symbol: 'TEST', label: '较购买成本', value: '+25%', dir: 'up', href: '/sol/token/Abc123' }
  ], { id: 'new', at: 2000, tag: '持仓暴涨', symbol: 'TEST', label: '较购买成本', value: '+25%', dir: 'up', href: '/sol/token/Abc123' })`, {
    NOTIFICATION_HISTORY_MAX: 100,
  });
  assert.equal(merged.length, 1);

  const capped = evaluate(functions, `mergeNotificationHistory(
    Array.from({ length: 120 }, (_, i) => ({ id: String(i), at: i + 1, tag: '提醒', symbol: String(i), value: String(i) })),
    { id: 'latest', at: 9999, tag: '提醒', symbol: 'LATEST', value: '+1%' }
  )`, { NOTIFICATION_HISTORY_MAX: 100 });
  assert.equal(capped.length, 100);
  assert.equal(capped[0].id, 'latest');
  assert.ok(content.includes('recordNotificationHistory(info);'));
  assert.ok(content.includes("className = 'gdh-notification-launcher'"));
});

await test('持仓提醒读取 GMGN App 的逐链 holding_signal 开关', () => {
  const functions = [
    extractFunction(content, 'holdingSignalBoolean'),
    extractFunction(content, 'parseGmgnHoldingSignalConfig'),
  ];
  const wrapped = evaluate(functions, `parseGmgnHoldingSignalConfig({ code: 0, data: [
    { push_chain: 'sol', push_switch_dict: { holding_signal: true, hot_token: false } },
    { push_chain: 'bsc', push_switch_dict: { holding_signal: 0 } },
    { push_chain: 'base', push_switch_dict: { holding_signal: '1' } }
  ] })`);
  assert.deepEqual(JSON.parse(JSON.stringify(wrapped)), { sol: true, bsc: false, base: true });
  const direct = evaluate(functions, `parseGmgnHoldingSignalConfig([
    { push_chain: 'sol', push_switch_dict: { holding_signal: 'open' } },
    { push_chain: 'bsc', push_switch_dict: { holding_signal: 'close' } }
  ])`);
  assert.deepEqual(JSON.parse(JSON.stringify(direct)), { sol: true, bsc: false });
  assert.equal(evaluate(functions, "parseGmgnHoldingSignalConfig({ data: [{ chain: 'sol', enabled: true }] })"), null);
});

await test('GMGN App 通知配置请求使用官方默认空对象', () => {
  const sanitize = extractFunction(bridge, 'sanitizeHoldingConfig');
  const bridged = evaluate([sanitize], `sanitizeHoldingConfig({ code: 0, data: [
    { push_chain: 'sol', push_switch_dict: { holding_signal: '1', other: 'secret' } },
    { push_chain: 'eth', push_switch_dict: { holding_signal: '1' } }
  ] })`);
  assert.deepEqual(JSON.parse(JSON.stringify(bridged)), [
    { push_chain: 'sol', push_switch_dict: { holding_signal: '1' } },
  ]);
  assert.match(bridge, /HOLDING_CONFIG_URL[\s\S]*?body:\s*'\{\}'/);
  assert.match(bridge, /localStorage\.getItem\('tgInfo'\)/);
  assert.match(content, /document\.dispatchEvent\(new Event\(GMGN_HOLDING_CONFIG_REQUEST_EVENT\)\)/);
  assert.doesNotMatch(bridge, /body:\s*JSON\.stringify\(\{\s*push_chains:/);
});

await test('主世界在页面 WebSocket 创建前桥接 token_stat 且不新开连接', () => {
  const manifest = JSON.parse(read('manifest.json'));
  const mainBridge = manifest.content_scripts.find((item) => item.world === 'MAIN');
  assert.equal(mainBridge.run_at, 'document_start');
  assert.ok(bridge.includes("message?.channel !== 'token_stat'"));
  assert.ok(bridge.includes('new Proxy(nativeWebSocket'));
  assert.ok(!bridge.includes("new WebSocket('wss://ws.gmgn.ai"));
});

await test('仓位键保持 Solana 大小写并归一化 EVM', () => {
  const functions = [
    "const EVM_ADDR_RE = /^0x[a-fA-F0-9]{40}$/; const SOL_ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;",
    extractFunction(content, 'normalizeWalletAddress'),
    extractFunction(content, 'holdingKey'),
  ];
  const sol = 'AbCdEfGhijkLMNPQRSTUVWXYZ123456789';
  assert.equal(evaluate(functions, `holdingKey('sol', '${sol}')`), `sol:${sol}`);
  assert.equal(evaluate(functions, `holdingKey('bsc', '0xABCDEFabcdefABCDEFabcdefABCDEFabcdefABCD')`), 'bsc:0xabcdefabcdefabcdefabcdefabcdefabcdefabcd');
});

await test('权威对账只替换当前链并保留其他链', () => {
  const functions = [extractFunction(background, 'normalizeHoldingWatchItem'), extractFunction(background, 'mergeHoldingWatchList')];
  const current = [
    { chain: 'bsc', address: '0x1111111111111111111111111111111111111111', cost: 1, at: 1 },
    { chain: 'base', address: '0x2222222222222222222222222222222222222222', cost: 2, at: 2 },
  ];
  const incoming = [{ chain: 'bsc', address: '0x3333333333333333333333333333333333333333', cost: 3, at: 3 }];
  const result = evaluate(functions, `mergeHoldingWatchList(${JSON.stringify(current)}, 'bsc', ${JSON.stringify(incoming)}, true)`, { HOLDING_WATCH_PER_CHAIN_MAX: 100, Date });
  assert.equal(result.length, 2);
  assert.ok(result.some((x) => x.chain === 'base'));
  assert.ok(!result.some((x) => x.address.endsWith('1111')));
});

await test('虚拟列表增量合并不会删除未渲染行', () => {
  const functions = [extractFunction(background, 'normalizeHoldingWatchItem'), extractFunction(background, 'mergeHoldingWatchList')];
  const current = [{ chain: 'bsc', address: '0x1111111111111111111111111111111111111111', cost: 1, at: 1 }];
  const incoming = [{ chain: 'bsc', address: '0x3333333333333333333333333333333333333333', cost: 3, at: 3 }];
  const result = evaluate(functions, `mergeHoldingWatchList(${JSON.stringify(current)}, 'bsc', ${JSON.stringify(incoming)}, false)`, { HOLDING_WATCH_PER_CHAIN_MAX: 100, Date });
  assert.equal(result.length, 2);
});

await test('每条链独立保留 100 个仓位，活跃链不会挤掉其他链', () => {
  const functions = [extractFunction(background, 'normalizeHoldingWatchItem'), extractFunction(background, 'mergeHoldingWatchList')];
  const address = (n) => `0x${n.toString(16).padStart(40, '0')}`;
  const current = [
    ...Array.from({ length: 100 }, (_, i) => ({ chain: 'bsc', address: address(i + 1), at: i + 1 })),
    ...Array.from({ length: 100 }, (_, i) => ({ chain: 'base', address: address(i + 1001), at: i + 1 })),
  ];
  const incoming = Array.from({ length: 100 }, (_, i) => ({ chain: 'sol', address: address(i + 2001), at: 1000 + i }));
  const result = evaluate(functions, `mergeHoldingWatchList(${JSON.stringify(current)}, 'sol', ${JSON.stringify(incoming)}, true)`, { HOLDING_WATCH_PER_CHAIN_MAX: 100, Date });
  assert.equal(result.filter((x) => x.chain === 'bsc').length, 100);
  assert.equal(result.filter((x) => x.chain === 'base').length, 100);
  assert.equal(result.filter((x) => x.chain === 'sol').length, 100);
});

await test('追踪流新挂载虚拟行会继承已有插卡位移', () => {
  const fn = extractFunction(content, 'fomoFeedInsertionShift');
  const inserts = [
    { afterTop: 516, height: 66 },
    { afterTop: 516, height: 66 },
    { afterTop: 646.5, height: 66 },
    { afterTop: 712.5, height: 66 },
    { afterTop: 778.5, height: 66 },
    { afterTop: 844.5, height: 66 },
  ];
  assert.equal(evaluate([fn], `fomoFeedInsertionShift(451.5, ${JSON.stringify(inserts)})`), 0);
  assert.equal(evaluate([fn], `fomoFeedInsertionShift(838.5, ${JSON.stringify(inserts)})`), 330);
  assert.equal(evaluate([fn], `fomoFeedInsertionShift(903, ${JSON.stringify(inserts)})`), 396);
  assert.match(content, /scheduleFomoFeedRowReflow\(\);\s*\n\s*}\s*\n\s*if \(\!\(target instanceof Element\)/);
});

await test('GMGN 虚拟行的原生 transform 坐标不会被插件抹掉', () => {
  const transformFn = extractFunction(content, 'fomoFeedNativeTransformY');
  assert.equal(evaluate([transformFn], "fomoFeedNativeTransformY('translateY(129px)')"), 129);
  assert.equal(evaluate([transformFn], "fomoFeedNativeTransformY('translate3d(0px, 258px, 0px)')"), 258);
  assert.equal(evaluate([transformFn], "fomoFeedNativeTransformY('matrix(1, 0, 0, 1, 0, 64.5)')"), 64.5);

  const fixedRowFn = extractFunction(content, 'fomoFeedFixedRow');
  class FakeHTMLElement {
    constructor(style = {}, parentElement = null) {
      this.style = style;
      this.parentElement = parentElement;
      this.offsetHeight = 64.5;
      this.dataset = {};
    }
  }
  const result = evaluate([transformFn, fixedRowFn], `(() => {
    const wrap = new HTMLElement({
      position: 'absolute',
      top: '0px',
      height: '64.5px',
      transform: 'translateY(129px)',
    });
    const card = new HTMLElement({}, wrap);
    const row = fomoFeedFixedRow(card);
    return { top: row.top, h: row.h, transform: row.wrap.style.transform };
  })()`, { Number, HTMLElement: FakeHTMLElement });
  assert.deepEqual({ ...result }, { top: 129, h: 64.5, transform: 'translateY(129px)' });

  for (const name of ['clearFomoFeedShifts', 'refreshFomoFeedFixedRowShifts', 'layoutFomoFeedFixed']) {
    const fn = extractFunction(content, name);
    assert.ok(fn.includes('.style.translate'), `${name} must use independent style.translate`);
    assert.ok(!fn.includes('.style.transform ='), `${name} must preserve GMGN native transform`);
  }
});

await test('新 FOMO/Pump 推送直接插入且不再创建顶部暂存条', () => {
  const shiftFn = extractFunction(content, 'fomoFeedInsertionShift');
  assert.equal(evaluate([shiftFn], 'fomoFeedInsertionShift(0, [{ afterTop: 0, height: 66 }])'), 66);
  assert.match(content, /placements\.set\(ev\.key, \{ ev, anchor: 'head' \}\)/);
  assert.ok(content.includes('layoutFomoFeedFixed(cards, byAnchor, headItems);'));
  assert.ok(content.includes("headCard.insertAdjacentElement('beforebegin', el);"));
  assert.ok(content.includes("const headCard = withTs[0]?.el || cards[0];"));
  assert.match(extractFunction(content, 'layoutFomoFeedFixed'), /el\.dataset\.gdhFomoAfterTop = String\(rows\[0\]\.top\);/);
  assert.ok(!content.includes('gdh-fomofeed-pin'));
  assert.ok(!content.includes('fomo / Pump 推送'));
  assert.ok(!styles.includes('.gdh-fomofeed-pin'));
});

await test('长期缓存按容量淘汰最老条目', () => {
  const mapFn = extractFunction(content, 'setBoundedMap');
  const setFn = extractFunction(content, 'rememberBoundedSet');
  const result = evaluate([mapFn, setFn], `(() => {
    const map = new Map();
    setBoundedMap(map, 'a', 1, 2);
    setBoundedMap(map, 'b', 2, 2);
    setBoundedMap(map, 'c', 3, 2);
    const set = new Set();
    rememberBoundedSet(set, 'a', 2);
    rememberBoundedSet(set, 'b', 2);
    rememberBoundedSet(set, 'c', 2);
    return { map: [...map.keys()].join(','), set: [...set].join(',') };
  })()`);
  assert.equal(result.map, 'b,c');
  assert.equal(result.set, 'b,c');
  assert.ok(content.includes('setBoundedMap(fomoTrCache'));
  assert.ok(content.includes('setBoundedMap(fomoPnlCache'));
  assert.ok(content.includes('rememberBoundedSet(fomoFeedSeen'));
  assert.ok(background.includes('setBoundedMap(fomoCache'));
  assert.ok(background.includes('setBoundedMap(flapCache'));
  assert.ok(background.includes('setBoundedMap(supplyCache'));
});

await test('Robinhood 搜索底池优先使用当前池并兼容原生 ETH 与自定义计价币', () => {
  const fn = extractFunction(content, 'robinhoodSearchMeta');
  const currentPool = evaluate([fn], `robinhoodSearchMeta(
    { pool: { quote_symbol: 'WETH' } },
    { address: '0x1111111111111111111111111111111111111111', symbol: 'USDG' },
    { launchpad: { launch_quote_address: '0x1111111111111111111111111111111111111111' }, security: {} }
  )`);
  assert.equal(currentPool.poolSymbol, 'WETH');
  const nativePool = evaluate([fn], `robinhoodSearchMeta(
    {}, null,
    { launchpad: { launch_quote_address: '0x0000000000000000000000000000000000000000' }, security: {} }
  )`);
  assert.equal(nativePool.poolSymbol, 'ETH');
  const customPool = evaluate([fn], `robinhoodSearchMeta(
    {}, { address: '0x1111111111111111111111111111111111111111', symbol: 'NFLX' },
    { launchpad: { launch_quote_address: '0x1111111111111111111111111111111111111111' }, security: {} }
  )`);
  assert.equal(customPool.poolSymbol, 'NFLX');
});

await test('Robinhood 分红徽章只认 GMGN 税收分配的正分红值', () => {
  const fn = extractFunction(content, 'robinhoodSearchMeta');
  const marketingOnly = evaluate([fn], `robinhoodSearchMeta(
    { pool: { quote_symbol: 'ETH' } }, null,
    { security: { tax_allocation: { dividend: '0', marketing: '1' } } }
  )`);
  assert.equal(marketingOnly.dividend, false);
  const dividend = evaluate([fn], `robinhoodSearchMeta(
    { pool: { quote_symbol: 'ETH' } }, null,
    { security: { tax_allocation: { dividend: '0.09', marketing: '0.91' } } }
  )`);
  assert.equal(dividend.dividend, true);
  assert.equal(dividend.dividendShare, 0.09);
  const legacyField = evaluate([fn], `robinhoodSearchMeta(
    { pool: { quote_symbol: 'ETH' } }, null,
    { security: { dividend_tax: '0.2' } }
  )`);
  assert.equal(legacyField.dividend, true);
});

await test('Robinhood 底池与分红只扫描搜索弹层并适配新版中文占位符', () => {
  const scan = extractFunction(content, 'scanRobinhoodSearchBadges');
  const scopes = extractFunction(content, 'searchScopes');
  assert.ok(scan.includes("currentChain() !== 'robinhood'"));
  assert.ok(scan.includes('searchScopes().forEach'));
  assert.ok(!scan.includes('CARD_SELECTOR'));
  assert.ok(content.includes('input[placeholder*="合约"]'));
  assert.ok(content.includes('input[placeholder*="代币名"]'));
  assert.ok(scopes.includes("input.closest('.pi-modal-wrap"));
  assert.ok(scopes.includes('[role="dialog"]'));
  assert.ok(scopes.includes('[aria-modal="true"]'));
  assert.ok(scopes.includes('getBoundingClientRect()'));
  assert.ok(!scopes.includes('parentElement'));
  assert.ok(!scopes.includes('level <'));
  assert.ok(content.includes('/api/v1/token_fee_info/robinhood/'));
  assert.ok(content.includes('/api/v1/mutil_window_token_info?'));
  assert.ok(content.includes('robinhoodSearchPending.size >= 3'));
  assert.ok(content.includes("currentChain() !== 'bsc'"));
  assert.ok(styles.includes('html[data-theme="light"] .gdh-robinhood-pool'));
  assert.ok(styles.includes('[data-gdh-robinhood-room="1"]'));
});

await test('Robinhood 池信息同时保留 base 与 quote 合约地址供 RWA 精确匹配', () => {
  const fn = extractFunction(content, 'robinhoodSearchMeta');
  const meta = evaluate([fn], `robinhoodSearchMeta(
    {
      address: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', symbol: 'MEME',
      pool: {
        base_address: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        quote_address: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        quote_symbol: 'NVDA'
      }
    }, null, { security: {} }
  )`);
  assert.equal(meta.baseAddress, '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  assert.equal(meta.baseSymbol, 'MEME');
  assert.equal(meta.quoteAddress, '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
  assert.equal(meta.quoteSymbol, 'NVDA');
});

await test('RWA 目录只保留合法合约并压缩为资产浮窗所需字段', () => {
  const fn = extractFunction(background, 'compactRobinhoodRwaCatalog');
  const items = evaluate([fn], `compactRobinhoodRwaCatalog({ rwa: [
    { c: '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', s: 'NVDA', ds: '英伟达\\n资料', on: 101.5, r: 100, p: 1.5, l: 2000, v: 3000, cmc: 4000, cap: null, u: 50, sh: 0.5, dep: '06-09' },
    { c: 'not-an-address', s: 'FAKE', ds: '不能进入目录' },
    { c: '0xcccccccccccccccccccccccccccccccccccccccc', s: '', ds: '无代码' }
  ] })`);
  assert.deepEqual(JSON.parse(JSON.stringify(items)), [{
    address: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    symbol: 'NVDA',
    description: '英伟达 资料',
    onchainPrice: 101.5,
    referencePrice: 100,
    premiumPct: 1.5,
    liquidityUsd: 2000,
    volume24hUsd: 3000,
    onchainMarketCapUsd: 4000,
    referenceMarketCapUsd: null,
    onchainSupply: 50,
    referenceSharePct: 0.5,
    deployedAt: '06-09',
  }]);
  assert.ok(background.includes("message?.type === 'robinhood-rwa-catalog'"));
  assert.ok(background.includes('ROBINHOOD_RWA_CATALOG_TTL'));
});

await test('GMGN 详情只给地址命中的 RWA 池行加页面内资料浮窗', () => {
  const scan = extractFunction(content, 'scanRobinhoodRwaPoolLinks');
  assert.ok(scan.includes("[data-sentry-component=\"PoolInfo\"]"));
  assert.ok(scan.includes("[data-sentry-component=\"PairInfo\"]"));
  assert.ok(scan.includes('robinhoodRwaCatalog.get(address)'));
  assert.ok(scan.includes('shown !== expected'));
  assert.ok(scan.includes('return void clearRobinhoodRwaPoolLinks()'));
  assert.ok(!scan.includes('robinhoodRwaCatalog.get(expected)'));
  const open = extractFunction(content, 'openRobinhoodRwaPoolLink');
  assert.ok(open.includes("event.key !== 'Enter'"));
  assert.ok(open.includes("event.key === 'Escape'"));
  assert.ok(open.includes('showRobinhoodRwaPopover(target, asset)'));
  assert.ok(!open.includes('window.open'));
  const show = extractFunction(content, 'showRobinhoodRwaPopover');
  assert.ok(show.includes("popover.setAttribute('role', 'dialog')"));
  assert.ok(show.includes("'985monitor · RWA 资产'"));
  assert.ok(show.includes("'StonkFun · xStocks RWA'"));
  assert.ok(show.includes("['链上价'"));
  assert.ok(show.includes("['溢价'"));
  assert.ok(show.includes("['流动性'"));
  assert.ok(!content.includes('gdhRobinhoodRwaUrl'));
  assert.ok(!content.includes('https://www.985monitor.xyz/rwa/?asset='));
  const numberFn = extractFunction(content, 'formatRobinhoodRwaNumber');
  assert.equal(evaluate([numberFn], 'formatRobinhoodRwaNumber(null)'), '—');
  assert.ok(styles.includes('.gdh-robinhood-rwa-link::after'));
  assert.ok(styles.includes('.gdh-robinhood-rwa-popover'));
  assert.ok(styles.includes('html[data-theme="light"] .gdh-robinhood-rwa-link'));
});

await test('RWA 资产点击实际渲染本页浮窗且不会生成外部链接', () => {
  class FakeElement {
    constructor(tag = 'div') {
      this.tagName = tag.toUpperCase();
      this.children = [];
      this.attributes = {};
      this.dataset = {};
      this.style = {};
      this.className = '';
      this.parent = null;
      this.isConnected = false;
      this.listeners = {};
      this.textContent = '';
    }
    append(...nodes) {
      nodes.forEach((node) => {
        node.parent = this;
        node.isConnected = true;
        this.children.push(node);
      });
    }
    remove() {
      if (this.parent) this.parent.children = this.parent.children.filter((node) => node !== this);
      this.isConnected = false;
    }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    addEventListener(type, listener) { this.listeners[type] = listener; }
    contains(node) { return node === this || this.children.some((child) => child.contains(node)); }
    closest(selector) { return selector === '.gdh-robinhood-rwa-link' ? this : null; }
    getBoundingClientRect() { return { left: 20, right: 70, top: 30, width: 300, height: 260 }; }
  }
  const body = new FakeElement('body');
  body.isConnected = true;
  const document = { body, createElement: (tag) => new FakeElement(tag) };
  const asset = {
    address: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    symbol: 'NVDA', onchainPrice: 101.5, referencePrice: 100, premiumPct: 1.5,
    liquidityUsd: 2000, volume24hUsd: 3000, onchainMarketCapUsd: 4000,
    referenceMarketCapUsd: null, onchainSupply: 50, referenceSharePct: 0.5,
    deployedAt: '06-09', description: '英伟达资料',
  };
  const functions = [
    'formatRobinhoodRwaNumber', 'formatRobinhoodRwaMoney', 'closeRobinhoodRwaPopover',
    'positionRobinhoodRwaPopover', 'showRobinhoodRwaPopover', 'openRobinhoodRwaPoolLink',
  ].map((name) => extractFunction(content, name));
  const result = evaluate(functions, `(() => {
    const anchor = new Element('span');
    anchor.className = 'gdh-robinhood-rwa-link';
    anchor.dataset.gdhRobinhoodRwaAddress = '${asset.address}';
    anchor.isConnected = true;
    anchor.getBoundingClientRect = () => ({ left: 900, right: 950, top: 30, width: 50, height: 20 });
    const before = location.href;
    const event = { type: 'click', target: anchor, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; } };
    openRobinhoodRwaPoolLink(event);
    const popover = document.body.children[0];
    const flatten = (node) => [node.textContent].concat(node.children.flatMap(flatten)).join(' ');
    const tags = (node) => [node.tagName].concat(node.children.flatMap(tags));
    const snapshot = { role: popover.attributes.role, text: flatten(popover), tags: tags(popover), left: popover.style.left, prevented: event.prevented, stopped: event.stopped, href: location.href };
    closeRobinhoodRwaPopover();
    snapshot.closed = document.body.children.length === 0;
    snapshot.unchanged = before === location.href;
    return snapshot;
  })()`, {
    document,
    window: { innerWidth: 1024, innerHeight: 768 },
    location: { href: 'https://gmgn.ai/robinhood/token/0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
    Element: FakeElement,
    Node: FakeElement,
    robinhoodRwaCatalog: new Map([[asset.address, asset]]),
    robinhoodRwaPopover: null,
    robinhoodRwaPopoverAnchor: null,
  });
  assert.equal(result.role, 'dialog');
  assert.match(result.text, /NVDA/);
  assert.match(result.text, /链上价/);
  assert.match(result.text, /\$101\.5/);
  assert.match(result.text, /正股市值\s+—/);
  assert.ok(!result.tags.includes('A'));
  assert.ok(result.prevented && result.stopped && result.closed && result.unchanged);
  assert.ok(Number.parseFloat(result.left) < 900, '右侧空间不足时浮窗应显示在资产左侧');
});

await test('滚动期间推迟全量扫描且只保留一个静止后延时器', () => {
  const contentRun = extractFunction(content, 'runScheduledScan');
  const bridgeRun = extractFunction(bridge, 'runScheduledScan');
  const run = (fn) => {
    const state = { scans: 0, schedules: 0, wait: 0 };
    return evaluate([fn], `(() => {
    runScheduledScan();
    return { delay: scanDelayTimer, scans: state.scans, schedules: state.schedules, wait: state.wait };
  })()`, {
    scanRafId: 1,
    scanDelayTimer: 0,
    scrollingUntil: 500,
    scanScheduled: true,
    Date: { now: () => 150 },
    Math,
    state,
    window: { setTimeout: (_fn, ms) => { state.wait = ms; return 7; } },
    scheduleScan: () => { state.schedules += 1; },
    scanCards: () => { state.scans += 1; },
  });
  };
  const contentResult = run(contentRun);
  const bridgeResult = run(bridgeRun);
  assert.equal(`${contentResult.delay}|${contentResult.scans}|${contentResult.schedules}|${contentResult.wait}`, '7|0|0|350');
  assert.equal(`${bridgeResult.delay}|${bridgeResult.scans}|${bridgeResult.schedules}|${bridgeResult.wait}`, '7|0|0|350');
});

await test('追踪流 mutation 重排合帧且隐藏标签不全量扫描', () => {
  assert.ok(content.includes('const fomoFeedScrollTargets = new WeakSet();'));
  assert.ok(content.includes('scheduleFomoFeedRowReflow();\n      scheduleScan();'));
  assert.ok(!content.includes('refreshFomoFeedFixedRowShifts();\n      }\n      scheduleScan();'));
  assert.ok(content.includes("if (document.visibilityState === 'hidden') return;"));
  assert.ok(bridge.includes("if (document.visibilityState === 'hidden') return;"));
  assert.ok(content.includes("if (document.visibilityState !== 'hidden') scanVisibleCards();"));
});

await test('同一轮全量扫描复用追踪卡枚举并降低空闲兜底频率', () => {
  const fn = extractFunction(content, 'trackerCards');
  const state = { calls: 0 };
  const row = {};
  const result = evaluate([fn], `(() => {
    const first = trackerCards();
    const second = trackerCards();
    trackerCardsScanCacheActive = false;
    const third = trackerCards();
    return { same: first === second, first: first.length, third: third.length, calls: state.calls };
  })()`, {
    trackerCardsScanCache: null,
    trackerCardsScanCacheActive: true,
    TRACKER_ITEM_SELECTOR: 'item',
    TRACKER_DATA_SELECTOR: 'data',
    TRACKER_SYMBOL_CELL: 'symbol',
    TRACKER_MAKER_CELL: 'maker',
    document: {
      querySelectorAll: (selector) => {
        state.calls += 1;
        return selector === 'item' ? [row] : [];
      },
    },
    state,
    Set,
    HTMLElement: class {},
  });
  assert.equal(`${result.same}|${result.first}|${result.third}|${result.calls}`, 'true|1|1|6');
  assert.match(content, /window\.setInterval\(\(\) => \{\s*if \(document\.visibilityState !== 'hidden'\) scanVisibleCards\(\);\s*\}, 2500\);/);
  assert.match(bridge, /window\.setInterval\(scheduleScan, 2500\);/);
});

await test('全部底池缓存有容量上限且 DeBot 滚动复用已知容器', () => {
  assert.ok(content.includes('const POOLS_CACHE_MAX = 60;'));
  assert.ok((content.match(/setBoundedMap\(\s*poolsState/g) || []).length >= 3);
  assert.ok(debotContent.includes('const feedScrollTargets = new WeakSet();'));
  assert.ok(debotContent.includes('feedScrollTargets.add(scroller);'));
  assert.match(debotContent, /document\.addEventListener\('scroll',[\s\S]{0,220}feedScrollTargets\.has\(event\.target\)/);
});

await test('FOMO/Pump 插卡主文字继承 GMGN 明暗主题', () => {
  assert.match(styles, /\.gdh-fomofeed\s*\{[\s\S]*?color:\s*inherit;/);
  assert.match(styles, /\.gdh-fomofeed__name\s*\{[\s\S]*?color:\s*inherit;/);
  assert.match(styles, /\.gdh-fomofeed__sym\s*\{[\s\S]*?color:\s*inherit;/);
  assert.match(styles, /\.gdh-fomofeed__symtext\s*\{[^}]*color:\s*inherit;/);
  assert.match(styles, /\.gdh-fomofeed:hover\s*\{\s*background:\s*color-mix\(in srgb, currentColor 4%, transparent\);\s*\}/);
  assert.ok(!styles.includes('.gdh-fomofeed__name {\n  font-weight: 600; color: #f5f5f5;'));
  assert.ok(!styles.includes('.gdh-fomofeed__sym {\n  color: #e8ecf3;'));
});

await test('Pump 成交按已验证字段瘦身并映射到 GMGN 链', () => {
  const functions = [
    extractFunction(background, 'pumpFeedHttpsUrl'),
    extractFunction(background, 'pumpFeedChainSlug'),
    extractFunction(background, 'slimPumpEvent'),
  ];
  const event = {
    key: 'pump:trade:tx1', eventType: 'PUMP_TRADE', createdAt: '2026-08-31T00:00:00Z',
    content: { pumpTrade: {
      wallet: 'BY58Z7N5Adarkx5ed78AzKvR7Kxrq795aa1boZsYyVBT', username: 'QuantJB',
      side: 'buy', mint: 'HbF1o9Mgwibv9JcQzEVUs52d9z1ibYQpdx8bY8Ntpump', symbol: 'DUVAL',
      amountUsd: 25, marketCapUsd: 7354, chainName: 'Solana', avatar: '/pump-avatars/a.png',
      image: 'https://ipfs.io/ipfs/token', tradeTime: '2026-08-31T00:00:01Z', tx: 'TxSignature1',
    } },
  };
  const result = evaluate(functions, `slimPumpEvent(${JSON.stringify(event)})`, { Date, encodeURIComponent });
  assert.equal(result.source, 'pump');
  assert.equal(result.chain, 'sol');
  assert.equal(result.type, 'buy');
  assert.equal(result.usd, 25);
  assert.equal(result.avatar, 'https://www.985monitor.xyz/pump-avatars/a.png');
  assert.equal(result.pumpWallet, event.content.pumpTrade.wallet);
  assert.equal(result.tx, 'TxSignature1');
  assert.equal(evaluate(functions, `slimPumpEvent(${JSON.stringify({ ...event, eventType: 'NEW_TWEET' })})`, { Date, encodeURIComponent }), null);
});

await test('FOMO 与 Pump 同一链上交易只保留一个语义身份', () => {
  const functions = [
    extractFunction(content, 'trackingFeedNormalizedAddress'),
    extractFunction(content, 'trackingFeedNormalizedTx'),
    extractFunction(content, 'trackingFeedEventIdentity'),
  ];
  const tx = '0xABCDEF1234';
  const fomo = { key: 'fomo:a', source: 'fomo', type: 'buy', tx };
  const pump = { key: 'pump:b', source: 'pump', type: 'buy', tx: tx.toLowerCase() };
  const fomoId = evaluate(functions, `trackingFeedEventIdentity(${JSON.stringify(fomo)})`);
  const pumpId = evaluate(functions, `trackingFeedEventIdentity(${JSON.stringify(pump)})`);
  assert.equal(fomoId, pumpId);
  assert.equal(fomoId, 'tx:0xabcdef1234');
});

await test('SSE 重放同一交易即使换 key 也只通知一次', () => {
  const functions = [
    extractFunction(background, 'slimFomoEvent'),
    extractFunction(background, 'trackingFeedComparableId'),
    extractFunction(background, 'trackingFeedNormalizedAddress'),
    extractFunction(background, 'trackingFeedBurstDuplicate'),
    extractFunction(background, 'trackingFeedDuplicate'),
    extractFunction(background, 'applyFomoRankSnapshotToEvent'),
    extractFunction(background, 'fomoSseIngest'),
  ];
  const raw = {
    key: 'fomo:first', eventType: 'FOMO_BUY', ts: 1770000000000,
    chainName: 'BSC', tokenAddress: '0x1111111111111111111111111111111111111111',
    handle: 'alice', usd: 100, txHash: '0xABCDEF',
  };
  const state = { calls: 0 };
  const result = evaluate(functions, `(() => {
    fomoSseIngest(${JSON.stringify(raw)});
    fomoSseIngest(${JSON.stringify({ ...raw, key: 'fomo:replayed' })});
    return { calls: state.calls, length: fomoFeedCache.events.length, key: fomoFeedCache.events[0].key };
  })()`, {
    Date,
    FOMO_FEED_TYPE: { FOMO_BUY: 'buy' },
    FOMO_CHAIN_SLUG: { bsc: 'bsc' },
    FOMO_FEED_KEEP: 150,
    TRACKING_FEED_BURST_MS: 20000,
    fomoFeedCache: { events: [], updatedAt: 0, fetchedAt: 0 },
    fomoRankSnapshot: { updatedAt: 0, ranks: new Map() },
    state,
    fomoSseNotifyTabs: () => { state.calls += 1; },
  });
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { calls: 1, length: 1, key: 'fomo:replayed' });
});

await test('插件连续同源近额成交在 20 秒内只保留最新一条', () => {
  const contentFunctions = [
    extractFunction(content, 'trackingFeedNormalizedAddress'),
    extractFunction(content, 'trackingFeedBurstDuplicate'),
  ];
  const base = {
    key: 'fomo:new', source: 'fomo', type: 'buy', handle: 'trenchc908',
    addr: '0x1111111111111111111111111111111111111111', chain: 'bsc', ts: 100000, usd: 148,
  };
  const duplicate = { ...base, key: 'fomo:old', ts: 95000, usd: 147 };
  const run = (other) => evaluate(
    contentFunctions,
    `trackingFeedBurstDuplicate(${JSON.stringify(base)}, ${JSON.stringify(other)})`,
    { TRACKING_FEED_BURST_MS: 20000 },
  );
  assert.equal(run(duplicate), true);
  assert.equal(run({ ...duplicate, ts: 79000 }), false);
  assert.equal(run({ ...duplicate, usd: 120 }), false);
  assert.equal(run({ ...duplicate, type: 'sell' }), false);
  assert.equal(run({ ...duplicate, handle: 'another-wallet' }), false);
  assert.equal(run({ ...duplicate, addr: '0x2222222222222222222222222222222222222222' }), false);

  const backgroundFunctions = [
    extractFunction(background, 'trackingFeedComparableId'),
    extractFunction(background, 'trackingFeedNormalizedAddress'),
    extractFunction(background, 'trackingFeedBurstDuplicate'),
    extractFunction(background, 'trackingFeedDuplicate'),
    extractFunction(background, 'dedupeTrackingFeedEvents'),
  ];
  const unique = { ...base, key: 'fomo:unique', tx: '0x3', ts: 70000 };
  const deduped = evaluate(
    backgroundFunctions,
    `dedupeTrackingFeedEvents(${JSON.stringify([
      { ...base, tx: '0x2' }, { ...duplicate, tx: '0x1' }, unique,
    ])})`,
    { TRACKING_FEED_BURST_MS: 20000 },
  );
  assert.equal(deduped.length, 2);
  assert.equal(deduped[0].key, 'fomo:new');
  assert.equal(deduped[1].key, 'fomo:unique');
  assert.ok(extractFunction(background, 'fetchFomoFeed').includes('dedupeTrackingFeedEvents'));
  assert.ok(extractFunction(background, 'fetchPumpFeed').includes('dedupeTrackingFeedEvents'));
});

await test('插入事件会与 GMGN 原生追踪交易去重且不误伤观点事件', () => {
  const functions = [
    extractFunction(content, 'trackingFeedNormalizedAddress'),
    extractFunction(content, 'trackingFeedNormalizedTx'),
    extractFunction(content, 'trackingFeedIsNativeDuplicate'),
  ];
  const exact = { source: 'pump', type: 'buy', tx: '0xABC' };
  assert.equal(evaluate(functions, `trackingFeedIsNativeDuplicate(${JSON.stringify(exact)}, { tx: '0xabc' })`), true);

  const fomo = { source: 'fomo', type: 'buy', addr: '0xABCDEF', chain: 'bsc', ts: 100000, usd: 100 };
  const row = { addr: '0xabcdef', chain: 'bsc', side: 'buy', ts: 110000, usd: 103 };
  assert.equal(evaluate(functions, `trackingFeedIsNativeDuplicate(${JSON.stringify(fomo)}, ${JSON.stringify(row)})`), true);
  assert.equal(evaluate(functions, `trackingFeedIsNativeDuplicate(${JSON.stringify({ ...fomo, type: 'thesis' })}, ${JSON.stringify(row)})`), false);
  assert.equal(evaluate(functions, `trackingFeedIsNativeDuplicate(${JSON.stringify({ ...fomo, usd: 130 })}, ${JSON.stringify(row)})`), false);

  const pump = { source: 'pump', type: 'sell', addr: 'SolMint', chain: 'sol', ts: 100000, usd: 50, pumpWallet: 'Maker1' };
  const pumpRow = { addr: 'SolMint', chain: 'sol', side: 'sell', ts: 101000, usd: 50, maker: 'Maker1' };
  assert.equal(evaluate(functions, `trackingFeedIsNativeDuplicate(${JSON.stringify(pump)}, ${JSON.stringify(pumpRow)})`), true);
  assert.equal(evaluate(functions, `trackingFeedIsNativeDuplicate(${JSON.stringify({ ...pump, pumpWallet: 'Maker2' })}, ${JSON.stringify(pumpRow)})`), false);
});

await test('页面桥透出原生交易指纹并在虚拟行回收时清掉旧值', () => {
  for (const field of ['transaction_hash', 'amount_usd', 'data-gdh-track-tx', 'data-gdh-track-side', 'data-gdh-track-usd']) {
    assert.ok(bridge.includes(field), `missing tracker field ${field}`);
  }
  assert.match(bridge, /'data-gdh-track-usd', 'data-gdh-track-ts',[\s\S]*element\.removeAttribute\(attr\)/);
});

await test('页面桥只把完整成交记录识别为追踪行并兼容 token_address 变体', () => {
  const fn = extractFunction(bridge, 'readTrackerRecord');
  const run = (record) => evaluate([fn], `(() => {
    const element = {};
    element['__reactFiber$test'] = { memoizedProps: { record: ${JSON.stringify(record)} } };
    return readTrackerRecord(element);
  })()`);
  assert.equal(run({ base_address: '0xdead', symbol: 'NOT_A_TRADE' }), null);
  const result = run({
    token_address: '0xabc', base_token: { symbol: 'ABC' }, chain: 'bsc',
    maker_info_address: '0xmaker', side: 'buy', timestamp: 1700000000,
    transaction_hash: '0xtx', amount_usd: 12.5,
  });
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    address: '0xabc', symbol: 'ABC', chain: 'bsc', maker: '0xmaker', nick: '',
    side: 'buy', tx: '0xtx', usd: 12.5, ts: 1700000000000, mc: 0,
  });
  const conflicting = run({
    token_address: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    base_address: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    base_symbol: 'YURI', chain: 'robinhood', maker: '0xmaker',
    side: 'sell', timestamp: 1700000000,
  });
  assert.equal(conflicting.address, '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
  assert.equal(conflicting.symbol, 'YURI');
});

await test('追踪流同时适配卡片、表格和无 testid 布局', () => {
  assert.ok(content.includes('TRACKER_TABLE_ITEM_SELECTOR'));
  assert.ok(content.includes('TRACKER_DATA_SELECTOR'));
  assert.ok(content.includes('fixed.h <= 50'));
  assert.ok(bridge.includes("row.firstElementChild"));
  assert.match(bridge, /querySelectorAll\(TRACKER_TABLE_ITEM_SELECTOR\)[\s\S]*trackerSeen\.add\(candidate\)/);
  assert.ok(bridge.includes('scanUnmarkedTrackerRows'));
  assert.match(bridge, /if \(!trackerSeen\.size\) scanUnmarkedTrackerRows\(trackerSeen, trackerData\)/);
  assert.match(bridge, /value\.maker[\s\S]*side === 'buy'[\s\S]*timestamp > 0/);
});

await test('GMGN 追踪卡片用文字、列表用红绿符号标记当前币与同名币', () => {
  const functions = [
    extractFunction(content, 'trackingFeedNormalizedAddress'),
    extractFunction(content, 'trackerTokenSymbol'),
    extractFunction(content, 'trackerTokenRelation'),
  ];
  const context = {
    chain: 'robinhood', address: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', symbol: 'FSD',
  };
  const run = (address, symbol, chain = 'robinhood') => evaluate(
    functions,
    `trackerTokenRelation(${JSON.stringify(address)}, ${JSON.stringify(symbol)}, ${JSON.stringify(chain)}, ${JSON.stringify(context)})`,
  );
  assert.equal(run('0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 'FSD'), 'current');
  assert.equal(run('0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 'OTHER'), '');
  assert.equal(run('0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'ＦＳＤ'), 'same-name');
  assert.equal(run('0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'OTHER'), '');
  assert.equal(run('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'FSD', 'base'), 'same-name');
  const apply = extractFunction(content, 'applyTrackerTokenRelation');
  assert.ok(apply.includes("'.gdh-fomofeed__tsym'"));
  assert.ok(apply.includes("'.gdh-fomofeed__r1'"));
  assert.ok(apply.includes('TRACKER_SYMBOL_CELL'));
  assert.ok(apply.includes('trackerCardTimeRow(card)'));
  assert.ok(apply.includes("relation === 'current' ? '●' : '◆'"));
  assert.ok(apply.includes('badge.title = relationLabel'));
  assert.ok(extractFunction(content, 'scanVisibleCards').includes("timed('token-relation', scanTrackerTokenRelations)"));
  assert.ok(extractFunction(content, 'fomoFeedCardFor').includes('applyTrackerTokenRelation'));
  const pageContextFns = [
    extractFunction(content, 'trackingFeedNormalizedAddress'),
    extractFunction(content, 'trackerTokenSymbol'),
    extractFunction(content, 'trackerTokenPageContext'),
  ];
  const staleContext = evaluate(pageContextFns, 'trackerTokenPageContext()', {
    currentTokenRoute: () => context,
    document: { querySelector: (selector) => selector.startsWith('#token-base-address')
      ? { dataset: { addr: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' } }
      : { dataset: { symbol: 'OLD' }, textContent: 'OLD' } },
  });
  assert.equal(staleContext, null);
  assert.match(styles, /\.gdh-token-relation\.is-current[\s\S]*?color:\s*#43c07a/);
  assert.match(styles, /\.gdh-token-relation\.is-same-name[\s\S]*?color:\s*#ef5350/);
  assert.match(styles, /\.gdh-token-relation\.is-table[\s\S]*?min-width:\s*10px[\s\S]*?background:\s*transparent/);
});

await test('追踪列表相似币按币名或 ticker 九成相似度匹配，并与当前币共同排序', () => {
  const functions = [
    extractFunction(content, 'trackingFeedNormalizedAddress'),
    extractFunction(content, 'similarTokenNormalizedName'),
    extractFunction(content, 'similarTokenSimilarity'),
    extractFunction(content, 'similarTokenRows'),
  ];
  assert.equal(evaluate(functions.slice(1, 3), "similarTokenSimilarity('Leveraged.lol', 'leveraged lol')"), 1);
  assert.equal(evaluate(functions.slice(1, 3), "similarTokenSimilarity('abcdefghij', 'abcdefghiX')"), 0.9);
  assert.equal(evaluate(functions.slice(1, 3), "similarTokenSimilarity('abcdefghij', 'abcdefghXX')"), 0.8);

  const current = { chain: 'eth', address: '0xcurrent', name: 'Leveraged.lol' };
  const rows = [
    { chain: 'base', address: '0xlow', name: 'Leveraged lol', symbol: 'LEV1', marketCap: 12000, poolSymbol: 'WETH' },
    { chain: 'bsc', address: '0xhigh', name: 'Leveraged.lol', symbol: 'LEV2', marketCap: 88000, poolSymbol: 'WBNB' },
    { chain: 'bsc', address: '0xhigh', name: 'Leveraged.lol', symbol: 'LEV2', marketCap: 87000, poolSymbol: 'WBNB' },
    { chain: 'sol', address: 'other', name: 'Unrelated token', symbol: 'NO', marketCap: 999000, poolSymbol: 'SOL' },
  ];
  const result = evaluate(functions, `similarTokenRows(${JSON.stringify(current)}, ${JSON.stringify(rows)})`);
  assert.deepEqual(JSON.parse(JSON.stringify(result.map((item) => item.address))), ['0xhigh', '0xlow', '0xcurrent']);
  assert.equal(result[0].poolSymbol, 'WBNB');
  const flybook = { chain: 'base', address: '0xbase', name: 'The Flybook', symbol: 'FLYBOOK', marketCap: 200000 };
  const peers = [{ chain: 'robinhood', address: '0xpeer', name: 'flybook', symbol: 'FLYBOOK', marketCap: 130000 }];
  const sameTicker = evaluate(functions, `similarTokenRows(${JSON.stringify(flybook)}, ${JSON.stringify(peers)})`);
  assert.deepEqual(JSON.parse(JSON.stringify(sameTicker.map((item) => item.address))), ['0xbase', '0xpeer']);
  assert.equal(evaluate(functions, `similarTokenRows(${JSON.stringify(flybook)}, [${JSON.stringify(flybook)}]).length`), 0);

  const meta = evaluate([
    extractFunction(content, 'trackingFeedNormalizedAddress'),
    extractFunction(content, 'similarTokenMetaFromApi'),
  ], `similarTokenMetaFromApi(${JSON.stringify({
    address: '0xABC', name: 'Ethereum Cat', symbol: 'ETHCAT', logo: 'https://gmgn.ai/icon.webp',
    total_supply: '1000000', price: { price: '0.0125' },
    pool: { quote_symbol: 'WETH', exchange: 'uniswap_v3' },
  })}, 'eth')`);
  assert.equal(meta.marketCap, 12500);
  assert.equal(meta.poolSymbol, 'WETH');
  assert.equal(meta.poolExchange, 'uniswap v3');
  const request = extractFunction(content, 'requestSimilarTokenMeta');
  assert.ok(request.includes('https://gmgn.ai/api/v1/mutil_window_token_info'));
  assert.ok(!request.includes('985monitor'));
});

await test('相似币浮窗默认关闭、设置带 NEW 标记并接入主扫描', () => {
  assert.match(content, /enableSimilarTokenPanel:\s*false/);
  assert.match(popup, /enableSimilarTokenPanel:\s*false/);
  assert.ok(popup.includes("enableSimilarTokenPanel: document.querySelector('#enable-similar-token-panel')"));
  assert.match(popupHtml, /同名 \/ 相似币浮窗[\s\S]*?class="new-badge"[\s\S]*?id="enable-similar-token-panel"/);
  assert.match(popupStyles, /\.new-badge\s*\{/);
  assert.ok(extractFunction(content, 'scanVisibleCards').includes("timed('similar-token-panel', scanSimilarTokenPanel)"));
  assert.match(content, /GDH_SELF_SELECTOR[^;]+\.gdh-similar-token-panel/);
  assert.match(styles, /\.gdh-similar-token-panel\s*\{[\s\S]*?position:\s*fixed/);
  assert.match(styles, /\.gdh-similar-token__pool\s*\{/);
});

await test('GMGN 白色主题的 Fomo 标签与徽章颜色可配置且保持对比度', () => {
  for (const id of ['fomo-label-color', 'rank-badge-color', 'marked-badge-color']) {
    assert.ok(popupHtml.includes(`id="${id}"`));
  }
  assert.ok(popup.includes('badgeColorInputs'));
  assert.ok(popup.includes('badgeColors: Object.fromEntries'));
  const scanCards = extractFunction(content, 'scanCards');
  for (const cssVar of ['--gdh-fomo-accent', '--gdh-rank-accent', '--gdh-marked-accent']) {
    assert.ok(scanCards.includes(cssVar));
  }
  assert.match(styles, /html\[data-theme="light"\][\s\S]*?--gdh-fomo-ink:[^;]+#111827/);
  assert.match(styles, /\.gdh-token-header-fomo[\s\S]*?var\(--gdh-fomo-ink\)/);
  assert.match(styles, /\.gdh-fomofeed__rank[\s\S]*?var\(--gdh-rank-ink\)/);
  assert.match(styles, /\.gdh-marked[\s\S]*?var\(--gdh-marked-ink\)/);

  const channel = (value) => {
    const normalized = value / 255;
    return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  };
  const luminance = ([r, g, b]) => (0.2126 * channel(r)) + (0.7152 * channel(g)) + (0.0722 * channel(b));
  const mixForLightTheme = (hex) => {
    const accent = [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16));
    const dark = [0x11, 0x18, 0x27];
    return accent.map((value, index) => Math.round((value * 0.4) + (dark[index] * 0.6)));
  };
  const contrastOnWhite = (rgb) => 1.05 / (luminance(rgb) + 0.05);
  for (const color of ['#6d4ed4', '#7c3aed', '#0f766e', '#ffffff', '#ffff00']) {
    assert.ok(contrastOnWhite(mixForLightTheme(color)) >= 4.5, `${color} contrast is too low`);
  }
});

await test('GMGN 特别关注按交易哈希或绝对事件时间去重', () => {
  const signatureFn = extractFunction(content, 'trackerCardSignature');
  const run = (dataset, actionText, amount) => evaluate(
    [signatureFn],
    `trackerCardSignature({
      dataset: ${JSON.stringify(dataset)},
      getAttribute: () => '/robinhood/token/0x1111111111111111111111111111111111111111',
      querySelector: () => ({ textContent: ${JSON.stringify(amount)} })
    }, '0x2222222222222222222222222222222222222222')`,
    { findCardActionContainer: () => ({ children: [{ tagName: 'SPAN', textContent: actionText }] }) },
  );

  const stable = {
    gdhTrackTx: '0xabc123',
    gdhTrackAddr: '0x1111111111111111111111111111111111111111',
    gdhTrackSide: 'buy',
    gdhTrackTs: '1788339600123',
  };
  assert.equal(run(stable, '买入 fomo 43s', '$100'), run(stable, '买入 fomo 44s', '$101'));
  assert.equal(run(stable, '买入 fomo 43s', '$100'), '0x2222222222222222222222222222222222222222|tx:0xabc123');

  const fallback = { ...stable, gdhTrackTx: '' };
  assert.equal(run(fallback, '买入 43s', '$100'), run(fallback, '买入 44s', '$101'));
  assert.match(run(fallback, '买入 43s', '$100'), /\|buy\|1788339600123$/);
  assert.equal(run({ gdhTrackAddr: stable.gdhTrackAddr }, '买入 43s', '$100'), '');
  assert.match(extractFunction(content, 'scanPinnedPush'), /if \(!sig\) return;/);
});

await test('重点 Dev 高亮开关不再充当 FOMO/Pump 插卡总开关', () => {
  assert.ok(extractFunction(content, 'applyCardState').includes('settings.enabled'));
  assert.ok(!extractFunction(content, 'pollFomoFeed').includes('settings.enabled'));
  assert.ok(!extractFunction(content, 'pollPumpFeed').includes('settings.enabled'));
  assert.ok(!extractFunction(content, 'scanFomoFeed').includes('settings.enabled'));
  assert.ok(!extractFunction(debotContent, 'visibleFeedEvents').includes('settings.enabled'));
  assert.ok(!extractFunction(debotContent, 'layoutFeed').includes('settings.enabled'));
  assert.ok(!extractFunction(debotContent, 'layoutSidebarFeed').includes('settings.enabled'));
  assert.ok(!extractFunction(debotContent, 'pollFomo').includes('settings.enabled'));
  assert.ok(!extractFunction(debotContent, 'pollPump').includes('settings.enabled'));
});

await test('GMGN SPA 误跳主页时仍会回退到正确代币路径', () => {
  const fn = extractFunction(content, 'gdhSpaNavigate');
  const target = '/robinhood/token/0x65eeaf07b545c9560dcbd8a72f239fa1ab961501';
  const location = { origin: 'https://gmgn.ai', pathname: '/follow', href: '' };
  let nav = '';
  evaluate([fn], `gdhSpaNavigate('${target}')`, {
    location,
    URL,
    Event: class Event {},
    document: {
      documentElement: { setAttribute: (_name, value) => { nav = value; }, removeAttribute() {} },
      dispatchEvent: () => { location.pathname = '/'; },
    },
    window: { setTimeout: (callback) => callback() },
  });
  assert.equal(nav, target);
  assert.equal(location.href, target);
});

await test('DeBot 只注入追踪、FOMO 与独立 Brew 浮窗模块', () => {
  assert.ok(manifest.host_permissions.includes('https://debot.ai/*'));
  const debotScripts = manifest.content_scripts.filter((entry) => entry.matches.includes('https://debot.ai/*'));
  assert.equal(debotScripts.length, 2);
  const main = debotScripts.find((entry) => entry.world === 'MAIN');
  const isolated = debotScripts.find((entry) => entry.world !== 'MAIN');
  assert.deepEqual(main.js, ['debot-bridge.js']);
  assert.deepEqual(isolated.js, ['debot-content.js', 'brew-content.js']);
  assert.deepEqual(isolated.css, ['debot-styles.css', 'brew-styles.css']);
  assert.ok(!isolated.js.includes('content.js'));
  for (const file of ['debot-bridge.js', 'debot-content.js', 'debot-styles.css']) {
    assert.ok(releaseBuild.includes(`'${file}'`), `release missing ${file}`);
  }
});

await test('DeBot 登录与未登录代币路由都能提取真实地址', () => {
  const fn = extractFunction(debotContent, 'debotTokenRoute');
  const evm = '0xfdae23ce76018da62507bb5ef20e6ef5450e8312';
  const base = { FOMO_NETWORK_ID: { robinhood: 4663, sol: 1399811149 } };
  const direct = evaluate([fn], 'debotTokenRoute()', {
    ...base, location: { pathname: `/token/robinhood/${evm}` }, decodeURIComponent,
  });
  const invited = evaluate([fn], 'debotTokenRoute()', {
    ...base, location: { pathname: `/token/robinhood/invite985_${evm}` }, decodeURIComponent,
  });
  const sol = 'HbF1o9Mgwibv9JcQzEVUs52d9z1ibYQpdx8bY8Ntpump';
  const solRoute = evaluate([fn], 'debotTokenRoute()', {
    ...base, location: { pathname: `/token/sol/invite985_${sol}` }, decodeURIComponent,
  });
  assert.deepEqual(JSON.parse(JSON.stringify(direct)), { chain: 'robinhood', address: evm, networkId: 4663 });
  assert.deepEqual(JSON.parse(JSON.stringify(invited)), { chain: 'robinhood', address: evm, networkId: 4663 });
  assert.deepEqual(JSON.parse(JSON.stringify(solRoute)), { chain: 'sol', address: sol, networkId: 1399811149 });
});

await test('DeBot 主世界桥只接受完整追踪成交字段', () => {
  const functions = [
    extractFunction(debotBridge, 'safeString'),
    extractFunction(debotBridge, 'eventTimeMs'),
    extractFunction(debotBridge, 'normalizeTrackRecord'),
  ];
  const record = {
    token: '0xfdae23ce76018da62507bb5ef20e6ef5450e8312',
    chain: 'robinhood', trader: '0x1111111111111111111111111111111111111111',
    time: 1788220800, op: 'buy', volume: 123.45, tx: '0xabc', mc: 8_100_000,
  };
  const result = evaluate(functions, `normalizeTrackRecord(${JSON.stringify(record)})`);
  assert.equal(result.chain, 'robinhood');
  assert.equal(result.side, 'buy');
  assert.equal(result.ts, 1788220800000);
  assert.equal(result.usd, 123.45);
  assert.equal(evaluate(functions, `normalizeTrackRecord(${JSON.stringify({ ...record, trader: '' })})`), null);
  assert.equal(evaluate(functions, `normalizeTrackRecord(${JSON.stringify({ ...record, op: 'transfer' })})`), null);
  assert.match(debotBridge, /TrackContent[\s\S]*\{ token, chain, trader, time, op, volume, tx, mc \}/);
});

await test('DeBot 混排不向 React tbody 插未知节点且沿用单一后台事件流', () => {
  const layout = extractFunction(debotContent, 'layoutFeed');
  assert.ok(layout.includes("scroller.appendChild(card)"));
  assert.ok(layout.includes('row.style.translate'));
  assert.ok(layout.includes('table.style.marginBottom'));
  assert.ok(!layout.includes('tbody.appendChild'));
  assert.ok(debotContent.includes("type: 'fomo-feed'"));
  assert.ok(debotContent.includes("type: 'pump-feed'"));
  assert.ok(!debotContent.includes('new WebSocket'));
  assert.ok(!debotContent.includes('EventSource'));
  assert.ok(!debotContent.includes('/api/events-stream'));
  assert.equal((background.match(/api\/extension\/events-stream/g) || []).length, 1);
  assert.match(background, /\['https:\/\/gmgn\.ai\/\*', 'https:\/\/debot\.ai\/\*'\]/);
  assert.ok(debotStyles.includes('.gdh-debot-feed__row.is-absolute'));
});

await test('DeBot FOMO/Pump 事件按时间锚定原生行并限制顶部数量', () => {
  const fn = extractFunction(debotContent, 'debotFeedPlacementPlan');
  const rowTimes = [100_000, 80_000, 60_000, 40_000];
  const events = [
    ...Array.from({ length: 8 }, (_, index) => ({ key: `head-${index}`, ts: 110_000 - index })),
    { key: 'middle-a', ts: 90_000 },
    { key: 'middle-b', ts: 70_000 },
    { key: 'old', ts: 20_000 },
  ];
  const plan = evaluate([fn], `debotFeedPlacementPlan(${JSON.stringify(rowTimes)}, ${JSON.stringify(events)})`, {
    FEED_HEAD_CAP: 6,
    FEED_VISIBLE_CAP: 12,
  });
  assert.deepEqual(JSON.parse(JSON.stringify(plan.map((item) => [item.event.key, item.anchor]))), [
    ['head-0', 0], ['head-1', 0], ['head-2', 0], ['head-3', 0], ['head-4', 0], ['head-5', 0],
    ['middle-a', 1], ['middle-b', 2],
  ]);
});

await test('DeBot 左侧追踪面板在管理标签页也会混排且不写入 React 列表', () => {
  const routeFn = extractFunction(debotContent, 'isTrackShellPage');
  const tokenRouteFn = extractFunction(debotContent, 'debotTokenRoute');
  const tokenAddress = '0x65eeaf07b545c9560dcbd8a72f239fa1ab961501';
  const routeContext = { FOMO_NETWORK_ID: { robinhood: 4663 }, decodeURIComponent };
  assert.equal(evaluate([routeFn, tokenRouteFn], 'isTrackShellPage()', {
    ...routeContext, location: { pathname: '/track' },
  }), true);
  assert.equal(evaluate([routeFn, tokenRouteFn], 'isTrackShellPage()', {
    ...routeContext, location: { pathname: `/token/robinhood/${tokenAddress}` },
  }), true);
  assert.equal(evaluate([routeFn, tokenRouteFn], 'isTrackShellPage()', {
    ...routeContext, location: { pathname: '/market' },
  }), false);

  const planFn = extractFunction(debotContent, 'sidebarFeedPlacementPlan');
  const rowTimes = [100_000, 80_000, 60_000];
  const events = [
    ...Array.from({ length: 5 }, (_, index) => ({ key: `head-${index}`, ts: 110_000 - index })),
    { key: 'middle', ts: 70_000 },
  ];
  const plan = evaluate([planFn], `sidebarFeedPlacementPlan(${JSON.stringify(rowTimes)}, ${JSON.stringify(events)})`, {
    SIDEBAR_FEED_HEAD_CAP: 3,
    SIDEBAR_FEED_VISIBLE_CAP: 8,
  });
  assert.deepEqual(JSON.parse(JSON.stringify(plan.map((item) => [item.event.key, item.anchor]))), [
    ['head-0', 0], ['head-1', 0], ['head-2', 0], ['middle', 2],
  ]);
  const layout = extractFunction(debotContent, 'layoutSidebarFeed');
  assert.ok(debotContent.includes('[data-edge-dock-panel="track"]'));
  assert.ok(debotContent.includes('[data-testid="virtuoso-item-list"]'));
  assert.ok(layout.includes('layout.scroller.appendChild(card)'));
  assert.ok(layout.includes('row.style.translate'));
  assert.ok(layout.includes('layout.list.style.marginBottom'));
  assert.ok(!layout.includes('layout.list.appendChild'));
  assert.ok(debotContent.includes(':scope > tr[data-index][data-known-size]'));
  assert.ok(layout.includes("const mode = rows[0].tagName === 'TR' ? 'list' : 'card'"));
  assert.ok(layout.includes('Number(rows[0].dataset.knownSize)'));
  assert.ok(layout.includes("sidebarFeedCard(event, { mode, rowHeight, sampleRow: rows[0] })"));
  assert.match(debotContent, /async function pollFomo[\s\S]*if \(!isTrackShellPage\(\)/);
  assert.match(debotContent, /async function pollPump[\s\S]*if \(!isTrackShellPage\(\)/);
  assert.ok(debotStyles.includes('.gdh-debot-sidefeed__row'));
});

await test('DeBot FOMO/Pump 卡片复用邀请前缀并经主世界 SPA 跳转代币', () => {
  const mainCard = extractFunction(debotContent, 'buildFeedCard');
  const sidebarCard = extractFunction(debotContent, 'sidebarFeedCard');
  assert.ok(mainCard.includes("document.createElement('a')"));
  assert.ok(mainCard.includes('card.href = debotTokenHref(event.chain, event.addr)'));
  assert.ok(sidebarCard.includes("document.createElement('a')"));
  assert.ok(sidebarCard.includes('card.href = debotTokenHref(event.chain, event.addr)'));
  assert.ok(sidebarCard.includes('bindDebotNavigation(card)'));
  assert.ok(!mainCard.includes('location.assign'));
  assert.ok(!sidebarCard.includes('location.assign'));
  assert.ok(debotContent.includes("document.dispatchEvent(new CustomEvent('gdh-debot-navigate'"));
  assert.ok(debotBridge.includes("document.addEventListener('gdh-debot-navigate', navigateTokenRoute)"));
  assert.ok(debotBridge.includes("history.pushState(state, '',"));
  assert.ok(debotBridge.includes("window.dispatchEvent(new PopStateEvent('popstate'"));
  assert.ok(debotStyles.includes('text-decoration: none'));

  const prefixFn = extractFunction(debotContent, 'debotInvitePrefix');
  const hrefFn = extractFunction(debotContent, 'debotTokenHref');
  const token = '0x65eeaf07b545c9560dcbd8a72f239fa1ab961501';
  const href = evaluate([prefixFn, hrefFn], `debotTokenHref('robinhood', '${token}')`, {
    location: { origin: 'https://debot.ai', pathname: '/token/robinhood/0x8c63b6adfb469bbd0cd5d6ee64f73407f15f4c6c' },
    document: { querySelectorAll: () => [{ getAttribute: () => `/token/robinhood/231141_${token}` }] },
    safeText: (value, max) => String(value || '').slice(0, max),
    URL,
    decodeURIComponent,
    encodeURIComponent,
  });
  assert.equal(href, `/token/robinhood/231141_${token}`);
});

await test('DeBot 卡片与列表模式共享重点关注、调色、置顶和屏蔽名单', () => {
  assert.ok(debotContent.includes('enableSpecialWallet: true'));
  assert.ok(debotContent.includes('specialWallets: []'));
  assert.ok(debotContent.includes('function rebuildSpecialWalletMap()'));
  assert.ok(debotContent.includes('function applySpecialRow(row)'));
  assert.ok(debotContent.includes("row.tagName === 'TR'"));
  assert.ok(debotContent.includes('function pinSidebarRow(row)'));
  assert.ok(debotContent.includes('SPECIAL_PIN_MS = 10000'));
  assert.ok(debotContent.includes('function blockToken(address, symbol'));
  assert.ok(debotContent.includes('function unblockToken(address)'));
  assert.ok(debotStyles.includes('.gdh-debot-special-manage'));
  assert.ok(debotStyles.includes('.gdh-debot-special-pin-strip'));
  assert.ok(debotStyles.includes('.gdh-debot-sidefeed__row.is-list'));
});

await test('DeBot 特别关注使用绝对成交时间或交易哈希稳定去重', () => {
  const timestampFn = extractFunction(debotContent, 'debotAbsoluteTimestamp');
  const safeText = (value, max) => String(value ?? '').trim().slice(0, max);
  const now = new Date(2026, 8, 2, 6, 0, 0).getTime();
  const first = evaluate([timestampFn], `debotAbsoluteTimestamp('09/02 05:53:36', ${now})`, { safeText, Date });
  const later = evaluate([timestampFn], `debotAbsoluteTimestamp('09/02 05:53:36', ${now + 5000})`, { safeText, Date });
  assert.equal(first, later);
  assert.equal(first, new Date(2026, 8, 2, 5, 53, 36).getTime());
  const signature = extractFunction(debotContent, 'sidebarRowSignature');
  assert.ok(signature.includes('Math.round(ts / 1000)'));
  assert.ok(signature.includes('dataset.gdhDebotTrackTx'));
});

await test('DeBot 观点卡完整渲染正文并按实际高度让位', () => {
  const multilineFn = extractFunction(debotContent, 'safeMultilineText');
  assert.equal(evaluate([multilineFn], "safeMultilineText('第一行\\r\\n第二行')"), '第一行\n第二行');
  const sidebarCard = extractFunction(debotContent, 'sidebarFeedCard');
  const mainCard = extractFunction(debotContent, 'buildFeedCard');
  const heightFn = extractFunction(debotContent, 'measuredFeedCardHeight');
  const mainLayout = extractFunction(debotContent, 'layoutFeed');
  const sidebarLayout = extractFunction(debotContent, 'layoutSidebarFeed');
  assert.ok(sidebarCard.includes("comment.className = 'gdh-debot-sidefeed__comment'"));
  assert.ok(mainCard.includes("comment.className = 'gdh-debot-feed__comment'"));
  assert.ok(mainLayout.includes('measuredFeedCardHeight(card, FEED_ROW_HEIGHT)'));
  assert.ok(sidebarLayout.includes('measuredFeedCardHeight(card, rowHeight)'));
  assert.ok(debotStyles.includes('white-space: pre-wrap'));
  assert.ok(debotStyles.includes('.gdh-debot-sidefeed__row.has-comment'));
  assert.ok(background.includes(".slice(0, 1500)"));
  assert.equal(evaluate([heightFn], "measuredFeedCardHeight({ classList: { contains: () => true }, getBoundingClientRect: () => ({ height: 91.2 }), scrollHeight: 94 }, 67)"), 94);
  assert.equal(evaluate([heightFn], "measuredFeedCardHeight({ classList: { contains: () => false } }, 67)"), 67);
});

await test('DeBot 特别关注置顶复刻原生行而不是重新拼文本卡', () => {
  const clone = extractFunction(debotContent, 'cloneNativeSidebarRow');
  const pin = extractFunction(debotContent, 'pinSidebarRow');
  assert.ok(clone.includes('row.cloneNode(true)'));
  assert.ok(clone.includes(".gdh-debot-special-star, .gdh-debot-special-swatch"));
  assert.ok(pin.includes('cloneNativeSidebarRow(row)'));
  assert.ok(pin.includes("document.createElement('div')"));
  assert.ok(!pin.includes('item.textContent ='));
  assert.ok(debotStyles.includes('.gdh-debot-special-pin-native'));
});

await test('DeBot FOMO 小窗复用现有接口且登录入口不展示推荐码', () => {
  assert.ok(debotContent.includes("type: 'fomo-token-feed'"));
  assert.ok(debotContent.includes("type: 'fomo-user-pnl'"));
  assert.ok(debotContent.includes("type: 'token-supply'"));
  assert.ok(debotContent.includes("open.href = 'https://fomo.family/';"));
  assert.ok(debotContent.includes("window.open('https://fomo.family/r/Unipioneer'"));
  assert.ok(!debotContent.includes("textContent = 'Unipioneer'"));
  assert.ok(debotContent.includes("? '需要登录 fomo'"));
  assert.ok(debotContent.includes("['确认已登录', '未登录就完成登录；已经登录则刷新一次页面']"));
  assert.ok(debotContent.includes("['返回 DeBot', '插件会自动同步，不需要复制任何令牌']"));
  assert.ok(debotStyles.includes('.gdh-debot-fomo__guide-steps'));
  assert.ok(debotContent.includes("['holders', '持仓者']"));
  assert.ok(debotContent.includes("['thesis', '观点']"));
  assert.ok(debotContent.includes("['swaps', '交易']"));
});

await test('DeBot FOMO 持仓占比优先读取同源代币详情总供应量', async () => {
  const fn = extractFunction(debotContent, 'loadDebotTokenSupply');
  const address = '0xfdae23ce76018da62507bb5ef20e6ef5450e8312';
  const cache = new Map();
  const supply = await evaluate([fn], `loadDebotTokenSupply({ chain: 'robinhood', address: '${address}' })`, {
    debotSupplyCache: cache,
    location: { origin: 'https://debot.ai' },
    normalizeAddress: (value) => String(value || '').toLowerCase(),
    fetch: async (url, options) => {
      assert.equal(url.origin, 'https://debot.ai');
      assert.equal(url.pathname, '/api/dashboard/token/detail');
      assert.equal(url.searchParams.get('chain'), 'robinhood');
      assert.equal(url.searchParams.get('token'), address);
      assert.match(url.searchParams.get('request_id'), /^gdh_/);
      assert.equal(options.credentials, 'include');
      return {
        ok: true,
        json: async () => ({ code: 0, data: { pair: { chain: 'robinhood', tokenAddress: address, totalSupply: 1_000_000_000 } } }),
      };
    },
    URL,
    Date,
    Math,
  });
  assert.equal(supply, 1_000_000_000);
  assert.equal(cache.get(`robinhood|${address}`).supply, 1_000_000_000);
  assert.match(privacy, /DeBot 已公开展示的代币详情总供应量/);
});

await test('DeBot Robinhood 池资产按原生地址精确匹配 RWA 并显示同页浮窗', () => {
  const addressFn = extractFunction(debotContent, 'debotTokenAddressFromHref');
  const address = evaluate([addressFn], `debotTokenAddressFromHref(
    '/token/robinhood/231141_0x44c4f142009036cf477ed2d09932051843137cf1', 'robinhood'
  )`, {
    location: { origin: 'https://debot.ai' }, URL, decodeURIComponent,
  });
  assert.equal(address, '0x44c4f142009036cf477ed2d09932051843137cf1');
  assert.equal(evaluate([addressFn], `debotTokenAddressFromHref(
    '/token/base/0x44c4f142009036cf477ed2d09932051843137cf1', 'robinhood'
  )`, { location: { origin: 'https://debot.ai' }, URL, decodeURIComponent }), '');

  const scan = extractFunction(debotContent, 'scanDebotRwaPoolLinks');
  assert.ok(scan.includes("svg.tabler-icon-copy"));
  assert.ok(scan.includes('debotRwaCatalog.get(routeAddress)'));
  assert.ok(scan.includes('debotTokenAddressFromHref'));
  assert.ok(scan.includes('debotRwaCatalog.get(address)'));
  assert.ok(scan.includes('clearDebotRwaPoolLinks(kept)'));
  const mark = extractFunction(debotContent, 'markDebotRwaLink');
  assert.ok(mark.includes('shown !== expected'));
  assert.ok(mark.includes("node.classList.add('gdh-debot-rwa-link')"));
  const open = extractFunction(debotContent, 'openDebotRwaPoolLink');
  assert.ok(open.includes("event.key !== 'Enter'"));
  assert.ok(open.includes("event.key === 'Escape'"));
  assert.ok(open.includes('showDebotRwaPopover(target, asset)'));
  assert.ok(!open.includes('window.open'));
  const show = extractFunction(debotContent, 'showDebotRwaPopover');
  assert.ok(show.includes("popover.setAttribute('role', 'dialog')"));
  assert.ok(show.includes("source.textContent = '985monitor · RWA 资产'"));
  assert.ok(show.includes("['链上价'"));
  assert.ok(show.includes("['标的价'"));
  assert.ok(show.includes("['流动性'"));
  assert.ok(!debotContent.includes('https://www.985monitor.xyz/rwa/?asset='));
  assert.ok(debotStyles.includes('.gdh-debot-rwa-link::after'));
  assert.ok(debotStyles.includes('.gdh-debot-rwa-popover'));
  assert.match(privacy, /DeBot 原生池表中的代币地址/);
});

await test('DeBot RWA 点击渲染本页资产浮窗且不触发原生跳转', () => {
  class FakeElement {
    constructor(tag = 'div') {
      this.tagName = tag.toUpperCase();
      this.children = [];
      this.attributes = {};
      this.dataset = {};
      this.style = {};
      this.className = '';
      this.parent = null;
      this.isConnected = false;
      this.listeners = {};
      this.textContent = '';
    }
    append(...nodes) {
      nodes.forEach((node) => {
        node.parent = this;
        node.isConnected = true;
        this.children.push(node);
      });
    }
    remove() {
      if (this.parent) this.parent.children = this.parent.children.filter((node) => node !== this);
      this.isConnected = false;
    }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    addEventListener(type, listener) { this.listeners[type] = listener; }
    contains(node) { return node === this || this.children.some((child) => child.contains(node)); }
    closest(selector) { return selector === '.gdh-debot-rwa-link' ? this : null; }
    getBoundingClientRect() { return { left: 20, right: 70, top: 30, width: 300, height: 260 }; }
  }
  const body = new FakeElement('body');
  body.isConnected = true;
  const document = { body, createElement: (tag) => new FakeElement(tag) };
  const asset = {
    address: '0x44c4f142009036cf477ed2d09932051843137cf1',
    symbol: 'ZM', onchainPrice: 103.93, referencePrice: 95.24, premiumPct: 9.12,
    liquidityUsd: 40120, volume24hUsd: 236880, onchainMarketCapUsd: 64380000,
    referenceMarketCapUsd: 27790000000, onchainSupply: 619430,
    referenceSharePct: 2.74, deployedAt: '06-10', description: 'Zoom，视频会议软件',
  };
  const functions = [
    'formatDebotRwaNumber', 'formatDebotRwaMoney', 'closeDebotRwaPopover',
    'positionDebotRwaPopover', 'showDebotRwaPopover', 'openDebotRwaPoolLink',
  ].map((name) => extractFunction(debotContent, name));
  const result = evaluate(functions, `(() => {
    const anchor = new Element('span');
    anchor.className = 'gdh-debot-rwa-link';
    anchor.dataset.gdhDebotRwaAddress = '${asset.address}';
    anchor.isConnected = true;
    anchor.getBoundingClientRect = () => ({ left: 900, right: 950, top: 30, width: 50, height: 20 });
    const before = location.href;
    const event = { type: 'click', target: anchor, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; } };
    openDebotRwaPoolLink(event);
    const popover = document.body.children[0];
    const flatten = (node) => [node.textContent].concat(node.children.flatMap(flatten)).join(' ');
    const tags = (node) => [node.tagName].concat(node.children.flatMap(tags));
    const snapshot = { role: popover.attributes.role, text: flatten(popover), tags: tags(popover), left: popover.style.left, prevented: event.prevented, stopped: event.stopped, href: location.href };
    closeDebotRwaPopover();
    snapshot.closed = document.body.children.length === 0;
    snapshot.unchanged = before === location.href;
    return snapshot;
  })()`, {
    document,
    window: { innerWidth: 1024, innerHeight: 768 },
    location: { href: 'https://debot.ai/token/robinhood/231141_0x44c4f142009036cf477ed2d09932051843137cf1' },
    Element: FakeElement,
    Node: FakeElement,
    debotRwaCatalog: new Map([[asset.address, asset]]),
    debotRwaPopover: null,
    debotRwaPopoverAnchor: null,
  });
  assert.equal(result.role, 'dialog');
  assert.match(result.text, /ZM/);
  assert.match(result.text, /链上价/);
  assert.match(result.text, /\$103\.93/);
  assert.match(result.text, /正股市值\s+\$27\.79B/);
  assert.ok(!result.tags.includes('A'));
  assert.ok(result.prevented && result.stopped && result.closed && result.unchanged);
  assert.ok(Number.parseFloat(result.left) < 900, '右侧空间不足时浮窗应显示在资产左侧');
});

await test('版本变更后只刷新一次已打开的支持站点标签页', async () => {
  const cleanupFn = extractFunction(background, 'cleanupLegacyBrewPageUi');
  const fn = extractFunction(background, 'refreshSupportedTabsAfterVersionChange');
  assert.ok(fn.includes("'https://gmgn.ai/*', 'https://debot.ai/*'"));
  assert.ok(!fn.includes('https://brew.family/*'));
  const reloaded = [];
  const cleaned = [];
  const saved = {};
  await evaluate([cleanupFn, fn], 'refreshSupportedTabsAfterVersionChange()', {
    RUNNING_VERSION_KEY: 'gdhRunningVersion',
    chrome: {
      runtime: { getManifest: () => ({ version: '0.46.22' }) },
      storage: { local: {
        get: async () => ({ gdhRunningVersion: '0.46.14' }),
        set: async (value) => Object.assign(saved, value),
      } },
      tabs: {
        query: async ({ url }) => url.includes('https://brew.family/*')
          ? [{ id: 5 }]
          : [{ id: 7 }, { id: 9 }, { id: null }],
        reload: async (id) => { reloaded.push(id); },
      },
      scripting: { executeScript: async ({ target }) => { cleaned.push(target.tabId); } },
    },
    Promise,
  });
  assert.deepEqual(reloaded, [7, 9]);
  assert.deepEqual(cleaned, [5]);
  assert.equal(saved.gdhRunningVersion, '0.46.22');

  reloaded.length = 0;
  await evaluate([cleanupFn, fn], 'refreshSupportedTabsAfterVersionChange()', {
    RUNNING_VERSION_KEY: 'gdhRunningVersion',
    chrome: {
      runtime: { getManifest: () => ({ version: '0.46.22' }) },
      storage: { local: {
        get: async () => ({ gdhRunningVersion: '0.46.22' }),
        set: async () => {},
      } },
      tabs: { query: async () => [{ id: 7 }], reload: async (id) => { reloaded.push(id); } },
      scripting: { executeScript: async () => {} },
    },
    Promise,
  });
  assert.deepEqual(reloaded, []);
});

await test('旧 Brew 页面只移除遗留面板，不刷新页面', async () => {
  const fn = extractFunction(background, 'cleanupLegacyBrewPageUi');
  assert.ok(fn.includes("'https://brew.family/*'"));
  assert.ok(fn.includes(".gdh-brew-launcher, .gdh-brew-panel"));
  assert.ok(!fn.includes('chrome.tabs.reload'));
});

await test('Pump 插卡沿用关注、屏蔽、类型与最低成交额过滤', () => {
  const functions = [extractFunction(content, 'pumpFeedTokenKey'), extractFunction(content, 'pumpFeedEventAllowed')];
  const wallet = 'BY58Z7N5Adarkx5ed78AzKvR7Kxrq795aa1boZsYyVBT';
  const base = { pumpWallet: wallet, type: 'buy', usd: 25, symbol: 'DUVAL', addr: 'HbF1o9Mgwibv9JcQzEVUs52d9z1ibYQpdx8bY8Ntpump' };
  const run = (cfg, defaults = [wallet], ev = base) => evaluate(functions, `pumpFeedEventAllowed(${JSON.stringify(ev)})`, {
    monitorPumpCfg: cfg,
    pumpDefaultWallets: new Set(defaults),
    isTokenBlocked: () => false,
  });
  const cfg = { connected: true, muted: new Set(), prefs: {}, watch: new Set(), filters: {}, tokenFilters: new Set(), onlyMine: true, globalTradeMinUsd: 10 };
  assert.equal(run(cfg), true);
  assert.equal(run({ ...cfg, connected: false }), false);
  assert.equal(run({ ...cfg, globalTradeMinUsd: 30 }), false);
  assert.equal(run({ ...cfg, muted: new Set([wallet]) }), false);
  assert.equal(run({ ...cfg, prefs: { [wallet]: { types: { buy: false } } } }), false);
  assert.equal(run({ ...cfg, tokenFilters: new Set(['DUVAL']) }), false);
  assert.equal(run(cfg, []), false);
  assert.equal(run({ ...cfg, onlyMine: false }, []), true);
});

await test('Pump 明确的空代币过滤不会错误回退默认股票名单', () => {
  assert.match(content, /const tokenValues = Array\.isArray\(raw\?\.tokenFilters\)\s*\? raw\.tokenFilters\s*: \[\.\.\.PUMP_FEED_DEFAULT_TOKEN_FILTERS\]/);
  assert.ok(!content.includes('Array.isArray(raw?.tokenFilters) && raw.tokenFilters.length'));
  assert.ok(content.includes("monitorPumpConfig: { ...(config.pump || {})"));
});

await test('Pump 推送有独立设置项并复用同一 SSE 连接', () => {
  assert.ok(popupHtml.includes('id="enable-pump-feed"'));
  assert.ok(popup.includes('enablePumpFeed: true'));
  assert.ok(content.includes("chrome.runtime.sendMessage({ type: 'pump-feed' }"));
  assert.ok(background.includes("eventType === 'pump-trade'"));
  assert.ok(background.includes("type: 'gdh-pump-push'"));
  assert.equal((background.match(/api\/extension\/events-stream/g) || []).length, 1);
});

await test('985monitor 账号配置使用独立只读会话且不落盘网页主令牌', () => {
  assert.ok(content.includes("fetch('/api/extension/session'" ) || content.includes("? '/api/extension/session'"));
  assert.ok(content.includes("'/api/extension/prefs'"));
  assert.ok(content.includes('monitor985SessionV1'));
  assert.ok(background.includes('/api/extension/config'));
  assert.ok(background.includes('/api/extension/fomo-events?limit=150'));
  assert.ok(background.includes('/api/extension/pump-trade-events?limit=150'));
  assert.ok(background.includes("Authorization: `Bearer ${session.token}`"));
  assert.ok(!background.includes('X-User-Token'));
  assert.ok(!content.includes('monitor985SessionV1: { token: auth.token'));
  assert.ok(popupHtml.includes('id="monitor-985-sync-status"'));
  assert.ok(popup.includes('985monitor 网页已登录（无需刷新）'));
});

await test('已打开的 985monitor 页面无需刷新即可恢复会话同步', async () => {
  const calls = [];
  const chrome = {
    runtime: { lastError: null },
    tabs: {
      query: async (options) => {
        calls.push(['query', options.url]);
        return [{ id: 11 }, { id: 22 }, { id: null }];
      },
      sendMessage: (id, message, callback) => {
        calls.push(['ping', id, message.type]);
        chrome.runtime.lastError = id === 22 ? { message: 'no receiver' } : null;
        callback(id === 11 ? { ok: true } : undefined);
        chrome.runtime.lastError = null;
      },
    },
    scripting: {
      executeScript: async (options) => calls.push(['inject', options.target.tabId, options.files?.[0] || 'reset']),
    },
  };
  const fn = extractFunction(background, 'wakeOpenMonitor985Tabs');
  await evaluate([fn], 'wakeOpenMonitor985Tabs()', { chrome, Number, Promise });
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0])), ['query', ['https://985monitor.xyz/*', 'https://*.985monitor.xyz/*']]);
  assert.deepEqual(calls.filter((call) => call[0] === 'ping').map((call) => call[1]), [11, 22]);
  assert.deepEqual(calls.filter((call) => call[0] === 'inject'), [
    ['inject', 22, 'reset'],
    ['inject', 22, 'content.js'],
  ]);
  assert.ok(manifest.permissions.includes('scripting'));
  assert.ok(content.includes("message?.type !== '985-monitor-sync-now'"));
  assert.ok(content.includes('syncAccount(false)'));
});

await test('FOMO 插卡按账号名单、屏蔽、类型、代币和最低成交额过滤', () => {
  const functions = [extractFunction(content, 'pumpFeedTokenKey'), extractFunction(content, 'fomoFeedEventAllowed')];
  const ev = { handle: 'alice', type: 'buy', usd: 25, symbol: 'TEST', addr: '0x1111111111111111111111111111111111111111' };
  const settings = { fomoFeedTypes: { buy: true } };
  const base = {
    connected: true,
    muted: new Set(),
    prefs: {},
    watch: new Set(['alice']),
    filters: {},
    tokenFilters: new Set(),
    globalTradeMinUsd: 10,
  };
  const run = (cfg, event = ev) => evaluate(functions, `fomoFeedEventAllowed(${JSON.stringify(event)})`, {
    monitorFomoCfg: cfg,
    settings,
    DEFAULTS: settings,
    isTokenBlocked: () => false,
  });
  assert.equal(run(base), true);
  assert.equal(run({ ...base, connected: false }), false);
  assert.equal(run({ ...base, watch: new Set() }), false);
  assert.equal(run({ ...base, muted: new Set(['alice']) }), false);
  assert.equal(run({ ...base, prefs: { alice: { types: { buy: false } } } }), false);
  assert.equal(run({ ...base, tokenFilters: new Set(['TEST']) }), false);
  assert.equal(run({ ...base, globalTradeMinUsd: 30 }), false);
});

await test('FOMO keeper 由真实后台页承担且禁止 Chrome 丢弃', async () => {
  const calls = [];
  const chrome = { tabs: {
    query: async () => [],
    create: async (options) => { calls.push(['create', options]); return { id: 7, url: options.url, discarded: false }; },
    update: async (id, options) => { calls.push(['update', id, options]); return { id, url: 'https://fomo.family/?gdh_keeper=1', discarded: false }; },
    reload: async () => {},
  } };
  const fn = extractFunction(background, 'fomoEnsureSdkOwner');
  const result = evaluate([fn], 'fomoEnsureSdkOwner(true)', {
    chrome,
    FOMO_KEEPER_URL: 'https://fomo.family/?gdh_keeper=1',
    fomoOpenTabs: async () => [],
    fomoAuthNote: async () => {},
  });
  await result;
  assert.equal(calls[0][1].active, false);
  assert.equal(calls[0][1].pinned, true);
  assert.equal(calls[1][2].autoDiscardable, false);
  const frozenCalls = [];
  const frozenChrome = { tabs: {
    query: async () => [],
    create: async (options) => { frozenCalls.push(['create', options]); return { id: 8, url: options.url, discarded: false }; },
    update: async (id, options) => ({ id, url: 'https://fomo.family/?gdh_keeper=1', discarded: false, ...options }),
    reload: async () => {},
  } };
  await evaluate([fn], 'fomoEnsureSdkOwner(true)', {
    chrome: frozenChrome,
    FOMO_KEEPER_URL: 'https://fomo.family/?gdh_keeper=1',
    fomoOpenTabs: async () => [{ id: 3, url: 'https://fomo.family/', discarded: false, status: 'complete' }],
    fomoAuthNote: async () => {},
  });
  assert.equal(frozenCalls.length, 1);
  const closed = [];
  const heartbeatFn = extractFunction(background, 'recordFomoPageHeartbeat');
  await evaluate([heartbeatFn], "recordFomoPageHeartbeat({ visible: true, keeper: false }, { tab: { id: 10, url: 'https://fomo.family/' } })", {
    URL,
    Date,
    chrome: { storage: { local: { set: async () => {} } }, tabs: { remove: async (ids) => closed.push(...ids) } },
    fomoOpenTabs: async () => [
      { id: 10, url: 'https://fomo.family/' },
      { id: 11, url: 'https://fomo.family/?gdh_keeper=1' },
    ],
    fomoAuthNote: async () => {},
  });
  assert.deepEqual(closed, [11]);
});

await test('FOMO HTTP 200 鉴权错误被识别', () => {
  const fn = extractFunction(background, 'fomoBodyUnauthed');
  assert.equal(evaluate([fn], "fomoBodyUnauthed({ success: false, statusCode: 401 })"), true);
  assert.equal(evaluate([fn], "fomoBodyUnauthed({ statusCode: 403 })"), true);
  assert.equal(evaluate([fn], "fomoBodyUnauthed({ error: 'unauthorized' })"), true);
  assert.equal(evaluate([fn], "fomoBodyUnauthed({ message: 'Unauthenticated request' })"), true);
  assert.equal(evaluate([fn], "fomoBodyUnauthed({ error: 'request headers too large' })"), false);
  assert.equal(evaluate([fn], "fomoBodyUnauthed({ success: true, statusCode: 200 })"), false);
});

await test('FOMO 非 2xx 的 430/431 unauthorized 也进入登录引导', async () => {
  const bodyFn = extractFunction(background, 'fomoBodyUnauthed');
  const responseFn = extractFunction(background, 'fomoResponseUnauthed');
  const unauthorized = {
    status: 431,
    clone() { return this; },
    async json() { return { error: 'unauthorized' }; },
  };
  const unrelated = {
    status: 431,
    clone() { return this; },
    async json() { return { error: 'request headers too large' }; },
  };
  assert.equal(await evaluate([bodyFn, responseFn], 'fomoResponseUnauthed(response)', { response: unauthorized }), true);
  assert.equal(await evaluate([bodyFn, responseFn], 'fomoResponseUnauthed(response)', { response: unrelated }), false);
  assert.match(background, /if \(!res\.ok && unauthed && !token\)[\s\S]{0,160}reason: 'no-token'/);
  assert.match(background, /unauthed \? \(token \? 'expired' : 'no-token'\)/);
  assert.ok(background.includes("reason: rateLimited ? 'rate-limited'"));
});

await test('后台不再裸调 Privy sessions 或携带公开标注口令', () => {
  assert.ok(!background.includes('auth.privy.io/api/v1/sessions'));
  assert.ok(!background.includes('gdh-marked-watch-2026'));
  assert.ok(!background.includes('reportCustomMarked'));
});

await test('下载页不使用 innerHTML 且严格绑定版本化同源文件名', () => {
  assert.ok(!site.includes('.innerHTML ='));
  assert.ok(site.includes('exe === expectedExe'));
  assert.ok(site.includes('zip === expectedZip'));
});

await test('FOMO 登录按钮无感使用推荐注册链接', () => {
  const fn = extractFunction(content, 'buildFomoErrorBox');
  assert.ok(fn.includes("link.href = 'https://fomo.family/';"));
  assert.ok(fn.includes("window.open('https://fomo.family/r/Unipioneer', '_blank', 'noopener,noreferrer');"));
  assert.ok(fn.includes("link.textContent = '打开 fomo 并登录 →';"));
  assert.ok(!fn.includes("textContent = 'Unipioneer'"));
});

await test('下载同步脚本拒绝恶意版本参数', () => {
  const python = process.platform === 'win32' ? 'python' : 'python3';
  const result = spawnSync(python, [path.join(root, 'scripts', 'sync-bgm-download.py'), '0.46.1;echo-pwned'], { encoding: 'utf8' });
  if (result.error) {
    assert.match(bgmSync, /re\.fullmatch\(r'\\d\+\\\.\\d\+\\\.\\d\+'/);
    assert.ok(!bgmSync.includes('shell=True'));
    return;
  }
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /X\.Y\.Z/);
});

await test('/bgm 同步只使用 GitHub Release 原始资产并校验 SHA256', () => {
  assert.ok(bgmSync.includes("releases/download/v{V}"));
  assert.ok(bgmSync.includes("f'{EXE}.sha256'"));
  assert.ok(bgmSync.includes("f'{ZIP}.sha256'"));
  assert.ok(bgmSync.includes('for fn in RELEASE_FILES'));
  assert.ok(bgmSync.includes('release_file_hashes[fn]'));
  assert.ok(bgmSync.includes('Release SHA256 不一致'));
  assert.ok(!bgmSync.includes("os.path.join(DIST, fn)"));
  assert.ok(site.includes(`985gmgn-helper-setup-v${manifest.version}.exe`));
  assert.ok(site.includes(`985gmgn-helper-v${manifest.version}.zip`));
});

await test('Solana 供应量缓存键不再统一小写', () => {
  assert.ok(background.includes("const normalizedAddress = looksEvm ? String(address).toLowerCase() : String(address);"));
});

await test('FOMO 持仓占比在 GMGN 同源页面取全链供应量', async () => {
  const fn = extractFunction(content, 'loadFomoSupply');
  assert.ok(fn.includes('https://gmgn.ai/api/v1/mutil_window_token_info?'));
  assert.ok(fn.includes("body: JSON.stringify({ chain: route.chain, addresses: [route.address] })"));
  assert.ok(fn.includes('item?.total_supply ?? item?.max_supply ?? item?.circulating_supply'));
  assert.ok(fn.indexOf('await fetch(') < fn.indexOf("type: 'token-supply'"));
  assert.ok(fn.includes('fomoStats.key === statKey'));

  const address = '0xfdae23ce76018da62507bb5ef20e6ef5450e8312';
  const stats = { key: `robinhood|${address}`, holders: null, thesisCount: null, supply: 0 };
  let backgroundCalls = 0;
  let renders = 0;
  await evaluate([fn], `loadFomoSupply({ chain: 'robinhood', address: '${address}' })`, {
    fomoStats: stats,
    fomoSupplyLoadingKey: '',
    gmgnApiQuery: () => 'device_id=live-page',
    settings: {},
    fetch: async () => ({
      ok: true,
      json: async () => ({ code: 0, data: [{ total_supply: '1000000000' }] }),
    }),
    chrome: { runtime: { sendMessage: async () => { backgroundCalls += 1; return { ok: false }; } } },
    renderFomoStats: () => { renders += 1; },
    renderTokenHeaderBadges: () => {},
  });
  assert.equal(stats.supply, 1_000_000_000);
  assert.equal(backgroundCalls, 0);
  assert.equal(renders, 1);
});

await test('FOMO 翻译只跳过纯中文，混合中英和日韩文字继续翻译', () => {
  const probe = extractFunction(content, 'fomoForeignProbe');
  const looksChinese = extractFunction(content, 'fomoLooksChinese');
  const fallback = extractFunction(content, 'fomoFallbackLang');
  assert.equal(evaluate([probe, looksChinese], "fomoLooksChinese('这是纯中文观点')"), true);
  assert.equal(evaluate([probe, looksChinese], "fomoLooksChinese('叙事很好 hold this gem')"), false);
  assert.equal(evaluate([probe, looksChinese], "fomoLooksChinese('すごい銘柄')"), false);
  assert.equal(evaluate([probe], "fomoForeignProbe('中文 hold https://example.com 0x1234567890abcdef')"), 'hold');
  assert.equal(evaluate([fallback], "fomoFallbackLang('moon soon')"), 'en');
  assert.equal(evaluate([fallback], "fomoFallbackLang('すごい')"), 'ja');
  assert.equal(evaluate([fallback], "fomoFallbackLang('대박')"), 'ko');
});

await test('FOMO 短句低置信度与语言检测器异常都有翻译语言回退', async () => {
  const probe = extractFunction(content, 'fomoForeignProbe');
  const fallback = extractFunction(content, 'fomoFallbackLang');
  const detect = extractFunction(content, 'fomoDetectLang');
  const lowConfidenceApi = { create: async () => ({ detect: async () => [{ detectedLanguage: 'en', confidence: 0.12 }] }) };
  const lowConfidence = await evaluate(
    [probe, fallback, detect],
    "fomoDetectLang('hold this gem')",
    {
      fomoDetector: null,
      fomoDetApi: () => lowConfidenceApi,
    },
  );
  assert.equal(lowConfidence, 'en');
  const failedApi = { create: async () => { throw new Error('disabled'); } };
  const detectorFailed = await evaluate(
    [probe, fallback, detect],
    "fomoDetectLang('moon soon')",
    { fomoDetector: null, fomoDetApi: () => failedApi },
  );
  assert.equal(detectorFailed, 'en');
});

await test('FOMO 持仓占比以独立徽章显示在 GMGN 代币表头', () => {
  const scan = extractFunction(content, 'scanTokenHeaderBadges');
  const render = extractFunction(content, 'renderTokenHeaderBadges');
  const load = extractFunction(content, 'loadFomoHeaderStats');
  assert.ok(scan.includes('renderTokenHeaderBadges()'));
  assert.ok(scan.includes('loadFomoHeaderStats(route)'));
  assert.ok(render.includes("#token-base-address[data-addr]"));
  assert.ok(render.includes('`fomo ${fomoShare}`'));
  assert.ok(load.includes("kind: 'holders'"));
  assert.ok(load.includes('FOMO_REFRESH_MS'));
  assert.match(styles, /\.gdh-token-header-badges\s*\{/);
  assert.match(styles, /\.gdh-token-header-fomo\s*\{/);
});

await test('标注人物徽章显示合计持仓占比并兼容部分旧数据', () => {
  const summaryFn = extractFunction(content, 'markedHoldingSummary');
  const formatFn = extractFunction(content, 'holdingShareText');
  const exact = evaluate(
    [summaryFn],
    "markedHoldingSummary([{name:'甲',amount:10,supply:1000},{name:'乙',amount:15,supply:1000}])",
  );
  assert.equal(exact.names.length, 2);
  assert.equal(exact.pct, 2.5);
  assert.equal(exact.lowerBound, false);
  const partial = evaluate(
    [summaryFn],
    "markedHoldingSummary([{name:'甲',amount:10,supply:1000},'旧数据人物'])",
  );
  assert.equal(partial.lowerBound, true);
  assert.equal(evaluate([formatFn], 'holdingShareText(0.006, true)'), '≥0.006%');
  const badge = extractFunction(content, 'ensureMarkedBadge');
  assert.ok(badge.includes("`👤${summary.names.length}${share ? ` · ${share}` : ''}`"));
  assert.ok(content.includes('put(h.t, nameOf.get(person), h.u, h.b, h.q)'));
  assert.ok(content.includes('h?.token?.total_supply'));
});

await test('设置面板按职责分组并展示全部功能开关', () => {
  const ids = [
    'enabled', 'show-dev-performance', 'show-dev-tooltip', 'enable-dev-bookmark',
    'enable-callout-blacklist', 'enable-manifesto-toast', 'enable-manifesto-tab',
    'enable-special-wallet', 'special-wallet-default-highlight', 'special-wallet-default-pin',
    'enable-fomo-feed', 'enable-pump-feed', 'fomo-feed-chain-only', 'enable-fomo-panel',
    'enable-fomo-trending',
    'fomo-translate', 'enable-marked-holders', 'enable-merge-fomo-holders',
    'enable-flap-tax', 'enable-all-pools', 'enable-holding-surge',
    'enable-remind-alert', 'hide-lightning-trade', 'enable-brew-panel',
  ];
  ids.forEach((id) => assert.ok(popupHtml.includes(`id="${id}"`), `missing setting ${id}`));
  assert.ok(popup.includes("fomoTranslate: document.querySelector('#fomo-translate')"));
  assert.ok(popup.includes('addWalletStarPref: {'));
  assert.match(popupHtml, /<h2>Dev 与喊单<\/h2>/);
  assert.match(popupHtml, /<h2>追踪流与特别关注<\/h2>/);
  assert.match(popupHtml, /<h2>代币数据<\/h2>/);
  assert.match(popupHtml, /<h2>提醒与界面<\/h2>/);
});

await test('Brew 官方发行快照按固定工厂和完整地址清洗', () => {
  const fn = extractFunction(brewContent, 'compactBrewCheckpoint');
  const factory = '0xeea6c3bfb29fd9a35380438956bae7b109c63d85';
  const valid = JSON.parse(JSON.stringify(evaluate(
    [fn],
    `compactBrewCheckpoint({factory: '${factory}', tokens: [
      {address:'0x1111111111111111111111111111111111111111',pool:'0x2222222222222222222222222222222222222222',symbol:'BREW',name:'Brew',quoteSymbol:'WBNB',launchedAt:1000},
      {address:'0x1111111111111111111111111111111111111111',pool:'0x3333333333333333333333333333333333333333',symbol:'DUP',name:'Duplicate',quoteSymbol:'USDT',launchedAt:900},
      {address:'bad',pool:'0x4444444444444444444444444444444444444444',symbol:'BAD',launchedAt:800}
    ]}, 2000)`,
    { BREW_FACTORY: factory, ADDRESS_RE: /^0x[a-fA-F0-9]{40}$/ },
  )));
  assert.equal(valid.length, 1);
  assert.equal(valid[0].address, '0x1111111111111111111111111111111111111111');
  assert.equal(valid[0].pool, '0x2222222222222222222222222222222222222222');
  assert.ok(!fn.includes('.slice(0, 300)'));
  const wrongFactory = evaluate(
    [fn],
    `compactBrewCheckpoint({factory:'0x0000000000000000000000000000000000000000',tokens:[]}, 2000)`,
    { BREW_FACTORY: factory, ADDRESS_RE: /^0x[a-fA-F0-9]{40}$/ },
  );
  assert.equal(wrongFactory.length, 0);
});

await test('Brew 行情只匹配官方池与代币双重一致的交易对', () => {
  const finite = extractFunction(brewContent, 'finiteBrewNumber');
  assert.equal(evaluate([finite], 'finiteBrewNumber(null)'), null);
  assert.equal(evaluate([finite], "finiteBrewNumber('')"), null);
  const merge = extractFunction(brewContent, 'mergeBrewMarkets');
  const address = '0x1111111111111111111111111111111111111111';
  const pool = '0x2222222222222222222222222222222222222222';
  const items = JSON.parse(JSON.stringify(evaluate(
    [finite, merge],
    `mergeBrewMarkets([{address:'${address}',pool:'${pool}',launchedAt:1000}], [
      {pairAddress:'${pool}',baseToken:{address:'0x3333333333333333333333333333333333333333'},marketCap:999999,liquidity:{usd:999}},
      {pairAddress:'${pool}',baseToken:{address:'${address}'},marketCap:12345,fdv:13000,volume:{h24:456},liquidity:{usd:789},priceChange:{h24:12.5},txns:{h24:{buys:8,sells:3}},dexId:'pancakeswap',labels:['v3']}
    ])`,
    { ADDRESS_RE: /^0x[a-fA-F0-9]{40}$/ },
  )));
  assert.equal(items.length, 1);
  assert.equal(items[0].indexed, true);
  assert.equal(items[0].marketCapUsd, 12345);
  assert.equal(items[0].liquidityUsd, 789);
  assert.equal(items[0].dexLabel, 'v3');
});

await test('Brew 三标签分别按创建、24h 成交额和市值排序', () => {
  const sort = extractFunction(brewContent, 'sortBrewItems');
  const source = `[
    {symbol:'A',launchedAt:30,volume24hUsd:1,marketCapUsd:10,liquidityUsd:1},
    {symbol:'B',launchedAt:20,volume24hUsd:30,marketCapUsd:20,liquidityUsd:2},
    {symbol:'C',launchedAt:10,volume24hUsd:20,marketCapUsd:40,liquidityUsd:3}
  ]`;
  const symbols = (tab) => Array.from(evaluate([sort], `sortBrewItems(${source}, '${tab}').map(x=>x.symbol)`));
  assert.deepEqual(symbols('new'), ['A', 'B', 'C']);
  assert.deepEqual(symbols('hot'), ['B', 'C', 'A']);
  assert.deepEqual(symbols('market'), ['C', 'B', 'A']);
});

await test('Brew 浮窗、设置、权限、隐私与发布包完整接线', () => {
  assert.ok(brewContent.includes("[['new', '新创建'], ['hot', '热门'], ['market', '市值']]"));
  assert.ok(!brewContent.includes('https://brew.family/launch-checkpoint.json'));
  assert.ok(!brewContent.includes('https://api.dexscreener.com/latest/dex/pairs/bsc/'));
  assert.ok(!background.includes('api/extension/brew-trenches'));
  assert.ok(background.includes('https://brewfamily.app/launch-checkpoint.json'));
  assert.ok(!background.includes("'https://brew.family/launch-checkpoint.json'"));
  assert.ok(background.includes("fetch('/api/v1/mutil_window_token_info'"));
  assert.ok(background.includes("message?.type === 'brew-trenches'"));
  const pathFn = extractFunction(brewContent, 'brewTokenPath');
  const pathFor = (hostname) => evaluate(
    [pathFn],
    "brewTokenPath('0x1111111111111111111111111111111111111111')",
    { ADDRESS_RE: /^0x[a-fA-F0-9]{40}$/, location: { hostname } },
  );
  assert.equal(pathFor('gmgn.ai'), '/bsc/token/0x1111111111111111111111111111111111111111');
  assert.equal(pathFor('debot.ai'), '/token/bsc/0x1111111111111111111111111111111111111111');
  assert.equal(pathFor('brew.family'), '');
  assert.ok(brewContent.includes('https://dexscreener.com/bsc/${item.pool}'));
  assert.ok(brewStyles.includes('.gdh-brew__pool'));
  assert.ok(brewStyles.includes('.gdh-brew__avatar img'));
  assert.ok(brewStyles.includes('grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto auto'));
  assert.ok(brewStyles.includes('content-visibility: auto'));
  assert.ok(manifest.host_permissions.includes('https://brewfamily.app/*'));
  assert.ok(manifest.host_permissions.includes('https://rpc-bsc.48.club/*'));
  assert.ok(manifest.host_permissions.includes('https://bsc.rpc.blxrbdn.com/*'));
  assert.ok(!manifest.host_permissions.includes('https://brew.family/*'));
  assert.ok(!manifest.host_permissions.includes('https://api.dexscreener.com/*'));
  assert.ok(!manifest.content_scripts.some((entry) => entry.matches.includes('https://brew.family/*')));
  for (const origin of ['https://gmgn.ai/*', 'https://debot.ai/*']) {
    assert.ok(manifest.content_scripts.some((entry) => entry.matches.includes(origin)
      && entry.js.includes('brew-content.js') && entry.css.includes('brew-styles.css')));
  }
  assert.match(brewStyles, /\.gdh-brew-launcher\s*\{[\s\S]*?bottom:\s*44px/);
  assert.match(brewStyles, /\.gdh-brew-launcher\.is-debot\s*\{[\s\S]*?bottom:\s*18px/);
  assert.match(debotStyles, /\.gdh-debot-fomo-launcher\s*\{[\s\S]*?bottom:\s*60px/);
  assert.ok(popup.includes("enableBrewPanel: document.querySelector('#enable-brew-panel')"));
  assert.ok(releaseBuild.includes("'brew-content.js'"));
  assert.ok(releaseBuild.includes("'brew-styles.css'"));
  assert.ok(releaseBuild.includes("'brew-launch-baseline.json'"));
  assert.ok(privacy.includes('内置链上基线'));
  assert.ok(privacy.includes('每批最多 10 个'));
});

await test('Brew 页面脚本区分全量手动刷新与两分钟快速更新', async () => {
  const fn = extractFunction(brewContent, 'requestBrewTrenches');
  const sent = [];
  const response = await evaluate([fn], "requestBrewTrenches('full')", {
    chrome: { runtime: {
      lastError: null,
      sendMessage: (message, callback) => {
        sent.push(message);
        callback({ ok: true, checkpoint: { factory: 'x', tokens: [] }, pairs: [] });
      },
    } },
    Promise,
    Error,
  });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, 'brew-trenches');
  assert.equal(sent[0].refreshMode, 'full');
  assert.equal(response.ok, true);
  assert.ok(brewContent.includes("const CACHE_KEY = 'brewTrenchCacheV2'"));
  assert.ok(brewContent.includes('const BREW_AUTO_REFRESH_MS = 2 * 60 * 1000'));
  assert.match(brewContent, /setInterval\(\(\) =>[\s\S]*?refreshBrewPanel\('fast'\)[\s\S]*?BREW_AUTO_REFRESH_MS/);
  assert.ok(background.includes("['cache', 'fast', 'full'].includes(message.refreshMode)"));
});

await test('Brew 官方快照 404 时回退插件内置链上基线', async () => {
  const validFn = extractFunction(background, 'brewCheckpointIsValid');
  const fetchFn = extractFunction(background, 'brewFetchCheckpointFile');
  const baseFn = extractFunction(background, 'fetchBrewBaseCheckpoint');
  const calls = [];
  const fallback = { factory: '0xfactory', head: { number: '0x10' }, tokens: [{ address: '0x1' }] };
  const result = await evaluate([validFn, fetchFn, baseFn], 'fetchBrewBaseCheckpoint()', {
    BREW_FACTORY: '0xfactory',
    BREW_CHECKPOINT_URL: 'https://brewfamily.app/launch-checkpoint.json',
    BREW_BASELINE_PATH: 'brew-launch-baseline.json',
    chrome: { runtime: { getURL: (path) => `chrome-extension://test/${path}` } },
    fetch: async (url) => {
      calls.push(url);
      if (url.startsWith('https://')) return { ok: false, status: 404, json: async () => null };
      return { ok: true, status: 200, json: async () => fallback };
    },
    AbortController,
    setTimeout,
    clearTimeout,
    Error,
  });
  assert.deepEqual(calls, [
    'chrome-extension://test/brew-launch-baseline.json',
    'https://brewfamily.app/launch-checkpoint.json',
  ]);
  assert.equal(result.tokens.length, 1);
  assert.equal(result.head.number, '0x10');
  assert.ok(background.includes('brewFetchCheckpointFile(BREW_CHECKPOINT_URL, 5000)'));
});

await test('Brew 内置基线来自固定工厂且包含全部 1106 个唯一发行', () => {
  assert.equal(brewBaseline.factory, '0xeea6c3bfb29fd9a35380438956bae7b109c63d85');
  assert.equal(brewBaseline.tokens.length, 1106);
  assert.equal(new Set(brewBaseline.tokens.map((token) => token.address.toLowerCase())).size, 1106);
  assert.equal(Math.min(...brewBaseline.tokens.map((token) => token.blockNumber)), 120206663);
  assert.equal(Math.max(...brewBaseline.tokens.map((token) => token.blockNumber)), 120882990);
  assert.ok(brewBaseline.tokens.every((token) => /^0x[a-f0-9]{40}$/.test(token.address)
    && /^0x[a-f0-9]{40}$/.test(token.pool) && Number(token.launchedAt) > 0));
  assert.ok(background.includes("brewLogRpc('eth_getLogs'"));
  assert.ok(background.includes('BREW_LAUNCH_TOPIC'));
  assert.ok(background.includes("const BREW_LOG_RPC_URLS = ['https://rpc-bsc.48.club', 'https://bsc.rpc.blxrbdn.com']"));
  assert.ok(background.includes('for (const rpcUrl of BREW_LOG_RPC_URLS)'));
});

await test('Brew 本地 RPC 的真实 TokenLaunched 日志可无损解码', () => {
  const names = ['brewLogBytes', 'brewLogWord', 'brewLogBigInt', 'brewLogAddress', 'brewLogText', 'brewMetadata', 'decodeBrewLaunchLog'];
  const decoded = JSON.parse(JSON.stringify(evaluate(
    names.map((name) => extractFunction(background, name)),
    'logs.map(decodeBrewLaunchLog)',
    {
      logs: brewLaunchFixture,
      BREW_LAUNCH_TOPIC: '0xb091239373ed76ea7dc39ecbeef35cafced5943a8f7c9c5d88e711192f16910c',
      Uint8Array,
      BigInt,
      Number,
      TextDecoder,
      atob,
      decodeURIComponent,
      JSON,
    },
  )));
  const dust = decoded.find((token) => token.address === '0x8519a83aec3e38f7609b1e767c3e0eeb54f47bb6');
  assert.deepEqual({
    pool: dust.pool,
    name: dust.name,
    symbol: dust.symbol,
    imageUrl: dust.imageUrl,
    twitter: dust.twitter,
    launchedAt: dust.launchedAt,
    blockNumber: dust.blockNumber,
  }, {
    pool: '0xae0fe241dc697d5740d83b3fc3738b0914862492',
    name: 'Dust Astherus',
    symbol: 'Dust',
    imageUrl: 'onchain://56/0x4ed048f3d05539676b3a5ac72f1df0acfa034b9a',
    twitter: 'https://x.com/Aster_DEX/status/1883818620482175124',
    launchedAt: 1788715548000,
    blockNumber: 120342166,
  });
});

await test('Brew 后台使用本地基线与 GMGN 行情且全量刷新可绕过缓存', async () => {
  const fn = extractFunction(background, 'fetchBrewTrenches');
  const modes = [];
  const response = await evaluate([fn], "fetchBrewTrenches('full')", {
    BREW_LOCAL_CACHE_MS: 120000,
    brewLocalCache: { ok: true, fetchedAt: Date.now(), checkpoint: { tokens: [{ address: 'old' }] } },
    brewLocalPending: null,
    loadBrewCheckpoint: async () => ({ factory: '0xfactory', tokens: [] }),
    fetchBrewGmgnMarkets: async (_tokens, mode) => {
      modes.push(mode);
      return { pairs: [{ pairAddress: '0xpool' }], failedBatches: 0, fullFetchedAt: 123 };
    },
    hydrateBrewArtwork: async (tokens) => tokens,
    Date,
  });
  assert.equal(response.ok, true);
  assert.equal(response.localSource, true);
  assert.equal(response.pairs.length, 1);
  assert.equal(response.marketFullFetchedAt, 123);
  assert.deepEqual(modes, ['full']);
  assert.ok(brewContent.includes("cache.localSource ? ' · 本地 GMGN 行情' : ''"));
});

await test('Brew 链上头像由用户本地 BSC RPC 字节码解码且严格校验格式', () => {
  const mimeFn = extractFunction(background, 'brewArtworkMime');
  const decodeFn = extractFunction(background, 'brewDecodeArtworkCode');
  const webp = Buffer.from('RIFF0000WEBP12', 'ascii').toString('hex');
  const result = evaluate([mimeFn, decodeFn], `brewDecodeArtworkCode('0x00${webp}')`, {
    Uint8Array,
    Number,
    btoa,
  });
  assert.match(result, /^data:image\/webp;base64,/);
  assert.equal(evaluate([mimeFn, decodeFn], "brewDecodeArtworkCode('0x6000')", { Uint8Array, Number, btoa }), '');
  const hydrateFn = extractFunction(background, 'hydrateBrewArtwork');
  assert.ok(hydrateFn.includes('BREW_ARTWORK_RE'));
  assert.ok(hydrateFn.includes('FLAP_RPCS'));
  assert.ok(hydrateFn.includes('await loadBrewArtworkCache()'));
  assert.ok(background.includes("const BREW_ARTWORK_CACHE_KEY = 'brewArtworkCacheV1'"));
  assert.ok(background.includes('[BREW_ARTWORK_CACHE_KEY]: Object.fromEntries(brewArtworkCache)'));
  assert.ok(background.includes("method: 'eth_getCode'"));
  assert.ok(!background.includes('api/extension/brew-trenches'));
});

await test('Brew 卡片使用真实头像并在 GMGN 复用主世界 SPA 路由', () => {
  const navFn = extractFunction(brewContent, 'brewSpaNavigate');
  const attrs = new Map();
  const location = { hostname: 'gmgn.ai', pathname: '/', assigned: '', assign(path) { this.assigned = path; } };
  const document = {
    documentElement: {
      setAttribute: (key, value) => attrs.set(key, value),
    },
    dispatchEvent: (event) => {
      if (event.type === 'gdh-navigate') location.pathname = attrs.get('data-gdh-nav');
    },
  };
  evaluate([navFn], "brewSpaNavigate('/bsc/token/0x1111111111111111111111111111111111111111')", {
    location,
    document,
    Event,
    window: { setTimeout: (callback) => callback() },
  });
  assert.equal(location.pathname, '/bsc/token/0x1111111111111111111111111111111111111111');
  assert.equal(location.assigned, '');
  assert.ok(brewContent.includes("image.loading = 'lazy'"));
  assert.ok(brewContent.includes("image.decoding = 'async'"));
});

await test('Brew 本地 GMGN 行情按十地址批量且最多四路并发', async () => {
  const fn = extractFunction(background, 'requestBrewMarketsInGmgnPage');
  const batches = [];
  const tokens = Array.from({ length: 11 }, (_, index) => ({
    address: `0x${String(index + 1).padStart(40, '0')}`,
  }));
  const result = await evaluate([fn], `requestBrewMarketsInGmgnPage(${JSON.stringify(tokens.map((token) => token.address))})`, {
    fetch: async (_url, init) => {
      const body = JSON.parse(init.body);
      batches.push(body.addresses);
      return { ok: true, status: 200, json: async () => ({ code: 0, data: body.addresses }) };
    },
    AbortController,
    setTimeout,
    clearTimeout,
    Promise,
    Set,
    JSON,
  });
  assert.deepEqual(batches.map((batch) => batch.length), [10, 1]);
  assert.equal(result.items.length, 11);
  assert.equal(result.failedBatches, 0);
  const localFn = extractFunction(background, 'fetchBrewGmgnMarkets');
  assert.ok(localFn.includes("url: ['https://gmgn.ai/*']"));
  assert.ok(localFn.includes("url: 'https://gmgn.ai/?chain=bsc', active: false"));
  assert.ok(localFn.includes("world: 'MAIN'"));
  assert.ok(!localFn.includes('.slice(0, 300)'));

  const numberFn = extractFunction(background, 'brewMarketNumber');
  const valueFn = extractFunction(background, 'brewMarketValue');
  const planFn = extractFunction(background, 'brewMarketRefreshPlan');
  const universe = Array.from({ length: 1106 }, (_, index) => ({
    address: `0x${index.toString(16).padStart(40, '0')}`,
  }));
  const cachedPairs = universe.slice(500, 800).map((token, index) => ({
    baseToken: { address: token.address }, marketCap: 1000000 - index,
  }));
  const context = {
    BREW_MARKET_FULL_REFRESH_MS: 600000,
    BREW_MARKET_FAST_TOP: 200,
    BREW_MARKET_FAST_RECENT: 100,
    Date,
    Number,
    Set,
  };
  const initial = evaluate([numberFn, valueFn, planFn],
    `brewMarketRefreshPlan(${JSON.stringify(universe)}, {fullFetchedAt:0,pairs:[]}, 'fast', 1000000)`, context);
  assert.equal(initial.full, true);
  assert.equal(initial.addresses.length, 1106);
  const fast = evaluate([numberFn, valueFn, planFn],
    `brewMarketRefreshPlan(${JSON.stringify(universe)}, {fullFetchedAt:999999,pairs:${JSON.stringify(cachedPairs)}}, 'fast', 1000000)`, context);
  assert.equal(fast.full, false);
  assert.equal(fast.addresses.length, 300);
  const afterPartial = evaluate([numberFn, valueFn, planFn],
    `brewMarketRefreshPlan(${JSON.stringify(universe)}, {fullFetchedAt:0,fullAttemptedAt:999999,pairs:${JSON.stringify(cachedPairs)}}, 'fast', 1000000)`, context);
  assert.equal(afterPartial.full, false);
  assert.equal(afterPartial.addresses.length, 300);
  const expired = evaluate([numberFn, valueFn, planFn],
    `brewMarketRefreshPlan(${JSON.stringify(universe)}, {fullFetchedAt:1,pairs:${JSON.stringify(cachedPairs)}}, 'fast', 1000000)`, context);
  assert.equal(expired.full, true);
  assert.equal(expired.addresses.length, 1106);
});

await test('Brew 本地 GMGN 行情换算市值、涨幅与官方池字段', () => {
  const numberFn = extractFunction(background, 'brewMarketNumber');
  const compactFn = extractFunction(background, 'compactBrewGmgnMarket');
  const pair = evaluate([numberFn, compactFn], `compactBrewGmgnMarket({
    address:'0x1111111111111111111111111111111111111111',
    biggest_pool_address:'0x2222222222222222222222222222222222222222',
    circulating_supply:'1000',total_supply:'1200',liquidity:'456',
    pool:{pool_address:'0x2222222222222222222222222222222222222222',exchange:'pancake_v3'},
    price:{price:'2',price_24h:'1',volume_24h:'789',buys_24h:8,sells_24h:3}
  })`);
  assert.equal(pair.marketCap, 2000);
  assert.equal(pair.fdv, 2400);
  assert.equal(pair.priceChange.h24, 100);
  assert.equal(pair.liquidity.usd, 456);
  assert.equal(pair.dexId, 'pancake_v3');
});

await test('DeBot FOMO 翻译支持混合文本、缓存重绘和真实点击下载', () => {
  const probe = extractFunction(debotContent, 'translationForeignProbe');
  assert.equal(evaluate([probe], "translationForeignProbe('中文 HODL and wait')"), 'HODL and wait');
  assert.equal(evaluate([probe], "translationForeignProbe('纯中文')"), '');
  const paint = extractFunction(debotContent, 'paintTranslatedText');
  assert.ok(paint.includes('element?.parentNode'));
  assert.ok(!paint.includes('element.isConnected'));
  assert.ok(debotContent.includes('primeVisibleTranslators(root);'));
  assert.ok(debotContent.includes("new Set(['en', ...translationPendingLangs])"));
  assert.ok(content.includes("new Set(['en', ...fomoTrPendingLangs])"));
  assert.ok(!debotContent.includes("/[一-鿿]/.test(raw)"));
  assert.ok(content.includes('primeVisibleFomoTranslators();'));
  assert.ok(content.includes('`${fomoStats.thesisCount} 条观点`'));
});

await test('StonkFun RWA 目录只接受 xstock 且保留 Solana mint 大小写', () => {
  const fn = extractFunction(background, 'compactStonkfunRwaCatalog');
  const mint = 'XsaBXg8dU5cPM6ehmVctMkVqoiRG2ZjMo1cyBJ3AykQ';
  const items = evaluate([fn], `compactStonkfunRwaCatalog({ quoteTokens: [
    { quoteMint: '${mint}', symbol: 'KOx', name: 'COCA COLA', decimals: 8, category: 'xstock' },
    { quoteMint: '9cwDTUQAEp2917QFBXkatiiUkpqGrPLi2QfF5HsxTEii', symbol: 'MEME', name: 'Meme', decimals: 6, category: 'custom' },
    { quoteMint: 'bad', symbol: 'FAKE', name: 'Fake', category: 'xstock' }
  ] })`);
  assert.equal(items.length, 1);
  assert.equal(items[0].address, mint);
  assert.equal(items[0].symbol, 'KOx');
  assert.equal(items[0].name, 'COCA COLA');
  assert.equal(items[0].decimals, 8);
  assert.equal(items[0].source, 'stonkfun');
  assert.ok(background.includes("message?.type === 'stonkfun-rwa-catalog'"));
  assert.ok(manifest.host_permissions.includes('https://www.stonkfun.xyz/*'));
  assert.ok(privacy.includes('/api/quote-tokens'));
});

await test('StonkFun 底池按精确 mint 匹配并在同页浮窗展示 Solana 池资料', () => {
  const metaFn = extractFunction(content, 'stonkfunPoolMeta');
  const meta = evaluate([metaFn], `stonkfunPoolMeta({
    address: '9cwDTUQAEp2917QFBXkatiiUkpqGrPLi2QfF5HsxTEii', symbol: 'MENTOS',
    pool: {
      base_address: '9cwDTUQAEp2917QFBXkatiiUkpqGrPLi2QfF5HsxTEii', base_symbol: 'MENTOS',
      quote_address: 'XsaBXg8dU5cPM6ehmVctMkVqoiRG2ZjMo1cyBJ3AykQ', quote_symbol: 'KOx',
      pool_address: 'BqRRJtcbH9tiA6sYKmVBirjEbNASs5v1X7pf1HbP3Z8x', exchange: 'ray_clmm',
      liquidity: '29496.95', base_reserve: '365158637', quote_reserve: '114.505',
      initial_base_reserve: '13.015', initial_quote_reserve: '818241132',
      base_reserve_value: '16388', quote_reserve_value: '0', creation_timestamp: 1785893862
    }
  })`);
  assert.equal(meta.ok, true);
  assert.equal(meta.quoteAddress, 'XsaBXg8dU5cPM6ehmVctMkVqoiRG2ZjMo1cyBJ3AykQ');
  assert.equal(meta.quoteSymbol, 'KOx');
  assert.equal(meta.exchange, 'ray_clmm');
  assert.equal(meta.createdAtMs, 1785893862000);

  const scan = extractFunction(content, 'scanStonkfunRwaPoolLinks');
  assert.ok(scan.includes('stonkfunRwaCatalog.get(address)'));
  assert.ok(scan.includes('shown !== expected'));
  assert.ok(scan.includes('gdhStonkfunRwaMint'));
  assert.ok(!scan.includes('toLowerCase()'));
  const show = extractFunction(content, 'showRobinhoodRwaPopover');
  assert.ok(show.includes("['池类型'"));
  assert.ok(show.includes("['总流动性'"));
  assert.ok(show.includes("['池中数量'"));
  assert.ok(show.includes("['底池创建'"));
});

await test('FOMO 当前热门通过用户登录态 POST 拉取并压缩公开代币字段', () => {
  const fn = extractFunction(background, 'compactFomoTrendingItems');
  const items = evaluate([fn], `compactFomoTrendingItems([
    { change24: '-0.1307', holders: 100, liquidity: '2000', marketCap: '3000', priceUSD: '0.82', volume24: '4000', createdAt: 123,
      token: { address: '0x39dbed3a2bd333467115de45665cc57f813c4571', networkId: 4663, symbol: 'PONS', name: 'Pons', info: { imageSmallUrl: 'https://img.example/pons.png' } } },
    { change24: '0.2', marketCap: '5000', priceUSD: '0.01',
      token: { address: '9cwDTUQAEp2917QFBXkatiiUkpqGrPLi2QfF5HsxTEii', networkId: 1399811149, symbol: 'MENTOS', name: 'Mentos', info: {} } },
    { token: { address: 'bad', networkId: 4663, symbol: 'FAKE' } }
  ])`);
  assert.equal(items.length, 2);
  assert.equal(items[0].chain, 'robinhood');
  assert.equal(items[0].change24Ratio, -0.1307);
  assert.equal(items[1].chain, 'sol');
  assert.equal(items[1].address, '9cwDTUQAEp2917QFBXkatiiUkpqGrPLi2QfF5HsxTEii');
  const fetchTrending = extractFunction(background, 'fomoFetchTrending');
  assert.ok(fetchTrending.includes("'/proxy/trendingTokens'"));
  assert.ok(fetchTrending.includes("{ method: 'POST' }"));
  assert.ok(fetchTrending.includes("reason: 'no-token'"));
  assert.ok(fetchTrending.includes('if (fomoTrendingPending) return fomoTrendingPending'));
  assert.ok(fetchTrending.includes('fomoTrendingPending = null'));
  assert.ok(background.includes("message?.type === 'fomo-trending'"));
});

await test('GMGN 热门面板新增 fomo 标签且登录失败时提供推荐登录引导', () => {
  const mount = extractFunction(content, 'fomoTrendingMount');
  const scan = extractFunction(content, 'scanFomoTrendingTab');
  const poll = extractFunction(content, 'pollFomoTrending');
  const render = extractFunction(content, 'renderFomoTrendingPanel');
  const blockKey = extractFunction(content, 'fomoTrendingBlockKey');
  assert.ok(mount.includes('[data-testid="filter-tag-trending"]'));
  assert.ok(mount.includes('let cursor = tabs.parentElement'));
  assert.ok(mount.includes('child.getBoundingClientRect().height >= 80'));
  assert.ok(scan.includes("tab.textContent = 'fomo'"));
  assert.ok(scan.includes('activateFomoTrending'));
  const remove = extractFunction(content, 'removeFomoTrendingUi');
  assert.ok(remove.includes('[data-testid="gdh-fomo-trending"], .gdh-fomo-trending-panel'));
  assert.ok(remove.includes('.gdh-fomo-trending-native-hidden'));
  assert.ok(poll.includes("type: 'fomo-trending'"));
  assert.ok(render.includes("window.open('https://fomo.family/r/Unipioneer'"));
  assert.ok(render.includes('gdhSpaNavigate(`/${targetChain}/token/${item.address}`)'));
  assert.ok(render.includes('fomoTrendingItems.filter((item) => !isFomoTrendingBlocked(item))'));
  assert.ok(render.includes("block.className = 'gdh-fomo-trending__block'"));
  assert.ok(render.includes('blockFomoTrendingToken(item)'));
  assert.ok(render.includes('persistFomoTrendingBlockedTokens([])'));
  assert.ok(!render.includes('toggleBlockedToken(item.address, item.symbol)'));
  const blockKeys = evaluate([blockKey], `({
    bsc: fomoTrendingBlockKey(56, '0xAbCd'),
    base: fomoTrendingBlockKey(8453, '0xAbCd'),
    sol: fomoTrendingBlockKey(1399811149, 'AbCd'),
  })`);
  assert.deepEqual(JSON.parse(JSON.stringify(blockKeys)), {
    bsc: '56:0xabcd', base: '8453:0xabcd', sol: '1399811149:AbCd',
  });
  assert.ok(styles.includes('.gdh-fomo-trending-native-hidden'));
  assert.ok(styles.includes('.gdh-fomo-trending-panel.is-active'));
  assert.ok(styles.includes('.gdh-fomo-trending__block'));
  assert.ok(styles.includes('.gdh-fomo-trending__meta-actions'));
  assert.ok(popup.includes("enableFomoTrending: document.querySelector('#enable-fomo-trending')"));
  assert.ok(content.includes('enableFomoTrending: true'));
  assert.ok(content.includes('fomoTrendingBlockedTokens: []'));
});

await test('FOMO 官方接口全局串行且 429 后断路退避', async () => {
  const functions = [
    extractFunction(background, 'fomoLoadRateLimit'),
    extractFunction(background, 'fomoRetryAfterMs'),
    extractFunction(background, 'fomoBackoffResponse'),
    extractFunction(background, 'fomoQueuedFetch'),
  ];
  const persisted = [];
  const result = await evaluate(functions, `(async () => {
    let active = 0;
    let maxActive = 0;
    let calls = 0;
    const request = async (status) => {
      calls += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 8));
      active -= 1;
      return new Response('', {
        status,
        headers: status === 429 ? { 'Retry-After': '120' } : {},
      });
    };
    const normal = await Promise.all([
      fomoQueuedFetch(() => request(200)),
      fomoQueuedFetch(() => request(200)),
    ]);
    const limited = await fomoQueuedFetch(() => request(429));
    let blockedCalls = 0;
    const blocked = await fomoQueuedFetch(() => {
      blockedCalls += 1;
      return request(200);
    });
    return {
      maxActive,
      calls,
      normal: normal.map((response) => response.status),
      limited: limited.status,
      blocked: blocked.status,
      blockedCalls,
      synthetic: blocked.headers.get('X-GDH-Fomo-Backoff'),
      retryAfter: Number(blocked.headers.get('Retry-After')),
      persisted: persisted.length,
    };
  })()`, {
    Response,
    setTimeout,
    FOMO_REQUEST_GAP_MS: 5,
    FOMO_429_BASE_MS: 60 * 1000,
    FOMO_429_MAX_MS: 30 * 60 * 1000,
    FOMO_RATE_LIMIT_KEY: 'fomoRateLimitStateV1',
    fomoRequestTail: Promise.resolve(),
    fomoNextRequestAt: 0,
    fomoRateLimitUntil: 0,
    fomoRateLimitLevel: 0,
    fomoRateLimitLastAt: 0,
    fomoRateLimitReady: null,
    persisted,
    chrome: {
      storage: { local: {
        get: async () => ({}),
        set: async (value) => { persisted.push(value); },
      } },
    },
  });
  assert.equal(result.maxActive, 1);
  assert.deepEqual([...result.normal], [200, 200]);
  assert.equal(result.limited, 429);
  assert.equal(result.blocked, 429);
  assert.equal(result.blockedCalls, 0);
  assert.equal(result.calls, 3);
  assert.equal(result.synthetic, '1');
  assert.ok(result.retryAfter >= 60);
  assert.equal(result.persisted, 1);
  assert.ok(background.includes("rateLimited ? 'rate-limited'"));
  assert.ok(content.includes("reason === 'rate-limited'"));
  assert.ok(debotContent.includes("reason === 'rate-limited'"));

  const sharedState = { calls: 0 };
  const shared = await evaluate(
    [extractFunction(background, 'fomoFetchTokenShared')],
    `(async () => {
      const payload = { kind: 'holders', networkId: 56, tokenAddress: '0xabc' };
      const values = await Promise.all([fomoFetchTokenShared(payload), fomoFetchTokenShared(payload)]);
      return { values, pending: fomoTokenPending.size };
    })()`,
    {
      fomoTokenPending: new Map(),
      fomoFetchToken: async () => {
        sharedState.calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 8));
        return { ok: true, count: 1 };
      },
      setTimeout,
    },
  );
  assert.equal(sharedState.calls, 1);
  assert.equal(shared.values.length, 2);
  assert.equal(shared.pending, 0);
  assert.match(background, /FOMO_CACHE_MS = 90 \* 1000/);
  assert.match(content, /FOMO_REFRESH_MS = 2 \* 60 \* 1000/);
  assert.match(content, /FOMO_TRENDING_REFRESH_MS = 60 \* 1000/);
  assert.match(debotContent, /PANEL_REFRESH_MS = 2 \* 60 \* 1000/);
});

await test('GMGN 监控全链聚合完整接线且不触碰既有 FOMO/Pump 路径', () => {
  const gmgnMain = manifest.content_scripts.find(
    (entry) => entry.world === 'MAIN' && entry.matches.includes('https://gmgn.ai/*'),
  );
  const gmgnIsolated = manifest.content_scripts.find(
    (entry) => !entry.world && entry.matches.includes('https://gmgn.ai/*'),
  );
  assert.ok(gmgnMain.js.includes('monitor-aggregate.js'));
  assert.equal(gmgnMain.run_at, 'document_start');
  assert.ok(gmgnIsolated.css.includes('monitor-aggregate.css'));
  assert.ok(releaseBuild.includes("'monitor-aggregate.js'"));
  assert.ok(releaseBuild.includes("'monitor-aggregate.css'"));
  assert.ok(monitorAggregate.includes("const MONITOR_SELECTOR = '[data-sentry-component=\"Monitor\"]'"));
  assert.ok(monitorAggregate.includes("tab.textContent.trim() === '监控'"));
  assert.ok(monitorAggregateStyles.includes('[data-gdh-monitor-content-host="1"] > :not(.gdh-monitor-aggregate)'));
  assert.ok(monitorAggregate.includes("const NAV_ATTR = 'data-gdh-nav'"));
  assert.ok(monitorAggregate.includes("document.dispatchEvent(new Event('gdh-navigate'))"));
  for (const selector of ['.gdh-fomo-trending-panel', '.gdh-monitor-aggregate', '.gdh-flap-row']) {
    assert.ok(content.includes(selector));
  }
  assert.ok(extractFunction(bridge, 'startDomScanner').includes("target?.closest('.gdh-monitor-aggregate')"));
  assert.ok(privacy.includes('既有共享 WebSocket'));
  assert.ok(!monitorAggregate.includes('chrome.runtime'));
  assert.ok(!monitorAggregate.includes('985monitor'));
});

await test('全链监控归一化链地址并复用 GMGN 共享流与限频快照', () => {
  const functions = [
    extractFunction(monitorAggregate, 'sanitizeWallet'),
    extractFunction(monitorAggregate, 'sanitizeCard'),
    extractFunction(monitorAggregate, 'cardKey'),
    extractFunction(monitorAggregate, 'netInflow'),
  ];
  const value = evaluate(functions, `(() => {
    const card = sanitizeCard('robinhood', {
      address: '0xAbC', symbol: 'RWA', price: '2', total_supply: '1000',
      wallets: [
        { wallet_address: '0x1', net_inflow: '120.5', timestamp: 20 },
        { wallet_address: '0x2', net_inflow: '-30', timestamp: 21 },
      ],
    });
    return {
      card,
      key: cardKey(card),
      inflow: netInflow(card),
      liveSell: sanitizeWallet({ maker: '0x3', side: 'transfer_out', amount_usd: '19.5' }),
    };
  })()`);
  const normalized = JSON.parse(JSON.stringify(value));
  assert.equal(normalized.card.chain, 'robinhood');
  assert.equal(normalized.card.marketCap, 0);
  assert.equal(normalized.card.price, 2);
  assert.equal(normalized.key, 'robinhood:0xabc');
  assert.equal(normalized.inflow, 90.5);
  assert.equal(normalized.liveSell.netInflow, -19.5);
  assert.ok(monitorAggregate.includes('getFollowWalletShareObservable()'));
  assert.ok(monitorAggregate.includes('followSocket?.subscribedChains'));
  assert.ok(monitorAggregate.includes("source.includes('name:\"follow_cards\"')"));
  assert.ok(monitorAggregate.includes("String(value).includes('monitorCardsV3')"));
  assert.match(monitorAggregate, /SNAPSHOT_TTL_MS = 30_000/);
  assert.match(monitorAggregate, /LIVE_REFRESH_MIN_MS = 8_000/);
  assert.ok(monitorAggregate.includes('Math.min(3, chains.length)'));
  assert.ok(monitorAggregate.includes('chainRefreshTimers.has(chain) || chainsFetching.has(chain)'));
  assert.ok(extractFunction(monitorAggregate, 'fetchChain').includes('chainsFetching.add(chain)'));
  assert.ok(extractFunction(monitorAggregate, 'fetchChain').includes('chainsFetching.delete(chain)'));
  assert.ok(monitorAggregate.includes('if (fullFetchRunning && !force) return'));
  assert.ok(extractFunction(monitorAggregate, 'scan').includes('else if (entering || !lastFullFetchAt)'));
  assert.ok(extractFunction(monitorAggregate, 'restoreNative').includes('stopLiveSubscription()'));
  assert.ok(monitorAggregate.includes("document.visibilityState === 'hidden') stopLiveSubscription()"));
  assert.ok(!monitorAggregate.includes('new WebSocket'));
  assert.ok(!monitorAggregate.includes('setInterval(fetch'));
});

await test('全链监控可开关并沿用 GMGN 当前筛选条件', () => {
  assert.ok(popupHtml.includes('id="enable-monitor-aggregate"'));
  assert.ok(popup.includes('enableMonitorAggregate: true'));
  assert.ok(popup.includes("enableMonitorAggregate: document.querySelector('#enable-monitor-aggregate')"));
  assert.ok(content.includes('enableMonitorAggregate: true'));
  assert.ok(content.includes("const MONITOR_AGGREGATE_ATTR = 'data-gdh-monitor-aggregate-enabled'"));
  assert.ok(content.includes("document.dispatchEvent(new Event('gdh-monitor-config-changed'))"));
  assert.ok(monitorAggregate.includes("const CONFIG_ATTR = 'data-gdh-monitor-aggregate-enabled'"));
  assert.ok(extractFunction(monitorAggregate, 'scan').includes('isAggregateEnabled()'));
  assert.ok(monitorAggregate.includes("source.includes('is_open_or_close')"));
  assert.ok(monitorAggregate.includes("source.includes('walletCount')"));
  assert.ok(extractFunction(monitorAggregate, 'findCardFilter').includes('cardFilter'));
  assert.ok(extractFunction(monitorAggregate, 'readNativeMonitorFilter').includes('findCardFilter'));
  assert.ok(extractFunction(monitorAggregate, 'applyNativeMonitorFilter').includes('nativeFilterCards'));
  assert.ok(extractFunction(monitorAggregate, 'fetchChain').includes('applyNativeMonitorFilter'));
});

await test('GMGN 追踪人名防误触默认关闭且不影响币名', () => {
  assert.ok(popupHtml.includes('id="disable-tracker-person-navigation"'));
  assert.ok(popup.includes('disableTrackerPersonNavigation: false'));
  assert.ok(content.includes('disableTrackerPersonNavigation: false'));
  assert.ok(popup.includes(
    "disableTrackerPersonNavigation: document.querySelector('#disable-tracker-person-navigation')",
  ));
  const guard = extractFunction(content, 'preventTrackerPersonNavigation');
  assert.ok(guard.includes("settings.disableTrackerPersonNavigation !== true"));
  assert.ok(guard.includes('event.preventDefault()'));
  assert.ok(guard.includes('event.stopImmediatePropagation()'));
  assert.ok(content.includes("document.addEventListener('click', preventTrackerPersonNavigation, true)"));

  const classify = extractFunction(content, 'isTrackerPersonNavigationTarget');
  const normalize = extractFunction(content, 'trackerPersonNameText');
  const result = evaluate([normalize, classify], `(() => {
    class FakeElement {
      constructor(kind, card = null, parent = null, text = '') {
        this.kind = kind;
        this.card = card;
        this.parentElement = parent;
        this.textContent = text;
        this.dataset = kind === 'card' ? { gdhTrackNick: '阿峰' } : {};
      }
      closest(selector) {
        if (selector.includes('.gdh-star-button') && this.kind === 'plugin') return this;
        if (selector === TRACKER_MAKER_CELL && this.kind === 'maker') return this;
        if (selector === 'a[href*="/address/"]' && this.kind === 'wallet-link') return this;
        if (selector.includes(TRACKER_ITEM_SELECTOR) || selector.includes(TRACKER_DATA_SELECTOR)) {
          return this.kind === 'card' ? this : this.card;
        }
        return null;
      }
      contains(node) { return node === this || node.card === this; }
    }
    const card = new FakeElement('card');
    const maker = new FakeElement('maker', card, card, '阿峰');
    const wallet = new FakeElement('wallet-link', card, card, '阿峰');
    const nick = new FakeElement('nick', card, card, '阿峰');
    const token = new FakeElement('token', card, card, 'MORALS');
    const plugin = new FakeElement('plugin', card, card, '☆');
    return {
      maker: isTrackerPersonNavigationTarget(maker),
      wallet: isTrackerPersonNavigationTarget(wallet),
      nick: isTrackerPersonNavigationTarget(nick),
      token: isTrackerPersonNavigationTarget(token),
      plugin: isTrackerPersonNavigationTarget(plugin),
    };
  })()`, {
    Element: class {},
    TRACKER_MAKER_CELL: '[data-testid="follow-tracking-row-maker"]',
    TRACKER_PERSON_CONTROL_SELECTOR: '.gdh-star-button, .gdh-color-button, .gdh-tokenblock',
    TRACKER_ITEM_SELECTOR: '[data-sentry-component="TrackerListItem"]',
    TRACKER_DATA_SELECTOR: '[data-gdh-track-addr][data-gdh-track-ts]',
  });
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    maker: true,
    wallet: true,
    nick: true,
    token: false,
    plugin: false,
  });
});

await test('K 线左上角纵向展示追踪持仓前五名并保留空状态', () => {
  const functions = [
    extractFunction(monitorAggregate, 'sanitizeTrackedHolding'),
    extractFunction(monitorAggregate, 'extractTrackedHoldingRows'),
    extractFunction(monitorAggregate, 'trackedWalletKey'),
    extractFunction(monitorAggregate, 'applyTrackedHoldingMark'),
    extractFunction(monitorAggregate, 'formatHoldingPercent'),
    extractFunction(monitorAggregate, 'formatSignedMoney'),
    extractFunction(monitorAggregate, 'formatSignedPercent'),
  ];
  const value = evaluate(functions, `(() => ({
    holding: sanitizeTrackedHolding({
      address: '0x1234567890abcdef', twitter_name: '阿峰', amount_percentage: '0.0049',
      profit: '1970', profit_change: '1.5565', balance: '1200',
    }),
    marked: applyTrackedHoldingMark({
      address: '0xABC', name: null, amount_percentage: '0.0049', balance: '1200',
    }, { '0xabc': { mark: '测试钱包', image: 'avatar.png' } }, 'bsc'),
    soldOut: sanitizeTrackedHolding({
      address: '0xsold', name: '已清仓', amount_percentage: '0', balance: '0',
    }),
    percent: formatHoldingPercent(0.0049),
    profit: formatSignedMoney(1970),
    pnl: formatSignedPercent(1.5565),
  }))()`);
  const normalized = JSON.parse(JSON.stringify(value));
  assert.equal(normalized.holding.name, '阿峰');
  assert.equal(normalized.holding.holdingPercent, 0.49);
  assert.equal(normalized.marked.remark, '测试钱包');
  assert.equal(normalized.marked.avatar, 'avatar.png');
  assert.equal(normalized.soldOut, null);
  assert.equal(normalized.percent, '0.49%');
  assert.equal(normalized.profit, '+$1.97K');
  assert.equal(normalized.pnl, '+155.65%');
  const responseRows = evaluate(
    [extractFunction(monitorAggregate, 'extractTrackedHoldingRows')],
    "extractTrackedHoldingRows({ list: [{ address: 'tracked-wallet' }], next: '' })",
  );
  assert.equal(JSON.parse(JSON.stringify(responseRows))[0].address, 'tracked-wallet');
  assert.ok(monitorAggregate.includes("source.includes('/vas/api/v1/token_holders/')"));
  assert.match(monitorAggregate, /limit:\s*5/);
  assert.match(monitorAggregate, /following:\s*true/);
  assert.match(monitorAggregate, /following:\s*true,\s*needToken:\s*true/);
  assert.ok(monitorAggregate.includes("source.includes('getMemoryAtom')"));
  assert.ok(monitorAggregate.includes("const CHART_HOLDINGS_SELECTOR = '.chart-anchor-main'"));
  assert.ok(monitorAggregateStyles.includes('.gdh-chart-tracked-holdings'));
  assert.ok(monitorAggregateStyles.includes('pointer-events: none'));
  assert.match(monitorAggregateStyles, /\.gdh-chart-tracked-holdings\s*\{[^}]*right:\s*auto;[^}]*flex-direction:\s*column;/s);
  assert.match(monitorAggregateStyles, /\.gdh-chart-tracked-holdings\s*\{[^}]*z-index:\s*(?:80[1-9]|8[1-9]\d|9\d\d|[1-9]\d{3,});/s);
  assert.ok(monitorAggregateStyles.includes('.gdh-chart-tracked-holdings.is-empty'));
  assert.ok(monitorAggregate.includes('holding.name'));
  assert.ok(monitorAggregate.includes('holding.holdingPercent'));
  assert.ok(monitorAggregate.includes('holding.profit'));
  assert.ok(monitorAggregate.includes('holding.profitPercent'));
  const chartRender = extractFunction(monitorAggregate, 'renderChartHoldings');
  assert.ok(chartRender.includes('.slice(0, 5)'));
  assert.ok(chartRender.includes("element.classList.add('is-empty')"));
  assert.ok(chartRender.includes('暂无追踪持仓'));
  const chartScan = extractFunction(monitorAggregate, 'scanChartHoldings');
  const unavailableBranch = chartScan.match(/if \(!discoverTrackedHolderApi\(\)\)[^;]*;/)?.[0] || '';
  assert.ok(unavailableBranch.includes('return'));
  assert.ok(!unavailableBranch.includes('chartHoldingsFetchedAt'));
});

await test('Flap 底池保留完整计价币符号并区分分红、创作者与金库', () => {
  const functions = [
    extractFunction(content, 'flapSym'),
    extractFunction(content, 'flapPoolSym'),
    extractFunction(content, 'flapMarketMode'),
    extractFunction(content, 'flapSegPct'),
    extractFunction(content, 'flapMode'),
    extractFunction(content, 'flapBadgeText'),
  ];
  const value = evaluate(functions, `(() => {
    const creator = { quoteSymbol: 'SPCXB', dist: {
      dividendBps: 0, lpBps: 0, deflationBps: 0, marketBps: 10000,
      marketRecipients: [], isVault: false,
    } };
    const vault = { quoteSymbol: 'HIMSB', dist: {
      dividendBps: 0, lpBps: 0, deflationBps: 0, marketBps: 10000,
      marketRecipients: [], isVault: true,
    } };
    const holder = { quoteSymbol: 'AAPLB', dividendSymbol: 'AAPLB', dist: {
      dividendBps: 10000, lpBps: 0, deflationBps: 0, marketBps: 0,
      marketRecipients: [], isVault: null,
    } };
    const unknown = { quoteSymbol: 'BNC4', dist: {
      dividendBps: 0, lpBps: 0, deflationBps: 0, marketBps: 10000,
      marketRecipients: [], isVault: null,
    } };
    return {
      creatorMode: flapMode(creator.dist), creator: flapBadgeText(creator),
      vaultMode: flapMode(vault.dist), vault: flapBadgeText(vault),
      holder: flapBadgeText(holder), wrapped: flapPoolSym('WBNB'),
      unknownMode: flapMode(unknown.dist), unknown: flapBadgeText(unknown),
    };
  })()`);
  const normalized = JSON.parse(JSON.stringify(value));
  assert.equal(normalized.creatorMode.cls, 'creator');
  assert.equal(normalized.creator, '🪙SPCXB | 👨‍🍳→SPCX');
  assert.equal(normalized.vaultMode.cls, 'gift');
  assert.equal(normalized.vault, '🪙HIMSB | 🎁→HIMS');
  assert.equal(normalized.holder, '🪙AAPLB | 💎→AAPL');
  assert.equal(normalized.wrapped, 'BNB');
  assert.equal(normalized.unknownMode.cls, 'market');
  assert.equal(normalized.unknown, '🪙BNC4 | 💰→BNC4');
  assert.ok(styles.includes('.gdh-flap.is-creator'));
  assert.ok(styles.includes('.gdh-flap.is-market'));
});

await test('Flap 链上 symbol 按 UTF-8 解码并限制异常长度', () => {
  const functions = [extractFunction(background, 'flapWords'), extractFunction(background, 'flapString')];
  const word = (hex) => hex.padStart(64, '0');
  const encoded = `0x${word('20')}${word('6')}${'e4b8ade69687'.padEnd(64, '0')}`;
  assert.equal(evaluate(functions, `flapString(${JSON.stringify(encoded)})`, { TextDecoder, Uint8Array }), '中文');
  const invalid = `0x${word('20')}${word('41')}${''.padEnd(128, '0')}`;
  assert.equal(evaluate(functions, `flapString(${JSON.stringify(invalid)})`, { TextDecoder, Uint8Array }), '');
});

await test('Flap Lens 能从链上 ABI 区分普通创作者收款与真实金库', () => {
  const functions = [
    extractFunction(background, 'flapWords'),
    extractFunction(background, 'flapVaultInfo'),
  ];
  const word = (hex) => hex.replace(/^0x/, '').padStart(64, '0');
  const vaultAddress = '0xe8a4c3c8a10afcc1aa0b8f858662233754fa2b58';
  const factoryAddress = '0x1234567890abcdef1234567890abcdef12345678';
  const noVault = `0x${word('0')}${word('40')}${word('0')}${word('0')}`;
  const withVault = `0x${word('1')}${word('40')}${word(vaultAddress)}${word(factoryAddress)}${word('60')}`;
  const value = evaluate(functions, `({
    noVault: flapVaultInfo(${JSON.stringify(noVault)}),
    withVault: flapVaultInfo(${JSON.stringify(withVault)}),
    malformed: flapVaultInfo('0x01'),
  })`);
  assert.deepEqual(JSON.parse(JSON.stringify(value)), {
    noVault: { known: true, isVault: false, vaultAddress: '', vaultFactory: '' },
    withVault: { known: true, isVault: true, vaultAddress, vaultFactory: factoryAddress },
    malformed: { known: false, isVault: null, vaultAddress: '', vaultFactory: '' },
  });
  assert.ok(background.includes("const FLAP_LENS = '0x90497450f2a706f1951b5bdda52b4e5d16f34c06'"));
  assert.match(background, /async function flapTokenInfo[\s\S]*FLAP_SEL\.vaultInfo[\s\S]*Object\.assign\(dist, flapVaultInfo\(vaultRaw\)\)/);
});

await test('Flap 成功结果定时刷新、失败保留旧值且 RPC 只用实测可用节点', () => {
  const request = extractFunction(content, 'requestFlapInfo');
  assert.ok(content.includes('const FLAP_SUCCESS_TTL = 5 * 60 * 1000'));
  assert.ok(request.includes('cached.fetchedAt'));
  assert.ok(request.includes('fetchedAt: Date.now()'));
  assert.ok(request.includes('if (!cached?.ok)'));
  assert.ok(background.includes("'https://rpc-bsc.48.club'"));
  assert.ok(background.includes("'https://bsc.rpc.blxrbdn.com'"));
  assert.ok(!background.includes("'https://bsc-dataseed1.defibit.io'"));
  assert.ok(!background.includes("'https://bsc-dataseed1.ninicoin.io'"));
});

await test('战壕 Flap 税标只使用原生槽位，不额外插行或回退到整卡', () => {
  const scan = extractFunction(content, 'scanFlapBadges');
  const trench = scan.slice(scan.indexOf('document.querySelectorAll(CARD_SELECTOR)'), scan.indexOf('// 追踪流'));
  assert.ok(trench.includes('flapTrenchOwnRow(card, native)'));
  assert.ok(trench.includes('if (!flapInfoCache.get(token)?.ok)'));
  assert.ok(trench.includes('card.dataset.gdhFlapKey !== token'));
  assert.ok(!trench.includes('row || card'));
  assert.ok(!trench.includes('flapOwnRow(card, native)'));
  const mount = extractFunction(content, 'flapTrenchOwnRow');
  assert.ok(mount.includes('row.previousElementSibling !== native'));
  assert.ok(mount.includes('delete card.dataset.gdhFlapRoom'));
  assert.ok(!mount.includes('getBoundingClientRect'));
  assert.ok(styles.includes('.gdh-flap-row.gdh-flap-row--trench'));
});

await test('Flap 税标清理恢复原生元素，并避免稳定扫描反复改写文字', () => {
  const clear = extractFunction(content, 'clearFlapCard');
  assert.ok(clear.includes("querySelectorAll('[data-gdh-flap-native]').forEach(restoreFlapNative)"));
  assert.ok(clear.includes('data-gdh-flap-slot'));
  assert.ok(clear.includes('delete card.dataset.gdhFlapKey'));
  const ensure = extractFunction(content, 'ensureFlapBadge');
  assert.ok(ensure.includes('if (badge.textContent !== text)'));
  assert.ok(ensure.includes('if (badge.title !== title)'));
  assert.ok(!ensure.includes("setProperty('display'"));
});

await test('相似币请求有并发上限、超时释放和失败保留旧数据', async () => {
  const requests = [];
  const timers = new Map();
  const cache = new Map([['bsc|0xaaa', { at: 0, data: { name: 'old quote' } }]]);
  const ctx = vm.createContext({
    similarTokenMetaCache: cache, similarTokenMetaPending: new Set(), similarTokenActiveRequests: 0,
    SIMILAR_TOKEN_MAX_REQUESTS: 2, SIMILAR_TOKEN_BATCH_MAX: 50, SIMILAR_TOKEN_CACHE_MAX: 400,
    SIMILAR_TOKEN_META_TTL: 60000, SIMILAR_TOKEN_ERROR_TTL: 15000, SIMILAR_TOKEN_REQUEST_TIMEOUT: 12000,
    AbortController, gmgnApiQuery: () => 'device_id=offline-test', scheduleScan() {},
    window: { setTimeout(fn) { timers.set(timers.size + 1, fn); return timers.size; }, clearTimeout(id) { timers.delete(id); } },
    setBoundedMap: (map, key, value) => map.set(key, value),
    fetch: (url, options) => { requests.push(JSON.parse(options.body)); return new Promise((resolve, reject) => { options.signal.addEventListener('abort', () => reject(new Error('aborted'))); }); },
  });
  vm.runInContext(['trackingFeedNormalizedAddress', 'similarTokenMetaKey', 'similarTokenMetaFromApi', 'requestSimilarTokenMeta']
    .map((name) => extractFunction(content, name)).join('\n'), ctx);
  vm.runInContext(`requestSimilarTokenMeta([{chain:'bsc',address:'0xaaa'},{chain:'bsc',address:'0xaaa'},{chain:'base',address:'0xbbb'},{chain:'eth',address:'0xccc'}])`, ctx);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0].addresses, ['0xaaa']);
  [...timers.values()].forEach((fn) => fn());
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ctx.similarTokenActiveRequests, 0);
  assert.equal(ctx.similarTokenMetaPending.size, 0);
  assert.equal(cache.get('bsc|0xaaa').data.name, 'old quote');
  assert.equal(cache.get('bsc|0xaaa').failed, true);
});

await test('浮窗无刷新导航不启用原 450ms 强制跳转兜底', () => {
  let timers = 0;
  const attrs = new Map();
  const location = { origin: 'https://gmgn.ai', pathname: '/base/token/old', href: '' };
  evaluate([extractFunction(content, 'gdhSpaNavigate')], "gdhSpaNavigate('/bsc/token/new', true)", {
    location, URL, Event: class {}, document: { documentElement: { setAttribute: (k, v) => attrs.set(k, v), removeAttribute: (k) => attrs.delete(k) }, dispatchEvent() {} },
    window: { setTimeout() { timers++; } },
  });
  assert.equal(timers, 0);
  assert.equal(location.href, '');
  assert.equal(attrs.get('data-gdh-nav-spa-only'), '1');
});

await test('独立扫描异常不再阻断 FOMO/Pump 等后续模块', () => {
  const calls = [];
  const extras = { lastFullScanAt: 0, scanCostEma: 0, trackerCardsScanCache: null, trackerCardsScanCacheActive: false,
    CARD_SELECTOR: '.card', performance: { now: () => 1 }, document: { querySelectorAll: () => [], documentElement: { getAttribute() {}, setAttribute() {} } } };
  for (const name of ['applyCardState','scanCalloutBlacklist','scanManifestoToasts','ensureManifestoTab','scanSpecialWallets','scanTrackerTokenRelations','scanMarkedBadges','scanTokenHeaderBadges','scanFlapBadges','scanRobinhoodSearchBadges','scanRobinhoodRwaPoolLinks','scanFrontrunLightning','scanRemindToasts','scanHoldingSurge','scanFomoPanel','scanFomoTrendingTab','scanFomoFeed','scanAllPools']) extras[name] = () => calls.push(name);
  extras.scanSimilarTokenPanel = () => { throw new Error('simulated DOM replacement'); };
  evaluate([extractFunction(content, 'scanVisibleCards')], 'scanVisibleCards()', extras);
  assert.ok(calls.includes('scanFomoFeed') && calls.includes('scanAllPools'));
});

await test('原生黑名单只按链增删 ca，保留其它类别、满额拒绝且超时不写入', async () => {
  const states = new Map(['bsc','base','sol'].map((chain) => [chain, { dev: ['keep-dev'], ca: [], keyword: [], other: [] }]));
  let writes = 0;
  const store = { get() {}, sub() {}, set(atom, payload) { writes++; const s = states.get(payload.network); if (payload.itemsToAdd) s.ca.push(...payload.itemsToAdd.map(x => x.value)); if (payload.itemsToRemove) s.ca = s.ca.filter(x => !payload.itemsToRemove.some(y => y.value === x)); return { rejected: [], evicted: [] }; } };
  const api = { hydrate: async () => {}, snapshot: (get, chain) => states.get(chain), limit: 2, update: {} };
  const extras = { discoverNativeBlacklistApi: () => api, findNativeBlacklistStore: () => store,
    GDH_NAV_RE: vm.runInNewContext(bridge.match(/const GDH_NAV_RE = ([^;]+);/)[1]) };
  const funcs = [extractFunction(bridge, 'normalizeTokenStatAddress'), extractFunction(bridge, 'updateNativeTokenBlacklist')];
  const address = '0x' + 'A'.repeat(40);
  const call = (overrides = {}) => evaluate(funcs, `updateNativeTokenBlacklist(${JSON.stringify({ chain: 'bsc', address, action: 'add', expiresAt: Date.now() + 8000, ...overrides })})`, extras);
  assert.equal((await call()).ok, true);
  assert.equal(states.get('bsc').ca[0], address.toLowerCase());
  assert.equal((await call()).already, true);
  assert.equal(writes, 1);
  assert.equal((await call({address:'0x'+'b'.repeat(40)})).reason, 'full');
  assert.equal((await call({action:'remove',expiresAt:0})).reason, 'timeout');
  assert.equal(writes, 1);
  assert.equal((await call({chain:'sol'})).reason, 'invalid-token');
  assert.equal((await call({action:'remove'})).ok, true);
  assert.deepEqual(states.get('bsc').dev, ['keep-dev']);
  assert.deepEqual(states.get('base').ca, []);
});

await test('屏蔽按链隔离并保留 Solana 大小写，新设置带 NEW', () => {
  const set = new Set(['bsc|0xabc', '|legacy', 'sol|TokenABC']);
  const funcs = [extractFunction(content,'trackingFeedNormalizedAddress'),extractFunction(content,'isTokenBlocked')];
  const run = (address, chain) => evaluate(funcs, `isTokenBlocked('${address}','${chain}')`, {blockedTokenSet:set});
  assert.equal(run('0xABC','bsc'), true);
  assert.equal(run('0xabc','base'), false);
  assert.equal(run('TokenABC','sol'), true);
  assert.equal(run('tokenabc','sol'), false);
  assert.equal(run('legacy','base'), true);
  assert.ok(popup.includes('syncGmgnTokenBlacklist: true'));
  assert.match(popupHtml,/屏蔽同步 GMGN 黑名单[\s\S]*?NEW[\s\S]*?id="sync-gmgn-token-blacklist"/);
  const button = extractFunction(content,'ensureTokenBlockButton');
  assert.ok(button.includes('button.dataset.gdhTbAddr !== heldAddress'));
  assert.ok(button.includes('button.dataset.gdhTbChain !== heldChain'));
});

await test('相似币保留时长只接受 1/5/10/30 分钟，非法值回退 5 分钟', () => {
  for (const [value, expected] of [[1,1],[5,5],[10,10],[30,30],['10',10],[0,5],[-1,5],[Infinity,5],[null,5]]) {
    const result = evaluate([extractFunction(content, 'similarTokenRetentionMs')], 'similarTokenRetentionMs()',
      { settings: { similarTokenCacheMinutes: value } });
    assert.equal(result, expected * 60000);
  }
  assert.match(popupHtml, /相似币缓存保留[\s\S]*?NEW[\s\S]*?id="similar-token-cache-minutes"/);
  assert.ok(popup.includes('similarTokenCacheInput.value = String('));
  assert.ok(popup.includes('similarTokenCacheMinutes: [1, 5, 10, 30].includes('));
  assert.match(content, /similarTokenCacheMinutes:\s*5/);
  assert.match(popup, /similarTokenCacheMinutes:\s*5/);
});

await test('相似币显示缓存有容量上限，关闭清空且空追踪列表不增加行情请求', () => {
  const cache = new Map();
  const funcs = ['trackingFeedNormalizedAddress','similarTokenNormalizedName','similarTokenSimilarity',
    'similarTokenRows','similarTokenMetaKey','similarTokenCachedMeta','similarTokenRetentionMs',
    'retainedSimilarTokenRows','setBoundedMap'].map((name) => extractFunction(content, name));
  const current = {chain:'base',address:'0x'+'f'.repeat(40),name:'Flybook',symbol:'FLYBOOK',marketCap:1000};
  const rows = Array.from({length:410},(_,i)=>({chain:'bsc',address:'0x'+(i+1).toString(16).padStart(40,'0'),name:'Flybook',symbol:'FLYBOOK',marketCap:i}));
  const extras = {settings:{similarTokenCacheMinutes:5},similarTokenRetained:cache,
    similarTokenMetaCache:new Map(),similarTokenTrackQuotes:new Map(),SIMILAR_TOKEN_CACHE_MAX:400,isTokenBlocked:()=>false};
  evaluate(funcs, `retainedSimilarTokenRows(${JSON.stringify(current)},${JSON.stringify(rows)},1000000)`, extras);
  assert.equal(cache.size,400);
  const expired = evaluate(funcs, `retainedSimilarTokenRows(${JSON.stringify(current)},[],1300000)`, extras);
  assert.equal(cache.size,0);
  assert.equal(expired.length,0);
  const scan = extractFunction(content,'scanSimilarTokenPanel');
  assert.ok(scan.includes('similarTokenRetained.clear()'));
  assert.ok(scan.includes('if (candidates.length) requestSimilarTokenMeta('));
});


await test('DeBot 相似币元数据严格验证链和合约，读取 meta 名称与 pair 市值/底池', () => {
  const funcs = ['safeText','normalizeAddress','validImageUrl','similarTokenMetaFromApi'].map(n=>extractFunction(debotContent,n));
  const address = '0x'+'a'.repeat(40);
  const data = { token: { meta: { address, chain:'base',name:'The Flybook',symbol:'FLYBOOK',logo:address,total_supply:1e29 },market:{market_cap:0} },
    pair: { chain:'base',tokenAddress:address,tokenName:'Wrong fallback',tokenSymbol:'wrong',market_cap:135604.6488,totalSupply:1e11,price:0.000001356046488,base_token_symbol:'WETH',dex:{dex_name:'uniswapv4'} } };
  const run=(d,chain='base',ca=address)=>evaluate(funcs,`similarTokenMetaFromApi(${JSON.stringify(d)},'${chain}','${ca}')`);
  const value=run(data);
  assert.equal(value.name,'The Flybook'); assert.equal(value.symbol,'FLYBOOK');
  assert.equal(value.marketCap,135604.6488); assert.equal(value.poolSymbol,'WETH'); assert.equal(value.logo,'');
  assert.equal(run(data,'bsc'),null); assert.equal(run(data,'base','0x'+'b'.repeat(40)),null);
  data.pair.market_cap=0;assert.ok(Math.abs(run(data).marketCap-135604.6488)<0.01);
  assert.equal(run({pair:{tokenName:'missing identity'}}),null);
});

await test('DeBot 相似币默认关闭、复用设置、关闭时不请求且仅本地屏蔽', () => {
  assert.match(debotContent,/enableSimilarTokenPanel: false/);
  assert.match(debotContent,/similarTokenCacheMinutes: 5/);
  assert.match(debotContent,/\.gdh-debot-similar-token-panel/);
  let requests=0;
  evaluate([extractFunction(debotContent,'requestSimilarTokenMeta')],"requestSimilarTokenMeta([{chain:'base',address:'0xabc'}])",{
    settings:{enabled:true,enableSimilarTokenPanel:false},fetch:()=>{requests++;throw new Error('unexpected fetch');},
  });
  assert.equal(requests,0);
  assert.ok(!extractFunction(debotContent,'blockDebotSimilarToken').includes('native-token-blacklist'));
  assert.match(extractFunction(content,'scheduleSimilarTokenScan'),/requestAnimationFrame/);
  assert.match(content,/record.attributeName === 'data-gdh-track-mc'/);
});

process.stdout.write(`1..${passed}\n`);
