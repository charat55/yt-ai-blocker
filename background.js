/**
 * YT AI Channel Blocker - Background Service Worker
 * ストレージの初期化とデフォルト設定の投入を担当する。
 */

const DEFAULT_KEYWORDS = [
  '改変または合成されたコンテンツ',
  'Altered or synthetic content',
  'AI生成',
  'Made with AI',
  'Content was made with AI',
  'AIで作成されたコンテンツ',
  'Sounds or visuals were altered or fully generated'
];

const DEFAULT_SETTINGS = {
  enabled: true,
  autoAction: 'notify', // 'back' | 'home' | 'notify'
  keywords: DEFAULT_KEYWORDS,
  debugLog: false,
  blockedChannels: [] // [{ id, name, handle, blockedAt }]
};

chrome.runtime.onInstalled.addListener(async (details) => {
  const stored = await chrome.storage.local.get(null);
  const patch = {};

  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    if (stored[key] === undefined) {
      patch[key] = value;
    }
  }

  // キーワードが空配列の場合はデフォルトへ戻す
  if (Array.isArray(stored.keywords) && stored.keywords.length === 0) {
    patch.keywords = DEFAULT_KEYWORDS;
  }

  if (Object.keys(patch).length > 0) {
    await chrome.storage.local.set(patch);
  }

  if (details.reason === 'install') {
    console.log('[YT-AI-Blocker] Extension installed. Defaults applied.');
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'GET_DEFAULTS') {
    sendResponse({ defaults: DEFAULT_SETTINGS });
    return true;
  }
  return false;
});
