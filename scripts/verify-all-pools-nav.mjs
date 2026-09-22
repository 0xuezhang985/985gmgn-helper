// 离线回归：「全部底池」点击跳到对面那个币的 GMGN 代币页。
// 后台直连用真实 DexScreener 数据形态（musebook @ Robinhood，2026-09-23 实抓）驱动；
// 面板在真实浏览器里点一遍，断言跳转路径、新标签行为和原生币的退路。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = n => fs.readFileSync(path.join(root, n), 'utf8').replace(/\r\n/g, '\n');
// 按函数自身的缩进找结尾：content.js 的函数缩进两格，background.js 的在顶层。
const fn = (source, name) => {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `missing function ${name}`);
  const head = source.lastIndexOf('\n', start) + 1;
  const indent = source.slice(head, start).match(/^\s*/)[0];
  const end = source.indexOf(`\n${indent}}\n`, start);
  assert.ok(end > 0, `no end for ${name}`);
  return source.slice(head, end + indent.length + 3).trimStart();
};
let checks = 0;

// ---- 后台：对面代币地址要带出来，且保留原始大小写 ----
const MUSE = '0x91A2DAe9699f0B82540B5886b0d8759C22820bA3';
const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
const WETH = '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73';
const ZERO = '0x0000000000000000000000000000000000000000';
const pair = (base, quote, extra = {}) => ({
  chainId: 'robinhood', dexId: 'uniswap', labels: ['v4'], pairAddress: '0x' + 'ab'.repeat(20),
  url: 'https://dexscreener.com/robinhood/0xpair', liquidity: { usd: 100 }, volume: { h24: 5 },
  baseToken: base, quoteToken: quote, ...extra,
});
const payload = { pairs: [
  pair({ address: MUSE, symbol: 'musebook' }, { address: USDG, symbol: 'USDG' }, { liquidity: { usd: 347948 } }),
  pair({ address: MUSE, symbol: 'musebook' }, { address: ZERO, symbol: 'ETH' }, { liquidity: { usd: 51825 } }),
  // 这个币也可能在报价一侧
  pair({ address: WETH, symbol: 'WETH' }, { address: MUSE, symbol: 'musebook' }, { liquidity: { usd: 1098520 } }),
  // 别的链、别的币都要被滤掉
  pair({ address: MUSE, symbol: 'musebook' }, { address: USDG, symbol: 'USDG' }, { chainId: 'ethereum' }),
  pair({ address: USDG, symbol: 'USDG' }, { address: WETH, symbol: 'WETH' }),
] };
const background = read('background.js');
const ctx = vm.createContext({
  AbortController, setTimeout, clearTimeout, Date, Number, String, Array,
  fetch: async () => ({ ok: true, json: async () => payload }),
});
vm.runInContext(`
  const DS_CHAIN = { bsc: 'bsc', sol: 'solana', eth: 'ethereum', base: 'base', robinhood: 'robinhood' };
  const DS_FAIL_COOLDOWN = 600000;
  let dsDirectFailedAt = 0;
  ${fn(background, 'dexScreenerDirect')}
  globalThis.dexScreenerDirect = dexScreenerDirect;
`, ctx);
const direct = await ctx.dexScreenerDirect('robinhood', MUSE.toLowerCase());
assert.equal(direct.ok, true);
// vm 里造的数组属于另一个 realm，原型不同，先转成普通 JSON 再比
assert.deepEqual(JSON.parse(JSON.stringify(direct.pools.map(p => [p.quote, p.quoteAddress]))), [
  ['WETH', WETH], ['USDG', USDG], ['ETH', ZERO],
], '对面代币地址带出且保留校验和大小写；按流动性排序；别的链与无关池被滤掉');
checks++;

