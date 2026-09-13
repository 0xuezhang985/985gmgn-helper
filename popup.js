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
  specialWallets: [],
  disableTrackerPersonNavigation: false,
  enableRemindAlert: true,
  enableFomoPanel: true,
  enableFomoTrending: true,
  fomoTranslate: true,
  enableHoldingSurge: true,
  holdingSurgeThreshold: 20,
  holdingSurgeCooldown: 60,
  mergeFomoHolders: true,
  enableMarkedHolders: true,
  enableFlapTax: true,
  enableAllPools: true,
  enableBrewPanel: true,
  flapRpc: '',
  enableFomoFeed: true,
  enablePumpFeed: true,
  fomoFeedChainOnly: false,
  enableMonitorAggregate: true,
  enableSimilarTokenPanel: false,
  similarTokenCacheMinutes: 5,
  syncGmgnTokenBlacklist: true,
  fomoFeedTypes: { buy: true, sell: true, swap: true, thesis: true, transferIn: true, refund: true },
  addWalletStarPref: { on: false, color: '#f5b83d', pin: false },
  markedHolders: [
    { address: '0x38e47fece3ea323e864c65410f6458c820eaa897', name: '奶牛' },
    { address: '0xbf004bff64725914ee36d03b87d6965b0ced4903', name: '阿峰大号1' },
    { address: '0xbd28edf53231cd121a963b4b119d3cc4cb3a368a', name: '阿峰大号2' },
    { address: '0x92deb73329794a517f1a8be4925446300f159400', name: '阿峰小号1' },
    { address: '0xb9c970411d72584649c2a41c9d5996df582fcc06', name: '阿峰小号2' },
    { address: '0x2ce9d43d1cba6ae31d7f07bfe0098dfa2d833373', name: '枯坐' },
  ],
  hideLightningTrade: false,
  watchedDevs: [],
  highlightColor: '#f5b83d',
  badgeColors: {
    fomo: '#6d4ed4',
    rank: '#7c3aed',
    marked: '#0f766e',
  },
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
  disableTrackerPersonNavigation: document.querySelector('#disable-tracker-person-navigation'),
  enableRemindAlert: document.querySelector('#enable-remind-alert'),
  enableFomoPanel: document.querySelector('#enable-fomo-panel'),
  enableFomoTrending: document.querySelector('#enable-fomo-trending'),
  fomoTranslate: document.querySelector('#fomo-translate'),
  enableHoldingSurge: document.querySelector('#enable-holding-surge'),
  mergeFomoHolders: document.querySelector('#enable-merge-fomo-holders'),
  enableMarkedHolders: document.querySelector('#enable-marked-holders'),
  enableFlapTax: document.querySelector('#enable-flap-tax'),
  enableAllPools: document.querySelector('#enable-all-pools'),
  enableBrewPanel: document.querySelector('#enable-brew-panel'),
  enableFomoFeed: document.querySelector('#enable-fomo-feed'),
  enablePumpFeed: document.querySelector('#enable-pump-feed'),
  fomoFeedChainOnly: document.querySelector('#fomo-feed-chain-only'),
  enableMonitorAggregate: document.querySelector('#enable-monitor-aggregate'),
  enableSimilarTokenPanel: document.querySelector('#enable-similar-token-panel'),
  syncGmgnTokenBlacklist: document.querySelector('#sync-gmgn-token-blacklist'),
  hideLightningTrade: document.querySelector('#hide-lightning-trade'),
};
const devListInput = document.querySelector('#dev-list');
const colorInput = document.querySelector('#highlight-color');
const badgeColorInputs = {
  fomo: document.querySelector('#fomo-label-color'),
  rank: document.querySelector('#rank-badge-color'),
  marked: document.querySelector('#marked-badge-color'),
};
const surgeThresholdInput = document.querySelector('#holding-surge-threshold');
const surgeCooldownInput = document.querySelector('#holding-surge-cooldown');
const similarTokenCacheInput = document.querySelector('#similar-token-cache-minutes');
const gmgnHoldingSyncStatus = document.querySelector('#gmgn-holding-sync-status');
const monitor985SyncStatus = document.querySelector('#monitor-985-sync-status');
const flapRpcInput = document.querySelector('#flap-rpc');
const specialWalletDefaultHighlightInput = document.querySelector('#special-wallet-default-highlight');
const specialWalletDefaultPinInput = document.querySelector('#special-wallet-default-pin');
const specialWalletDefaultColorInput = document.querySelector('#special-wallet-default-color');
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
const updateSummary = document.querySelector('#update-summary');
const skipUpdateButton = document.querySelector('#skip-update');
const updateHistory = document.querySelector('#update-history');
const historyStatus = document.querySelector('#history-status');
const rollbackVersion = document.querySelector('#rollback-version');
const rollbackButton = document.querySelector('#rollback-update');
const rollbackSummary = document.querySelector('#rollback-summary');
const updaterSetup = document.querySelector('#updater-setup');
let historyVersions = [];
let historyLoading = false;
let updateBusy = false;
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
    monitor985SyncStatus.textContent = '未连接：请确认 985monitor 网页已登录（无需刷新）';
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
  const storedBadgeColors = stored.badgeColors && typeof stored.badgeColors === 'object'
    ? stored.badgeColors : {};
  for (const [key, input] of Object.entries(badgeColorInputs)) {
    input.value = storedBadgeColors[key] || DEFAULTS.badgeColors[key];
  }
  surgeThresholdInput.value = String(stored.holdingSurgeThreshold || DEFAULTS.holdingSurgeThreshold);
  surgeCooldownInput.value = String(stored.holdingSurgeCooldown || DEFAULTS.holdingSurgeCooldown);
  similarTokenCacheInput.value = String([1, 5, 10, 30].includes(Number(stored.similarTokenCacheMinutes))
    ? Number(stored.similarTokenCacheMinutes) : DEFAULTS.similarTokenCacheMinutes);
  flapRpcInput.value = String(stored.flapRpc || '');
  const starPref = stored.addWalletStarPref && typeof stored.addWalletStarPref === 'object'
    ? stored.addWalletStarPref : DEFAULTS.addWalletStarPref;
  specialWalletDefaultHighlightInput.checked = starPref.on === true;
  specialWalletDefaultPinInput.checked = starPref.pin === true;
  specialWalletDefaultColorInput.value = String(starPref.color || DEFAULTS.addWalletStarPref.color);
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
    badgeColors: Object.fromEntries(
      Object.entries(badgeColorInputs)
        .map(([key, input]) => [key, input.value || DEFAULTS.badgeColors[key]]),
    ),
    holdingSurgeThreshold: Number(surgeThresholdInput.value) || DEFAULTS.holdingSurgeThreshold,
    holdingSurgeCooldown: Number(surgeCooldownInput.value) || DEFAULTS.holdingSurgeCooldown,
    similarTokenCacheMinutes: [1, 5, 10, 30].includes(Number(similarTokenCacheInput.value))
      ? Number(similarTokenCacheInput.value) : DEFAULTS.similarTokenCacheMinutes,
    flapRpc: flapRpcInput.value.trim(),
    addWalletStarPref: {
      on: specialWalletDefaultHighlightInput.checked,
      pin: specialWalletDefaultPinInput.checked,
      color: specialWalletDefaultColorInput.value || DEFAULTS.addWalletStarPref.color,
    },
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
  releaseLink.hidden = !state?.latestVersion;
  releaseLink.dataset.url = state?.releaseUrl || DEFAULT_RELEASE_URL;
  updateSummary.textContent = state?.summary || (state?.latestVersion ? '暂未取得本版简介，可查看完整说明。' : '检查更新后显示本版简介。');
  skipUpdateButton.hidden = !state?.updateAvailable && !state?.skipped;
  skipUpdateButton.textContent = state?.skipped ? '恢复本次更新提醒' : '跳过本次更新';
  setUpdateBusy(updateBusy);

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

  if (state.skipped) {
    updateStatus.textContent = `已跳过 v${state.latestVersion}，当前保留 v${state.currentVersion}；以后有新版仍会提醒`;
    checkUpdateButton.textContent = '检查其它更新';
    return;
  }

  if (state.status === 'error') {
    updateStatus.textContent = `检查失败：${state.error || '请稍后重试'}`;
    checkUpdateButton.textContent = '重新检查';
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
  chrome.tabs.create({ url: /^https:\/\/github\.com\/0xuezhang985\/985gmgn-helper\/releases(?:\/|$)/.test(url) ? url : DEFAULT_RELEASE_URL });
}

