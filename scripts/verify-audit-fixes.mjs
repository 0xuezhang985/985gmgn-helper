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
const debotContent = read('debot-content.js');
const debotBridge = read('debot-bridge.js');
const debotStyles = read('debot-styles.css');
const manifest = JSON.parse(read('manifest.json'));
const releaseBuild = read('scripts/build-release.ps1');
const popup = read('popup.js');
const popupHtml = read('popup.html');
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

await test('滚动限频使用单个延时器而不是逐帧空转', () => {
  const contentRun = extractFunction(content, 'runScheduledScan');
  const bridgeRun = extractFunction(bridge, 'runScheduledScan');
  const run = (fn, gap) => {
    const state = { scans: 0, schedules: 0, wait: 0 };
    return evaluate([fn], `(() => {
    runScheduledScan();
    return { delay: scanDelayTimer, scans: state.scans, schedules: state.schedules, wait: state.wait };
  })()`, {
    scanRafId: 1,
    scanDelayTimer: 0,
    lastScanAt: 100,
    scrollingUntil: 500,
    scanScheduled: true,
    SCAN_MIN_GAP_SCROLLING: gap,
    Date: { now: () => 150 },
    Math,
    state,
    window: { setTimeout: (_fn, ms) => { state.wait = ms; return 7; } },
    scheduleScan: () => { state.schedules += 1; },
    scanCards: () => { state.scans += 1; },
  });
  };
  const contentResult = run(contentRun, 120);
  const bridgeResult = run(bridgeRun, 150);
  assert.equal(`${contentResult.delay}|${contentResult.scans}|${contentResult.schedules}|${contentResult.wait}`, '7|0|0|70');
  assert.equal(`${bridgeResult.delay}|${bridgeResult.scans}|${bridgeResult.schedules}|${bridgeResult.wait}`, '7|0|0|100');
});

await test('追踪流 mutation 重排合帧且隐藏标签不全量扫描', () => {
  assert.ok(content.includes('const fomoFeedScrollTargets = new WeakSet();'));
  assert.ok(content.includes('scheduleFomoFeedRowReflow();\n      scheduleScan();'));
  assert.ok(!content.includes('refreshFomoFeedFixedRowShifts();\n      }\n      scheduleScan();'));
  assert.ok(content.includes("if (document.visibilityState === 'hidden') return;"));
  assert.ok(bridge.includes("if (document.visibilityState === 'hidden') return;"));
  assert.ok(content.includes("if (document.visibilityState !== 'hidden') scanVisibleCards();"));
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
    fomoFeedCache: { events: [], updatedAt: 0, fetchedAt: 0 },
    state,
    fomoSseNotifyTabs: () => { state.calls += 1; },
  });
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { calls: 1, length: 1, key: 'fomo:replayed' });
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
    side: 'buy', tx: '0xtx', usd: 12.5, ts: 1700000000000,
  });
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
      documentElement: { setAttribute: (_name, value) => { nav = value; } },
      dispatchEvent: () => { location.pathname = '/'; },
    },
    window: { setTimeout: (callback) => callback() },
  });
  assert.equal(nav, target);
  assert.equal(location.href, target);
});

await test('DeBot 只注入追踪桥、混排脚本和 FOMO 小窗样式', () => {
  assert.ok(manifest.host_permissions.includes('https://debot.ai/*'));
  const debotScripts = manifest.content_scripts.filter((entry) => entry.matches.includes('https://debot.ai/*'));
  assert.equal(debotScripts.length, 2);
  const main = debotScripts.find((entry) => entry.world === 'MAIN');
  const isolated = debotScripts.find((entry) => entry.world !== 'MAIN');
  assert.deepEqual(main.js, ['debot-bridge.js']);
  assert.deepEqual(isolated.js, ['debot-content.js']);
  assert.deepEqual(isolated.css, ['debot-styles.css']);
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

await test('版本变更后只刷新一次已打开的支持站点标签页', async () => {
  const fn = extractFunction(background, 'refreshSupportedTabsAfterVersionChange');
  const reloaded = [];
  const saved = {};
  await evaluate([fn], 'refreshSupportedTabsAfterVersionChange()', {
    RUNNING_VERSION_KEY: 'gdhRunningVersion',
    chrome: {
      runtime: { getManifest: () => ({ version: '0.46.22' }) },
      storage: { local: {
        get: async () => ({ gdhRunningVersion: '0.46.14' }),
        set: async (value) => Object.assign(saved, value),
      } },
      tabs: {
        query: async () => [{ id: 7 }, { id: 9 }, { id: null }],
        reload: async (id) => { reloaded.push(id); },
      },
    },
    Promise,
  });
  assert.deepEqual(reloaded, [7, 9]);
  assert.equal(saved.gdhRunningVersion, '0.46.22');

  reloaded.length = 0;
  await evaluate([fn], 'refreshSupportedTabsAfterVersionChange()', {
    RUNNING_VERSION_KEY: 'gdhRunningVersion',
    chrome: {
      runtime: { getManifest: () => ({ version: '0.46.22' }) },
      storage: { local: {
        get: async () => ({ gdhRunningVersion: '0.46.22' }),
        set: async () => {},
      } },
      tabs: { query: async () => [{ id: 7 }], reload: async (id) => { reloaded.push(id); } },
    },
    Promise,
  });
  assert.deepEqual(reloaded, []);
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
  assert.equal(evaluate([fn], "fomoBodyUnauthed({ success: true, statusCode: 200 })"), false);
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

process.stdout.write(`1..${passed}\n`);
