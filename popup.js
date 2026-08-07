'use strict';

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const DEFAULTS = {
  enabled: true,
  showDevPerformance: true,
  showDevTooltip: true,
  enableDevBookmark: true,
  enableCalloutBlacklist: true,
  watchedDevs: [],
  highlightColor: '#f5b83d',
};

const featureInputs = {
  enabled: document.querySelector('#enabled'),
  showDevPerformance: document.querySelector('#show-dev-performance'),
  showDevTooltip: document.querySelector('#show-dev-tooltip'),
  enableDevBookmark: document.querySelector('#enable-dev-bookmark'),
  enableCalloutBlacklist: document.querySelector('#enable-callout-blacklist'),
};
const devListInput = document.querySelector('#dev-list');
const colorInput = document.querySelector('#highlight-color');
const status = document.querySelector('#status');
const saveButton = document.querySelector('#save');
const updateStatus = document.querySelector('#update-status');
const checkUpdateButton = document.querySelector('#check-update');

document.querySelector('#version').textContent = `v${chrome.runtime.getManifest().version}`;

function setStatus(message, type = '') {
  status.textContent = message;
  status.className = type;
}

function parseDevList(text) {
  const entries = new Map();
  const errors = [];

  text.split(/\r?\n/).forEach((rawLine, index) => {
    const line = rawLine.trim();
    if (!line) return;

    const match = line.match(/^(0x[a-fA-F0-9]{40})(?:[\s,，|]+(.*))?$/);
    if (!match || !ADDRESS_RE.test(match[1])) {
      errors.push(index + 1);
      return;
    }

    const address = match[1].toLowerCase();
    entries.set(address, { address, label: (match[2] || '').trim() });
  });

  return { entries: [...entries.values()], errors };
}

function formatDevList(entries) {
  return entries
    .map((entry) => `${entry.address}${entry.label ? ` ${entry.label}` : ''}`)
    .join('\n');
}

chrome.storage.local.get(DEFAULTS, (stored) => {
  for (const [key, input] of Object.entries(featureInputs)) {
    input.checked = stored[key] !== false;
  }
  devListInput.value = formatDevList(
    Array.isArray(stored.watchedDevs) ? stored.watchedDevs : [],
  );
  colorInput.value = stored.highlightColor || DEFAULTS.highlightColor;
  const count = Array.isArray(stored.watchedDevs) ? stored.watchedDevs.length : 0;
  setStatus(`已配置 ${count} 个重点 Dev`);
});

saveButton.addEventListener('click', () => {
  const parsed = parseDevList(devListInput.value);
  if (parsed.errors.length) {
    setStatus(`第 ${parsed.errors.join('、')} 行不是完整的 BSC 钱包地址`, 'error');
    return;
  }

  const next = {
    ...Object.fromEntries(
      Object.entries(featureInputs).map(([key, input]) => [key, input.checked]),
    ),
    watchedDevs: parsed.entries,
    highlightColor: colorInput.value || DEFAULTS.highlightColor,
  };

  chrome.storage.local.set(next, () => {
    if (chrome.runtime.lastError) {
      setStatus(`保存失败：${chrome.runtime.lastError.message}`, 'error');
      return;
    }
    devListInput.value = formatDevList(parsed.entries);
    setStatus(`已保存 ${parsed.entries.length} 个重点 Dev`, 'success');
  });
});

checkUpdateButton.addEventListener('click', async () => {
  checkUpdateButton.disabled = true;
  updateStatus.textContent = '正在检查 Chrome 更新通道…';
  try {
    const result = await chrome.runtime.requestUpdateCheck();
    if (result.status === 'update_available') {
      updateStatus.textContent = `发现 v${result.version || '新版'}，正在应用…`;
      return;
    }
    updateStatus.textContent = result.status === 'throttled'
      ? '检查过于频繁，请稍后再试'
      : '当前已是最新版';
  } catch (error) {
    updateStatus.textContent = `检查失败：${error.message || '未知错误'}`;
  } finally {
    checkUpdateButton.disabled = false;
  }
});
