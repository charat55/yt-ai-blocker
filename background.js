/**
 * YT AI Channel Blocker - Background Service Worker
 * ストレージの初期化とデフォルト設定の投入を担当する。
 */

const SETTINGS_VERSION = 3;

const DEFAULT_SETTINGS = {
  enabled: true,
  autoAction: 'notify', // 'back' | 'home' | 'notify'
  debugLog: false,
  blockedChannels: [], // [{ id, name, handle, channelUcId, blockedAt }]
  allowedChannels: [] // [{ id, name, handle, channelUcId, allowedAt }]
};

chrome.runtime.onInstalled.addListener(async (details) => {
  const stored = await chrome.storage.local.get(null);
  const patch = {};

  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    if (stored[key] === undefined) {
      patch[key] = value;
    }
  }

  if (stored.settingsVersion !== SETTINGS_VERSION) {
    patch.settingsVersion = SETTINGS_VERSION;
    if (!Array.isArray(stored.allowedChannels)) {
      patch.allowedChannels = [];
    }
  }

  if (Object.keys(patch).length > 0) {
    await chrome.storage.local.set(patch);
  }

  if (details.reason === 'install') {
    console.log('[YT-AI-Blocker] Extension installed. Defaults applied.');
  } else if (details.reason === 'update') {
    console.log('[YT-AI-Blocker] Extension updated to settings v' + SETTINGS_VERSION);
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'GET_DEFAULTS') {
    sendResponse({ defaults: DEFAULT_SETTINGS });
    return true;
  }
  return false;
});
