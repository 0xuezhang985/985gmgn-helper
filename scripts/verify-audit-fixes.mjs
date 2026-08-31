import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');
const background = read('background.js');
const content = read('content.js');
const bridge = read('page-bridge.js');
const popup = read('popup.js');
const popupHtml = read('popup.html');
const site = read('site/index.html');
const bgmSync = read('scripts/sync-bgm-download.py');

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

await test('Pump 插卡沿用关注、屏蔽、类型与最低成交额过滤', () => {
  const functions = [extractFunction(content, 'pumpFeedTokenKey'), extractFunction(content, 'pumpFeedEventAllowed')];
  const wallet = 'BY58Z7N5Adarkx5ed78AzKvR7Kxrq795aa1boZsYyVBT';
  const base = { pumpWallet: wallet, type: 'buy', usd: 25, symbol: 'DUVAL', addr: 'HbF1o9Mgwibv9JcQzEVUs52d9z1ibYQpdx8bY8Ntpump' };
  const run = (cfg, defaults = [wallet], ev = base) => evaluate(functions, `pumpFeedEventAllowed(${JSON.stringify(ev)})`, {
    monitorPumpCfg: cfg,
    pumpDefaultWallets: new Set(defaults),
    isTokenBlocked: () => false,
  });
  const cfg = { muted: new Set(), prefs: {}, watch: new Set(), filters: {}, tokenFilters: new Set(), onlyMine: true, globalTradeMinUsd: 10 };
  assert.equal(run(cfg), true);
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
  assert.match(content, /tokenFilters: Array\.isArray\(overlay\?\.pumpTokenFilters\) \? overlay\.pumpTokenFilters : null/);
});

await test('Pump 推送有独立设置项并复用同一 SSE 连接', () => {
  assert.ok(popupHtml.includes('id="enable-pump-feed"'));
  assert.ok(popup.includes('enablePumpFeed: true'));
  assert.ok(content.includes("chrome.runtime.sendMessage({ type: 'pump-feed' }"));
  assert.ok(background.includes("eventType === 'pump-trade'"));
  assert.ok(background.includes("type: 'gdh-pump-push'"));
  assert.equal((background.match(/api\/events-stream/g) || []).length, 1);
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

await test('下载同步脚本拒绝恶意版本参数', () => {
  const python = process.platform === 'win32' ? 'python' : 'python3';
  const result = spawnSync(python, [path.join(root, 'scripts', 'sync-bgm-download.py'), '0.46.1;echo-pwned'], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /X\.Y\.Z/);
});

await test('/bgm 同步只使用 GitHub Release 原始资产并校验 SHA256', () => {
  assert.ok(bgmSync.includes("releases/download/v{V}"));
  assert.ok(bgmSync.includes("f'{fn}.sha256'"));
  assert.ok(bgmSync.includes('Release SHA256 不一致'));
  assert.ok(!bgmSync.includes("os.path.join(DIST, fn)"));
  assert.ok(site.includes('985gmgn-helper-setup-v0.46.11.exe'));
  assert.ok(site.includes('985gmgn-helper-v0.46.11.zip'));
});

await test('Solana 供应量缓存键不再统一小写', () => {
  assert.ok(background.includes("const normalizedAddress = looksEvm ? String(address).toLowerCase() : String(address);"));
});

process.stdout.write(`1..${passed}\n`);
