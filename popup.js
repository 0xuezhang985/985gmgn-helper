'use strict';

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const DEFAULTS = {
  enabled: true,
  showDevPerformance: true,
  showDevTooltip: true,
  enableDevBookmark: true,
  enableCalloutBlacklist: true,
  enableManifestoToast: true,
  enableManifestoTab: true,
  enableSpecialWallet: true,
  enableRemindAlert: true,
  enableFomoPanel: true,
  enableHoldingSurge: true,
  holdingSurgeThreshold: 20,
  holdingSurgeCooldown: 60,
  mergeFomoHolders: true,
  enableMarkedHolders: true,
  enableFlapTax: true,
  flapRpc: '',
  enableFomoFeed: true,
  enablePumpFeed: true,
  fomoFeedChainOnly: false,
  fomoFeedTypes: { buy: true, sell: true, swap: true, thesis: true, transferIn: true, refund: true },
  markedHolders: [
    { address: '0x38e47fece3ea323e864c65410f6458c820eaa897', name: '奶牛' },
    { address: '0xbf004bff64725914ee36d03b87d6965b0ced4903', name: '阿峰大号1' },
    { address: '0xbd28edf53231cd121a963b4b119d3cc4cb3a368a', name: '阿峰大号2' },
    { address: '0x92deb73329794a517f1a8be4925446300f159400', name: '阿峰小号1' },
    { address: '0xb9c970411d72584649c2a41c9d5996df582fcc06', name: '阿峰小号2' },
    { address: '0x2ce9d43d1cba6ae31d7f07bfe0098dfa2d833373', name: '枯坐' },
  ],
  hideLightningTrade: true,
  watchedDevs: [],
  highlightColor: '#f5b83d',
};

const featureInputs = {
  enabled: document.querySelector('#enabled'),
  showDevPerformance: document.querySelector('#show-dev-performance'),
  showDevTooltip: document.querySelector('#show-dev-tooltip'),
  enableDevBookmark: document.querySelector('#enable-dev-bookmark'),
  enableCalloutBlacklist: document.querySelector('#enable-callout-blacklist'),
  enableManifestoToast: document.querySelector('#enable-manifesto-toast'),
  enableManifestoTab: document.querySelector('#enable-manifesto-tab'),
  enableSpecialWallet: document.querySelector('#enable-special-wallet'),
  enableRemindAlert: document.querySelector('#enable-remind-alert'),
  enableFomoPanel: document.querySelector('#enable-fomo-panel'),
  enableHoldingSurge: document.querySelector('#enable-holding-surge'),
  hideLightningTrade: document.querySelector('#hide-lightning-trade'),
};
const devListInput = document.querySelector('#dev-list');
const colorInput = document.querySelector('#highlight-color');
const surgeThresholdInput = document.querySelector('#holding-surge-threshold');
const surgeCooldownInput = document.querySelector('#holding-surge-cooldown');
const gmgnHoldingSyncStatus = document.querySelector('#gmgn-holding-sync-status');
const monitor985SyncStatus = document.querySelector('#monitor-985-sync-status');
const mergeHoldersInput = document.querySelector('#enable-merge-fomo-holders');
const markedEnableInput = document.querySelector('#enable-marked-holders');
const flapEnableInput = document.querySelector('#enable-flap-tax');
const flapRpcInput = document.querySelector('#flap-rpc');
const fomoFeedEnableInput = document.querySelector('#enable-fomo-feed');
const pumpFeedEnableInput = document.querySelector('#enable-pump-feed');
const fomoFeedChainOnlyInput = document.querySelector('#fomo-feed-chain-only');
const fomoFeedTypeInputs = {
  buy: document.querySelector('#fomo-feed-buy'),
  sell: document.querySelector('#fomo-feed-sell'),
  swap: document.querySelector('#fomo-feed-swap'),
  thesis: document.querySelector('#fomo-feed-thesis'),
  transferIn: document.querySelector('#fomo-feed-transfer-in'),
  refund: document.querySelector('#fomo-feed-refund'),
};

// 自定义 RPC 不写进固定权限（那等于索取全站访问），改为填了才当场申请该域名
async function ensureRpcPermission(url) {
  const raw = String(url || '').trim();
  if (!raw) return true;
  let origin;
  try { origin = new URL(raw).origin + '/*'; } catch { return false; }
  try {
    if (await chrome.permissions.contains({ origins: [origin] })) return true;
    return await chrome.permissions.request({ origins: [origin] });
  } catch { return false; }
}
const markedListInput = document.querySelector('#marked-list');

function markedToText(list) {
  return (Array.isArray(list) ? list : [])
    .map((x) => `${x.address} ${x.name || ''}`.trim())
    .join('\n');
}

