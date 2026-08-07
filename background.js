'use strict';

chrome.runtime.onUpdateAvailable.addListener(() => {
  chrome.runtime.reload();
});