function setUpdateBusy(busy) {
  updateBusy = busy;
  checkUpdateButton.disabled = busy;
  skipUpdateButton.disabled = busy;
  rollbackVersion.disabled = busy;
  rollbackButton.disabled = busy || !rollbackVersion.value || Number(currentUpdateState?.protocolVersion) < 2;
}

function selectRollbackVersion() {
  const release = historyVersions.find((item) => item.version === rollbackVersion.value);
  rollbackSummary.hidden = !release;
  rollbackSummary.textContent = release?.summary || '';
  setUpdateBusy(updateBusy);
}

updateHistory.addEventListener('toggle', async () => {
  if (!updateHistory.open || historyLoading || historyVersions.length) return;
  if (!currentUpdateState || currentUpdateState.status === 'error') {
    historyStatus.textContent = '请先完成上方版本检查，再重新展开历史列表。';
    return;
  }
  if (Number(currentUpdateState?.protocolVersion) < 2) {
    historyStatus.textContent = '历史回退需要新版本地更新器。首次运行新版安装器“安装 / 修复”后即可使用，设置不会清空。';
    updaterSetup.hidden = false;
    return;
  }
  historyLoading = true;
  historyStatus.textContent = '正在读取官方历史版本…';
  try {
    const result = await sendRuntimeMessage({ type: 'update-history' });
    if (!result?.ok) throw new Error(result?.error || '读取失败');
    historyVersions = Array.isArray(result.versions) ? result.versions : [];
    rollbackVersion.replaceChildren(new Option('请选择要回退的版本', ''));
    historyVersions.forEach((item) => rollbackVersion.add(new Option(`v${item.version}`, item.version)));
    historyStatus.textContent = historyVersions.length ? '最近 10 个可用旧版；已撤回的版本不提供回退。' : '暂无可回退的正式版本。';
    updaterSetup.hidden = true;
  } catch (error) {
    historyStatus.textContent = `读取失败：${error.message}。收起后重新展开可重试。`;
  } finally { historyLoading = false; }
});
rollbackVersion.addEventListener('change', selectRollbackVersion);