function markedFromText(text) {
  return String(text || '').split('\n')
    .map((line) => line.trim()).filter(Boolean)
    .map((line) => {
      const m = line.match(/^(0x[a-fA-F0-9]{40})\s*(.*)$/);
      return m ? { address: m[1].toLowerCase(), name: m[2].trim() || m[1].slice(0, 8) } : null;
    })
    .filter(Boolean);
}

const status = document.querySelector('#status');
const saveButton = document.querySelector('#save');
const updateStatus = document.querySelector('#update-status');
const checkUpdateButton = document.querySelector('#check-update');
const updateCard = document.querySelector('.update-card');
const releaseLink = document.querySelector('#release-link');
const DEFAULT_RELEASE_URL = 'https://github.com/0xuezhang985/985gmgn-helper/releases/latest';

let currentUpdateState = null;

document.querySelector('#version').textContent = `v${chrome.runtime.getManifest().version}`;

function setStatus(message, type = '') {
  status.textContent = message;
  status.className = type;
}

function renderGmgnHoldingSyncState(state) {
  if (!state?.synced) {
    gmgnHoldingSyncStatus.textContent = state?.reason === 'login-required'
      ? '未同步：请先在 GMGN 网页登录同一账号'
      : '暂未同步；读取失败时沿用插件开关，不会误关提醒';
    gmgnHoldingSyncStatus.className = 'sync-status is-warn';
    return;
  }
  const labels = { sol: 'SOL', bsc: 'BSC', base: 'Base' };
  const enabled = (Array.isArray(state.enabledChains) ? state.enabledChains : [])
    .map((chain) => labels[chain] || chain).join('、');
  gmgnHoldingSyncStatus.textContent = enabled
    ? `GMGN App 开关已同步：${enabled} 已开启`
    : 'GMGN App 开关已同步：持仓价格提醒未开启';
  gmgnHoldingSyncStatus.className = 'sync-status is-ok';
}

function short985Account(raw) {
  const value = String(raw || '');
  return value.length > 14 ? `${value.slice(0, 6)}…${value.slice(-5)}` : value;
}

function renderMonitor985SyncState(state) {
  if (!state?.connected) {
    monitor985SyncStatus.textContent = '未连接：打开已登录的 985monitor 网页一次';
    monitor985SyncStatus.className = 'sync-status is-warn';
    return;
  }
  const account = String(state.displayName || '').trim() || short985Account(state.accountId);
  monitor985SyncStatus.textContent = `985monitor 账号配置已连接${account ? `：${account}` : ''}`;
  monitor985SyncStatus.className = 'sync-status is-ok';
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
  surgeThresholdInput.value = String(stored.holdingSurgeThreshold || DEFAULTS.holdingSurgeThreshold);
  surgeCooldownInput.value = String(stored.holdingSurgeCooldown || DEFAULTS.holdingSurgeCooldown);
  mergeHoldersInput.checked = stored.mergeFomoHolders !== false;
  markedEnableInput.checked = stored.enableMarkedHolders !== false;
  flapEnableInput.checked = stored.enableFlapTax !== false;
  flapRpcInput.value = String(stored.flapRpc || '');
  fomoFeedEnableInput.checked = stored.enableFomoFeed !== false;
  pumpFeedEnableInput.checked = stored.enablePumpFeed !== false;
  fomoFeedChainOnlyInput.checked = stored.fomoFeedChainOnly === true;
  const storedFomoTypes = stored.fomoFeedTypes && typeof stored.fomoFeedTypes === 'object'
    ? stored.fomoFeedTypes : DEFAULTS.fomoFeedTypes;
  for (const [key, input] of Object.entries(fomoFeedTypeInputs)) {
    input.checked = storedFomoTypes[key] !== false;
  }
  markedListInput.value = markedToText(
    Array.isArray(stored.markedHolders) ? stored.markedHolders : DEFAULTS.markedHolders);
  const count = Array.isArray(stored.watchedDevs) ? stored.watchedDevs.length : 0;
  setStatus(`已配置 ${count} 个重点 Dev`);
});

chrome.storage.local.get({ gmgnHoldingSignalSyncState: null }, (stored) => {
  renderGmgnHoldingSyncState(stored.gmgnHoldingSignalSyncState);
});

chrome.storage.local.get({ monitor985SyncStateV1: null }, (stored) => {
  renderMonitor985SyncState(stored.monitor985SyncStateV1);
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && changes.gmgnHoldingSignalSyncState) {
    renderGmgnHoldingSyncState(changes.gmgnHoldingSignalSyncState.newValue);
  }
  if (areaName === 'local' && changes.monitor985SyncStateV1) {
    renderMonitor985SyncState(changes.monitor985SyncStateV1.newValue);
  }
});

