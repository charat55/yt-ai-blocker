/**
 * YT AI Channel Blocker - Content Script
 * 公式「AI」バッジ検知によるチャンネル自動ブロック / 一覧フィルタ / 許可リスト
 */

(() => {
  'use strict';

  const LOG_PREFIX = '[YT-AI-Blocker]';
  const CHECKED_ATTR = 'data-ai-checked';
  const HIDDEN_CLASS = 'yt-ai-blocker-hidden';
  const TOAST_ID = 'yt-ai-blocker-toast';

  const VIDEO_CARD_SELECTORS = [
    'ytd-rich-item-renderer',
    'ytd-video-renderer',
    'ytd-compact-video-renderer',
    'ytd-grid-video-renderer',
    'ytd-playlist-video-renderer',
    'ytd-reel-item-renderer',
    'ytm-shorts-lockup-view-model',
    'ytd-rich-grid-media'
  ].join(',');

  const CHANNEL_LINK_SELECTOR = 'a[href^="/@"], a[href^="/channel/"]';

  /** 公式 AI バッジの aria パターン */
  const AI_BADGE_A11Y = [
    /^ai\s*:/i,
    /コンテンツは\s*ai\s*を利用して作成/i,
    /content was made with ai/i,
    /made with ai/i
  ];

  let settings = {
    enabled: true,
    autoAction: 'notify',
    debugLog: false,
    blockedChannels: [],
    allowedChannels: []
  };

  let blockedIdSet = new Set();
  let allowedIdSet = new Set();

  let lastHandledVideoKey = null;
  let pendingAiVideoKey = null;
  let detectTimer = null;
  let filterTimer = null;
  let toastTimer = null;
  let channelRetryCount = 0;

  let bridgeDetection = null;
  let bridgeChannel = null;

  function log(...args) {
    if (settings.debugLog) console.log(LOG_PREFIX, ...args);
  }

  function warn(...args) {
    console.warn(LOG_PREFIX, ...args);
  }

  // ---------------------------------------------------------------------------
  // Storage
  // ---------------------------------------------------------------------------

  function channelKeys(ch) {
    const keys = [];
    if (!ch) return keys;
    for (const raw of [ch.id, ch.handle, ch.channelUcId, ch.browseId]) {
      const n = normalizeChannelId(raw || '');
      if (n) keys.push(n);
    }
    return [...new Set(keys)];
  }

  function rebuildSets() {
    blockedIdSet = new Set();
    for (const ch of settings.blockedChannels) {
      for (const k of channelKeys(ch)) blockedIdSet.add(k);
    }
    allowedIdSet = new Set();
    for (const ch of settings.allowedChannels) {
      for (const k of channelKeys(ch)) allowedIdSet.add(k);
    }
  }

  function isAllowedChannel(channel) {
    return channelKeys(channel).some((k) => allowedIdSet.has(k));
  }

  function isBlockedChannel(channelOrId) {
    if (typeof channelOrId === 'string') {
      const n = normalizeChannelId(channelOrId);
      return n && blockedIdSet.has(n) && !allowedIdSet.has(n);
    }
    const keys = channelKeys(channelOrId);
    if (keys.some((k) => allowedIdSet.has(k))) return false;
    return keys.some((k) => blockedIdSet.has(k));
  }

  async function loadSettings() {
    const data = await chrome.storage.local.get([
      'enabled',
      'autoAction',
      'debugLog',
      'blockedChannels',
      'allowedChannels'
    ]);

    settings = {
      enabled: data.enabled !== false,
      autoAction: data.autoAction || 'notify',
      debugLog: Boolean(data.debugLog),
      blockedChannels: Array.isArray(data.blockedChannels) ? data.blockedChannels : [],
      allowedChannels: Array.isArray(data.allowedChannels) ? data.allowedChannels : []
    };

    rebuildSets();
    log('Settings loaded', {
      enabled: settings.enabled,
      autoAction: settings.autoAction,
      blockedCount: settings.blockedChannels.length,
      allowedCount: settings.allowedChannels.length
    });
  }

  function normalizeChannelId(raw) {
    if (!raw) return '';
    let s = String(raw).trim();
    try {
      if (s.startsWith('http')) s = new URL(s).pathname;
    } catch {
      /* ignore */
    }
    try {
      s = decodeURIComponent(s);
    } catch {
      /* ignore */
    }
    s = s.split('?')[0].split('#')[0];
    const handleMatch = s.match(/\/@([^/]+)/);
    if (handleMatch) return `@${handleMatch[1]}`.toLowerCase();
    const channelMatch = s.match(/\/channel\/(UC[\w-]+)/i);
    if (channelMatch) return channelMatch[1];
    if (s.startsWith('@')) return s.toLowerCase();
    if (/^UC[\w-]+$/i.test(s)) return s;
    return s.toLowerCase();
  }

  async function addBlockedChannel(channel) {
    if (isAllowedChannel(channel)) {
      log('Channel is allowed; skip block', channel);
      return { added: false, skippedAllowed: true };
    }

    const keys = channelKeys(channel);
    const id = keys[0];
    if (!id) {
      warn('Cannot block channel without id/handle', channel);
      return { added: false };
    }

    if (keys.some((k) => blockedIdSet.has(k))) {
      log('Already blocked:', id);
      return { added: false, already: true };
    }

    const entry = {
      id,
      name: channel.name || id,
      handle: channel.handle || (id.startsWith('@') ? id : ''),
      channelUcId: channel.channelUcId || (id.startsWith('UC') ? id : '') || '',
      blockedAt: new Date().toISOString()
    };

    const next = [...settings.blockedChannels, entry];
    settings.blockedChannels = next;
    rebuildSets();
    await chrome.storage.local.set({ blockedChannels: next });
    log('Blocked channel added:', entry);
    return { added: true };
  }

  // ---------------------------------------------------------------------------
  // Toast
  // ---------------------------------------------------------------------------

  function showToast(title, body) {
    let el = document.getElementById(TOAST_ID);
    if (!el) {
      el = document.createElement('div');
      el.id = TOAST_ID;
      document.documentElement.appendChild(el);
    }

    el.innerHTML = '';
    const titleEl = document.createElement('div');
    titleEl.className = 'yt-ai-blocker-toast-title';
    titleEl.textContent = title;
    el.appendChild(titleEl);

    if (body) {
      const bodyEl = document.createElement('div');
      bodyEl.className = 'yt-ai-blocker-toast-body';
      bodyEl.textContent = body;
      el.appendChild(bodyEl);
    }

    requestAnimationFrame(() => el.classList.add('yt-ai-blocker-toast-visible'));
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.classList.remove('yt-ai-blocker-toast-visible');
    }, 4200);
  }

  // ---------------------------------------------------------------------------
  // Official AI badge detection (badge only)
  // ---------------------------------------------------------------------------

  function isWatchPage() {
    return location.pathname === '/watch';
  }

  function getCurrentVideoKey() {
    return new URLSearchParams(location.search).get('v') || location.href;
  }

  function isOfficialAiBadgeNode(el) {
    if (!el) return false;
    const labelText = (el.textContent || '').replace(/\s+/g, ' ').trim();
    // 表示テキストが「AI」そのもの（余分な文字を含まない）
    if (labelText !== 'AI') {
      // 子要素に「AI」だけのノードがある場合
      const inner = el.querySelector?.('.yt-badge-shape__text, .badge-shape-wiz__text, #badge');
      const innerText = (inner?.textContent || '').replace(/\s+/g, ' ').trim();
      if (innerText !== 'AI' && labelText !== 'AI') return false;
    }

    const aria =
      el.getAttribute('aria-label') ||
      el.querySelector?.('[aria-label]')?.getAttribute('aria-label') ||
      '';

    if (aria) return AI_BADGE_A11Y.some((re) => re.test(aria));

    // aria 未設定でも、メタデータ領域内の単独「AI」バッジを公式とみなす
    return true;
  }

  function detectAiBadgeInDom() {
    // プレイヤーと詳細の間（タイトル直下）を優先
    const scopes = [
      document.querySelector('ytd-watch-metadata'),
      document.querySelector('#above-the-fold'),
      document.querySelector('ytd-video-primary-info-renderer'),
      document.querySelector('#title.ytd-watch-metadata'),
      document.querySelector('#top-row')
    ].filter(Boolean);

    const searchRoot = scopes.length ? null : document;

    const selectors = [
      'yt-metadata-badge-renderer',
      'ytd-badge-supported-renderer',
      'badge-shape',
      '.badge-shape',
      '.yt-badge-shape',
      '[class*="badge-shape"]'
    ].join(',');

    const roots = scopes.length ? scopes : [searchRoot];
    for (const root of roots) {
      if (!root) continue;
      const badges = root.querySelectorAll(selectors);
      for (const badge of badges) {
        if (isOfficialAiBadgeNode(badge)) {
          return {
            matched: 'AI',
            source: 'dom-badge',
            a11y: badge.getAttribute('aria-label') || 'AI'
          };
        }
      }
    }

    // フォールバック: aria-label が公式 AI 文言の要素
    const ariaNodes = document.querySelectorAll('[aria-label]');
    let checked = 0;
    for (const node of ariaNodes) {
      if (++checked > 400) break;
      const aria = node.getAttribute('aria-label') || '';
      if (!AI_BADGE_A11Y.some((re) => re.test(aria))) continue;
      // プレイヤー〜メタデータ付近に限定
      if (
        node.closest(
          'ytd-watch-metadata, #above-the-fold, ytd-video-primary-info-renderer, #primary-inner'
        )
      ) {
        return { matched: 'AI', source: 'dom-aria', a11y: aria };
      }
    }

    return null;
  }

  function detectAiBadgeFromScripts() {
    const scripts = document.querySelectorAll('script');
    for (const script of scripts) {
      const src = script.textContent || '';
      if (!src.includes('"label":"AI"') && !src.includes('"label": "AI"')) continue;

      // metadataBadgeRenderer 近傍の AI ラベルのみを対象（説明文の「AI」は除外）
      const re =
        /"metadataBadgeRenderer"\s*:\s*\{([^{}]|\{[^{}]*\}){0,40}?"label"\s*:\s*"AI"/g;
      if (re.test(src)) {
        return { matched: 'AI', source: 'page-script-badge' };
      }

      // accessibility 付きの短縮マッチ
      if (
        /"label"\s*:\s*"AI"/.test(src) &&
        /"accessibilityData"\s*:\s*\{\s*"label"\s*:\s*"AI:/.test(src)
      ) {
        return { matched: 'AI', source: 'page-script-badge-a11y' };
      }
    }
    return null;
  }

  function detectAiLabel() {
    if (bridgeDetection) return bridgeDetection;

    const fromDom = detectAiBadgeInDom();
    if (fromDom) return fromDom;

    const fromScript = detectAiBadgeFromScripts();
    if (fromScript) return fromScript;

    return null;
  }

  // ---------------------------------------------------------------------------
  // Channel extraction
  // ---------------------------------------------------------------------------

  function channelFromBridge() {
    if (!bridgeChannel) return null;
    const handle = normalizeChannelId(bridgeChannel.href || '');
    const uc = normalizeChannelId(bridgeChannel.browseId || '');
    const id = handle || uc;
    if (!id) return null;
    return {
      id,
      name: bridgeChannel.name || id,
      handle: handle.startsWith('@') ? handle : '',
      channelUcId: uc.startsWith('UC') ? uc : ''
    };
  }

  function extractChannelFromWatchPage() {
    const candidates = [
      document.querySelector('ytd-video-owner-renderer a[href^="/@"]'),
      document.querySelector('ytd-video-owner-renderer a[href^="/channel/"]'),
      document.querySelector('#owner a[href^="/@"]'),
      document.querySelector('#owner a[href^="/channel/"]'),
      document.querySelector('ytd-channel-name a[href^="/@"]'),
      document.querySelector('ytd-channel-name a[href^="/channel/"]'),
      document.querySelector('#channel-name a[href^="/@"]'),
      document.querySelector('#channel-name a[href^="/channel/"]'),
      document.querySelector('ytd-watch-metadata #owner-name a[href^="/@"]'),
      document.querySelector('ytd-watch-metadata #owner-name a[href^="/channel/"]')
    ].filter(Boolean);

    const link = candidates[0];
    if (link) {
      const href = link.getAttribute('href') || '';
      const id = normalizeChannelId(href);
      const name =
        link.textContent?.trim() ||
        document.querySelector('ytd-channel-name #text')?.textContent?.trim() ||
        document.querySelector('#channel-name')?.textContent?.trim() ||
        id;
      return {
        id,
        name,
        handle: id.startsWith('@') ? id : '',
        channelUcId: id.startsWith('UC') ? id : ''
      };
    }

    return channelFromBridge();
  }

  // ---------------------------------------------------------------------------
  // Watch page handler
  // ---------------------------------------------------------------------------

  async function handleWatchPageDetection() {
    if (!settings.enabled || !isWatchPage()) return;

    const videoKey = getCurrentVideoKey();
    if (videoKey === lastHandledVideoKey) return;

    const detection = detectAiLabel();
    if (!detection) {
      // バッジ未検出。保留中でなければクリア
      if (pendingAiVideoKey === videoKey) {
        log('Waiting for AI badge / channel…', { videoKey, channelRetryCount });
      } else {
        log('No official AI badge on watch page');
      }
      return;
    }

    pendingAiVideoKey = videoKey;
    log('Official AI badge detected:', detection);

    const channel = extractChannelFromWatchPage();
    if (!channel?.id) {
      channelRetryCount += 1;
      log('AI badge found but channel not ready; retry', channelRetryCount);
      document.documentElement.dispatchEvent(new CustomEvent('yt-ai-blocker-request-scan'));
      if (channelRetryCount < 20) {
        scheduleWatchDetection(400);
      }
      return;
    }

    channelRetryCount = 0;
    pendingAiVideoKey = null;
    lastHandledVideoKey = videoKey;

    if (isAllowedChannel(channel)) {
      log('AI badge on allowed channel; skip', channel);
      showToast('許可済みチャンネルのAI動画です', channel.name || channel.id);
      return;
    }

    const result = await addBlockedChannel(channel);
    const nameLabel = channel.name || channel.id;

    if (result.skippedAllowed) {
      showToast('許可済みチャンネルのAI動画です', nameLabel);
      return;
    }

    if (result.added) {
      showToast('AIチャンネルをブロックリストに追加しました', nameLabel);
    } else if (result.already) {
      showToast('このチャンネルは既にブロック済みです', nameLabel);
    }

    scheduleFilter(true);

    const action = settings.autoAction;
    if (action === 'back') {
      setTimeout(() => {
        if (history.length > 1) history.back();
        else location.href = 'https://www.youtube.com/';
      }, 900);
    } else if (action === 'home') {
      setTimeout(() => {
        location.href = 'https://www.youtube.com/';
      }, 900);
    }
  }

  function scheduleWatchDetection(delay = 400) {
    clearTimeout(detectTimer);
    detectTimer = setTimeout(() => {
      handleWatchPageDetection().catch((err) => warn('detect error', err));
    }, delay);
  }

  // ---------------------------------------------------------------------------
  // Feed filter
  // ---------------------------------------------------------------------------

  function extractChannelIdFromCard(card) {
    const links = card.querySelectorAll(CHANNEL_LINK_SELECTOR);
    for (const a of links) {
      const id = normalizeChannelId(a.getAttribute('href') || '');
      if (id) return id;
    }
    return '';
  }

  function filterCard(card) {
    if (!settings.enabled) {
      card.classList.remove(HIDDEN_CLASS);
      return;
    }

    if (card.getAttribute(CHECKED_ATTR) === 'true') return;

    const channelId = extractChannelIdFromCard(card);
    card.setAttribute(CHECKED_ATTR, 'true');
    if (!channelId) return;

    if (allowedIdSet.has(channelId)) {
      card.classList.remove(HIDDEN_CLASS);
      return;
    }

    if (blockedIdSet.has(channelId)) {
      card.classList.add(HIDDEN_CLASS);
      log('Hidden card for', channelId);
    } else {
      card.classList.remove(HIDDEN_CLASS);
    }
  }

  function filterAllCards(forceRecheck = false) {
    const cards = document.querySelectorAll(VIDEO_CARD_SELECTORS);
    for (const card of cards) {
      if (forceRecheck) card.removeAttribute(CHECKED_ATTR);
      filterCard(card);
    }
    log('Filtered cards:', cards.length, 'force=', forceRecheck);
  }

  function scheduleFilter(forceRecheck = false, delay = 120) {
    clearTimeout(filterTimer);
    filterTimer = setTimeout(() => filterAllCards(forceRecheck), delay);
  }

  // ---------------------------------------------------------------------------
  // Observers
  // ---------------------------------------------------------------------------

  function onNavigate() {
    lastHandledVideoKey = null;
    pendingAiVideoKey = null;
    channelRetryCount = 0;
    bridgeDetection = null;
    bridgeChannel = null;
    log('Navigate:', location.pathname + location.search);
    document.documentElement.dispatchEvent(new CustomEvent('yt-ai-blocker-request-scan'));
    scheduleWatchDetection(700);
    scheduleFilter(true, 300);
  }

  function setupObservers() {
    const observer = new MutationObserver(() => {
      if (isWatchPage()) scheduleWatchDetection(500);
      scheduleFilter(false, 150);
    });

    observer.observe(document.documentElement || document.body, {
      childList: true,
      subtree: true
    });

    document.addEventListener('yt-navigate-finish', onNavigate);
    document.addEventListener('yt-page-data-updated', () => {
      scheduleWatchDetection(400);
      scheduleFilter(false, 200);
    });

    let lastUrl = location.href;
    setInterval(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        onNavigate();
      }
    }, 1000);
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    let needRefilter = false;

    if (changes.enabled) {
      settings.enabled = changes.enabled.newValue !== false;
      needRefilter = true;
    }
    if (changes.autoAction) {
      settings.autoAction = changes.autoAction.newValue || 'notify';
    }
    if (changes.debugLog) {
      settings.debugLog = Boolean(changes.debugLog.newValue);
    }
    if (changes.blockedChannels) {
      settings.blockedChannels = Array.isArray(changes.blockedChannels.newValue)
        ? changes.blockedChannels.newValue
        : [];
      rebuildSets();
      needRefilter = true;
    }
    if (changes.allowedChannels) {
      settings.allowedChannels = Array.isArray(changes.allowedChannels.newValue)
        ? changes.allowedChannels.newValue
        : [];
      rebuildSets();
      needRefilter = true;
      // 許可変更後は同一動画でも再評価できるようにする
      lastHandledVideoKey = null;
      scheduleWatchDetection(200);
    }

    if (needRefilter) scheduleFilter(true, 50);
  });

  async function init() {
    await loadSettings();

    document.documentElement.addEventListener('yt-ai-blocker-page-data', (event) => {
      const detail = event.detail || {};
      const currentId = new URLSearchParams(location.search).get('v');
      if (detail.videoId && currentId && detail.videoId !== currentId) return;

      bridgeDetection = detail.detection || null;
      bridgeChannel = detail.channel || null;

      if (bridgeDetection) {
        log('Bridge detection:', bridgeDetection);
        scheduleWatchDetection(80);
      } else if (bridgeChannel && pendingAiVideoKey) {
        scheduleWatchDetection(80);
      }
    });

    document.documentElement.dispatchEvent(new CustomEvent('yt-ai-blocker-request-scan'));
    setupObservers();
    scheduleWatchDetection(900);
    scheduleFilter(true, 400);
    log('Content script initialized');
  }

  init().catch((err) => warn('init failed', err));
})();
