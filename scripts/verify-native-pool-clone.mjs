import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// 原生底池徽章克隆:原件被我们藏起来之后,克隆被重建(徽章行被 GMGN 重绘删掉、
// 或 React 复用同一个 <a> 换了链接)时,不能把原件身上的 display:none / 隐藏标记一起复制过去。
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const content = fs.readFileSync(path.join(root, 'content.js'), 'utf8').replace(/\r\n/g, '\n');

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `missing function ${name}`);
  const bodyStart = source.indexOf('{', start);
  let depth = 0; let quote = ''; let escaped = false; let lineComment = false; let blockComment = false;
  for (let i = bodyStart; i < source.length; i += 1) {
    const ch = source[i]; const next = source[i + 1];
    if (lineComment) { if (ch === '\n') lineComment = false; continue; }
    if (blockComment) { if (ch === '*' && next === '/') { blockComment = false; i += 1; } continue; }
    if (quote) { if (escaped) escaped = false; else if (ch === '\\') escaped = true; else if (ch === quote) quote = ''; continue; }
    if (ch === '/' && next === '/') { lineComment = true; i += 1; continue; }
    if (ch === '/' && next === '*') { blockComment = true; i += 1; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '{') depth += 1;
    if (ch === '}') { depth -= 1; if (depth === 0) return source.slice(start, i + 1); }
  }
  throw new Error(`unterminated function ${name}`);
}

const TOKEN = '0xc442d2a44dbeaae902765d527839327489487777';
const POOL = '0x21caef8a43163eea865baee23b9c2e327696a3bf';
const OTHER = '0x55d398326f99059ff775485246999027b3197955';
const functions = ['tokenDetailBadgeRow', 'tokenHeaderBlock', 'nativePoolBadge', 'clearNativePoolBadge', 'renderNativePoolBadge']
  .map((name) => extractFunction(content, name)).join('\n');

// 结构取自 GMGN 真实页头(2026-10-01 实测):地址行 = [币龄][Copy > #token-base-address][<a> 底池计价币][TokenDevRewardsByLpp]…
const html = `<!doctype html><meta charset="utf-8"><body><main>
  <div data-sentry-component="BaseInfoBar"><div class="block">
    <div class="first"><div><div><span id="token-base-symbol" data-symbol="ZCM">招财猫</span></div></div></div>
    <div class="line"><div class="row">
      <div>4h</div>
      <div data-sentry-component="Copy"><span id="token-base-address" data-addr="${TOKEN}">0xc4...7777</span></div>
      <a id="native" href="/bsc/token/${POOL}" style="display:flex"><img alt="">XAUT0</a>
      <div data-sentry-component="TokenDevRewardsByLpp"></div>
    </div></div>
  </div></div>
</main></body>`;

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ headless: true });
let passed = 0;
const test = async (name, fn) => { await fn(); passed += 1; process.stdout.write(`ok ${passed} - ${name}\n`); };
try {
  const page = await browser.newPage();
  await page.setContent(html);
  await page.addScriptTag({ content: `
    var settings = {};
    function currentTokenRoute() { return { chain: 'bsc', address: '${TOKEN}' }; }
    function gdhSpaNavigate(href) { window.__navigated = href; }
    ${functions}
    window.__render = () => renderNativePoolBadge(currentTokenRoute());
    window.__clear = () => clearNativePoolBadge();
  ` });
  const state = () => page.evaluate(() => {
    const clones = [...document.querySelectorAll('.gdh-native-pool')];
    const native = document.getElementById('native');
    return {
      clones: clones.map((c) => ({ href: c.getAttribute('href'), display: getComputedStyle(c).display,
        inline: c.style.getPropertyValue('display'), flag: c.dataset.gdhNativePoolHidden || '',
        inRow: !!c.closest('.gdh-token-detail-badges') })),
      nativeDisplay: getComputedStyle(native).display,
    };
  });

  await test('首次渲染:克隆可见、原件藏起来', async () => {
    await page.evaluate(() => window.__render());
    const s = await state();
    assert.equal(s.clones.length, 1);
    assert.equal(s.clones[0].inRow, true);
    assert.notEqual(s.clones[0].display, 'none');
    assert.equal(s.nativeDisplay, 'none');
  });

  await test('徽章行被删掉后重建:新克隆不继承原件的隐藏样式和标记', async () => {
    await page.evaluate(() => document.querySelector('.gdh-token-detail-badges').remove());
    await page.evaluate(() => window.__render());
    const s = await state();
    assert.equal(s.clones.length, 1);
    assert.notEqual(s.clones[0].display, 'none', 'rebuilt clone must stay visible');
    assert.equal(s.clones[0].inline, '');
    assert.equal(s.clones[0].flag, '');
    assert.equal(s.nativeDisplay, 'none');
  });

  await test('React 复用原件换了链接:按新链接重建的克隆仍然可见', async () => {
    await page.evaluate((other) => document.getElementById('native').setAttribute('href', `/bsc/token/${other}`), OTHER);
    await page.evaluate(() => window.__render());
    const s = await state();
    assert.equal(s.clones.length, 1);
    assert.equal(s.clones[0].href, `/bsc/token/${OTHER}`);
    assert.notEqual(s.clones[0].display, 'none');
    assert.equal(s.clones[0].flag, '');
  });

  await test('关闭时恢复原件、移除克隆', async () => {
    await page.evaluate(() => window.__clear());
    const s = await state();
    assert.equal(s.clones.length, 0);
    assert.notEqual(s.nativeDisplay, 'none');
  });
} finally {
  await browser.close();
}
process.stdout.write(`native pool clone: ${passed} passed\n`);
