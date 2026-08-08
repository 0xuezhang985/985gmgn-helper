'use strict';

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const DEFAULTS = {
  enabled: true,
  showDevPerformance: true,
  showDevTooltip: true,
  enableDevBookmark: true,
  enableCalloutBlacklist: true,
  enableManifestoToast: true,
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
};
const devListInput = document.querySelector('#dev-list');
const colorInput = document.querySelector('#highlight-color');
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
      updateStatus.textContent = `已升级到 v${result.updatedVersion}，正在重载…`;
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