saveButton.addEventListener('click', async () => {
  const parsed = parseDevList(devListInput.value);
  if (parsed.errors.length) {
    setStatus(`第 ${parsed.errors.join('、')} 行不是完整的 BSC 钱包地址`, 'error');
    return;
  }

  // 填了自定义 RPC 就得先拿到该域名的访问权限，拿不到要说清楚，不能默默用不了
  const rpc = flapRpcInput.value.trim();
  if (rpc) {
    if (!/^https:\/\//i.test(rpc)) {
      setStatus('自定义 RPC 需要以 https:// 开头', 'error');
      return;
    }
    if (!(await ensureRpcPermission(rpc))) {
      setStatus('没有拿到该 RPC 域名的访问权限，已保留其余设置；该项请重新保存并允许', 'error');
      flapRpcInput.value = '';
    }
  }

  const next = {
    ...Object.fromEntries(
      Object.entries(featureInputs).map(([key, input]) => [key, input.checked]),
    ),
    watchedDevs: parsed.entries,
    highlightColor: colorInput.value || DEFAULTS.highlightColor,
    holdingSurgeThreshold: Number(surgeThresholdInput.value) || DEFAULTS.holdingSurgeThreshold,
    holdingSurgeCooldown: Number(surgeCooldownInput.value) || DEFAULTS.holdingSurgeCooldown,
    mergeFomoHolders: mergeHoldersInput.checked,
    enableMarkedHolders: markedEnableInput.checked,
    enableFlapTax: flapEnableInput.checked,
    flapRpc: flapRpcInput.value.trim(),
    enableFomoFeed: fomoFeedEnableInput.checked,
    enablePumpFeed: pumpFeedEnableInput.checked,
    fomoFeedChainOnly: fomoFeedChainOnlyInput.checked,
    fomoFeedTypes: Object.fromEntries(
      Object.entries(fomoFeedTypeInputs).map(([key, input]) => [key, input.checked]),
    ),
    markedHolders: markedFromText(markedListInput.value),
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

function sendRuntimeMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(response);
    });
  });
}

function renderUpdateState(state) {
  currentUpdateState = state;
  updateCard.classList.toggle('has-update', Boolean(state?.updateAvailable));
  releaseLink.hidden = !state?.updateAvailable;
  releaseLink.dataset.url = state?.releaseUrl || DEFAULT_RELEASE_URL;

  if (!state) {
    updateStatus.textContent = '尚未检查更新';
    checkUpdateButton.textContent = '检查更新';
    return;
  }

  if (state.updateAvailable) {
    updateStatus.textContent = `发现 v${state.latestVersion}，当前 v${state.currentVersion}`;
    checkUpdateButton.textContent = state.updaterInstalled ? '一键升级' : '打开 GitHub';
    return;
  }

  if (state.status === 'updater_missing') {
    updateStatus.textContent = '本地更新器未安装，可前往 GitHub';
    checkUpdateButton.textContent = '打开 GitHub';
    return;
  }

  updateStatus.textContent = `当前 v${state.currentVersion} 已是最新版`;
  checkUpdateButton.textContent = '重新检查';
}

function openReleasePage() {
  const url = currentUpdateState?.releaseUrl || DEFAULT_RELEASE_URL;
  chrome.tabs.create({ url });
}

async function refreshUpdateState() {
  updateStatus.textContent = '正在检查 GitHub 最新版本…';
  const state = await sendRuntimeMessage({ type: 'check-update' });
  renderUpdateState(state);
}

releaseLink.addEventListener('click', (event) => {
  event.preventDefault();
  openReleasePage();
});

checkUpdateButton.addEventListener('click', async () => {
  if (currentUpdateState?.status === 'updater_missing') {
    openReleasePage();
    return;
  }

  checkUpdateButton.disabled = true;
  try {
    if (currentUpdateState?.updateAvailable) {
      updateStatus.textContent = '正在下载并安装新版…';
      const result = await sendRuntimeMessage({ type: 'install-update' });
      if (!result?.ok) throw new Error(result?.error || '升级失败');
      updateStatus.textContent = `已升级到 v${result.updatedVersion}，正在重载扩展并刷新 GMGN 页面…`;
      setTimeout(() => chrome.runtime.reload(), 350);
      return;
    }
    await refreshUpdateState();
  } catch (error) {
    updateStatus.textContent = `升级检查失败：${error.message || '未知错误'}`;
  } finally {
    checkUpdateButton.disabled = false;
  }
});

sendRuntimeMessage({ type: 'get-update-state' })
  .then((state) => {
    renderUpdateState(state);
    return refreshUpdateState();
  })
  .catch((error) => {
    renderUpdateState({
      status: 'updater_missing',
      currentVersion: chrome.runtime.getManifest().version,
      updaterInstalled: false,
      updateAvailable: false,
      releaseUrl: DEFAULT_RELEASE_URL,
      error: error.message,
    });
  });