// ---- 面板：真实浏览器里点一遍 ----
const content = read('content.js');
const SOL_QUOTE = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.route('**/*', r => r.abort());
  await page.setContent('<!doctype html><html><body><div id="anchor">PoolInfo</div></body></html>');
  await page.addScriptTag({ content: `
    window.navigated = [];
    const POOLS_SHOW = 8;
    let poolsExpanded = false;
    function scheduleScan() {}
    function gdhSpaNavigate(url) { window.navigated.push(url); }
    ${['poolLiqText', 'poolTokenHref', 'buildPoolsPanel'].map(n => fn(content, n)).join('\n')}
    window.render = (route, pools) => {
      document.querySelector('.gdh-pools')?.remove();
      buildPoolsPanel(document.getElementById('anchor'), route,
        { pools, total: pools.length, totalLiq: pools.reduce((s, p) => s + p.liq, 0) });
      return [...document.querySelectorAll('.gdh-pools__row')].map(a => ({
        href: a.getAttribute('href'), target: a.getAttribute('target') || '', title: a.title }));
    };
  ` });

  const evm = await page.evaluate(({ USDG, ZERO }) => window.render(
    { chain: 'robinhood', address: '0x91a2dae9699f0b82540b5886b0d8759c22820ba3' },
    [
      { quote: 'USDG', quoteAddress: USDG, dex: 'uniswap v4', liq: 347948, vol24h: 10, url: 'https://dexscreener.com/robinhood/0xa' },
      { quote: 'ETH', quoteAddress: ZERO, dex: 'uniswap v4', liq: 51825, vol24h: 3, url: 'https://dexscreener.com/robinhood/0xb' },
      // 旧版 985 代取没有地址字段：维持原来的 DexScreener 行为，不能变成死链
      { quote: 'OLD', dex: 'uniswap v3', liq: 10, vol24h: 1, url: 'https://dexscreener.com/robinhood/0xc' },
    ]), { USDG, ZERO });
  assert.equal(evm[0].href, '/robinhood/token/' + USDG.toLowerCase(), 'EVM 地址转小写拼成站内路径');
  assert.equal(evm[0].target, '', 'GMGN 行在本页打开，不开新标签');
  assert.match(evm[0].title, /USDG 的 GMGN 代币页/);
  assert.equal(evm[1].href, 'https://dexscreener.com/robinhood/0xb', '原生币（零地址）没有 GMGN 页，退回 DexScreener');
  assert.equal(evm[1].target, '_blank');
  assert.match(evm[1].title, /原生币没有 GMGN 代币页/);
  assert.equal(evm[2].href, 'https://dexscreener.com/robinhood/0xc', '缺地址的旧数据维持原行为');
  assert.doesNotMatch(evm[2].title, /原生币/, '缺地址不能被说成原生币');
  checks++;

  // 普通左键走站内无刷新路由；带 Ctrl 的点击交给浏览器（开新标签），不拦截
  const clicks = await page.evaluate(() => {
    const row = document.querySelector('.gdh-pools__row');
    const plain = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    row.dispatchEvent(plain);
    const ctrl = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ctrlKey: true });
    const ctrlAllowed = row.dispatchEvent(ctrl);
    return { navigated: [...window.navigated], plainPrevented: plain.defaultPrevented, ctrlAllowed };
  });
  assert.deepEqual(clicks, {
    navigated: ['/robinhood/token/' + USDG.toLowerCase()],
    plainPrevented: true,
    ctrlAllowed: true,
  }, '左键站内跳转且只跳一次；Ctrl 点击放行给浏览器');
  checks++;

  const sol = await page.evaluate((SOL_QUOTE) => window.render(
    { chain: 'sol', address: '6FDqZjhYfy11Fcz541j6gyzFAY5CuSMhx7ZZbJzB3Y5P' },
    [{ quote: 'USDC', quoteAddress: SOL_QUOTE, dex: 'raydium', liq: 5, vol24h: 1, url: 'https://dexscreener.com/solana/x' }],
  ), SOL_QUOTE);
  assert.equal(sol[0].href, '/sol/token/' + SOL_QUOTE, 'Solana 地址区分大小写，必须原样保留');
  checks++;

  assert.deepEqual(errors, []);
} finally {
  await browser.close();
}
console.log(`PASS ${checks} all-pools navigation checks (offline)`);