rollbackButton.addEventListener('click', async () => {
  if (updateBusy || !historyVersions.some((item) => item.version === rollbackVersion.value)) return;
  setUpdateBusy(true);
  try {
    updateStatus.textContent = `正在校验并回退到 v${rollbackVersion.value}，保留个人设置…`;
    const result = await sendRuntimeMessage({ type: 'rollback-update', version: rollbackVersion.value });
    if (!result?.ok) throw new Error(result?.error || '回退失败');
    updateStatus.textContent = `已回退到 v${result.updatedVersion}，正在重载扩展…`;
    setTimeout(() => chrome.runtime.reload(), 350);
  } catch (error) { updateStatus.textContent = `回退未完成：${error.message}`; }
  finally { setUpdateBusy(false); }
});

skipUpdateButton.addEventListener('click', async () => {
  if (updateBusy) return;
  setUpdateBusy(true);
  try {
    const result = await sendRuntimeMessage({ type: 'skip-update', version: currentUpdateState?.skipped ? '' : currentUpdateState?.latestVersion });
    if (result?.ok === false) throw new Error(result.error || '保存失败');
    renderUpdateState(result);
  } catch (error) { updateStatus.textContent = `设置失败：${error.message}`; }
  finally { setUpdateBusy(false); }
});

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
  if (updateBusy) return;
  if (currentUpdateState?.status === 'updater_missing') {
    openReleasePage();
    return;
  }

  setUpdateBusy(true);
  try {
    if (currentUpdateState?.updateAvailable) {
      updateStatus.textContent = '正在下载并安装新版…';
      const result = await sendRuntimeMessage({ type: 'install-update', version: currentUpdateState.latestVersion });
      if (!result?.ok) throw new Error(result?.error || '升级失败');
      updateStatus.textContent = `已升级到 v${result.updatedVersion}，正在重载扩展并刷新 GMGN 页面…`;
      setTimeout(() => chrome.runtime.reload(), 350);
      return;
    }
    await refreshUpdateState();
  } catch (error) {
    updateStatus.textContent = `升级检查失败：${error.message || '未知错误'}`;
  } finally {
    setUpdateBusy(false);
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

// Per-wallet opt-in; never overwrite the latest color/pin preferences on save.
function renderPriorityWallets(list) {
  const host = document.querySelector('#priority-wallet-list');
  host.replaceChildren();
  const rows = Array.isArray(list) ? list : [];
  if (!rows.length) { host.textContent = '暂无特别关注钱包，请先用已有 ☆ / 特别关注管理添加。'; return; }
  for (const wallet of rows) {
    const label = document.createElement('label'); label.className = 'control-row';
    const text = document.createElement('span');
    text.textContent = wallet.label || `${String(wallet.address).slice(0, 6)}…${String(wallet.address).slice(-4)}`;
    text.title = String(wallet.address || '');
    const input = document.createElement('input'); input.type = 'checkbox'; input.checked = wallet.persistentPin === true;
    input.setAttribute('aria-label', `${text.textContent} 重点提醒`);
    input.addEventListener('change', async () => {
      input.disabled = true;
      try {
        const stored = await chrome.storage.local.get({ specialWallets: [] });
        await chrome.storage.local.set({ specialWallets: stored.specialWallets.map((item) => item.address === wallet.address
          ? { ...item, persistentPin: input.checked } : item) });
      } catch { input.checked = !input.checked; text.textContent = '保存失败，请重试'; }
      finally { input.disabled = false; }
    });
    label.append(text, input); host.appendChild(label);
  }
}
chrome.storage.local.get({ specialWallets: [] }, (stored) => renderPriorityWallets(stored.specialWallets));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.specialWallets) renderPriorityWallets(changes.specialWallets.newValue);
});
