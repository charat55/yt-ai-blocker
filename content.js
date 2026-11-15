/**
 * YT AI Channel Blocker - Content Script
 * YouTube DOM の受動的解析による AI ラベル検知・チャンネルブロック・一覧フィルタリング
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

  /** @type {{enabled:boolean, autoAction:string, keywords:string[], debugLog:boolean, blockedChannels:Array}} */
  let settings = {
    enabled: true,
    autoAction: 'notify',
    keywords: [],
    debugLog: false,
    blockedChannels: []
  };

  /** ブロック済みチャンネル ID の高速参照用 Set */
  let blockedIdSet = new Set();

  /** 同一 watch ページでの二重登録防止 */
  let lastHandledVideoKey = null;
  let detectTimer = null;
  let filterTimer = null;
  let toastTimer = null;

  function log(...args) {
    if (settings.debugLog) {
      console.log(LOG_PREFIX, ...args);
    }
  }

  function warn(...args) {
    console.warn(LOG_PREFIX, ...args);
  }

  // ---------------------------------------------------------------------------
  // Storage
  // ---------------------------------------------------------------------------

  async function loadSettings() {
    const data = await chrome.storage.local.get([
      'enabled',
      'autoAction',
      'keywords',
      'debugLog',
      'blockedChannels'
    ]);

    settings = {
      enabled: data.enabled !== false,
      autoAction: data.autoAction || 'notify',
      keywords: Array.isArray(data.keywords) ? data.keywords : [],
      debugLog: Boolean(data.debugLog),
      blockedChannels: Array.isArray(data.blockedChannels) ? data.blockedChannels : []
    };

    rebuildBlockedSet();
    log('Settings loaded', {
      enabled: settings.enabled,
      autoAction: settings.autoAction,
      keywordCount: settings.keywords.length,
      blockedCount: settings.blockedChannels.length
    });
  }

  function rebuildBlockedSet() {
    blockedIdSet = new Set(
      settings.blockedChannels
        .map((ch) => normalizeChannelId(ch.id || ch.handle || ''))
        .filter(Boolean)
    );
  }

  function normalizeChannelId(raw) {
    if (!raw) return '';
    let s = String(raw).trim();
    try {
      if (s.startsWith('http')) {
        const u = new URL(s);
        s = u.pathname;
      }
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
    const id = normalizeChannelId(channel.id || channel.handle);
    if (!id) {
      warn('Cannot block channel without id/handle', channel);
      return false;
    }

    if (blockedIdSet.has(id)) {
      log('Already blocked:', id);
      return false;
    }

    const entry = {
      id,
      name: channel.name || id,
      handle: channel.handle || (id.startsWith('@') ? id : ''),
      blockedAt: new Date().toISOString()
    };

    const next = [...settings.blockedChannels, entry];
    settings.blockedChannels = next;
    rebuildBlockedSet();
    await chrome.storage.local.set({ blockedChannels: next });
    log('Blocked channel added:', entry);
    return true;
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

    requestAnimationFrame(() => {
      el.classList.add('yt-ai-blocker-toast-visible');
    });

    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.classList.remove('yt-ai-blocker-toast-visible');
    }, 4200);
  }

  // ---------------------------------------------------------------------------
  // Watch page: AI label detection
  // ---------------------------------------------------------------------------

  function isWatchPage() {
    return location.pathname === '/watch';
  }

  function getCurrentVideoKey() {
    const params = new URLSearchParams(location.search);
    return params.get('v') || location.href;
  }

  function textIncludesKeyword(text, keywords) {
    if (!text || !keywords?.length) return null;
    const lower = text.toLowerCase();
    for (const kw of keywords) {
      const k = String(kw || '').trim();
      if (!k) continue;
      if (lower.includes(k.toLowerCase())) return k;
    }
    return null;
  }

  /**
   * AI 開示ラベルの検知。
   * - how-this-was-made / バッジ / info-panel を優先
   * - キーワード一致で判定（ユーザーカスタム対応）
   */
  function detectAiLabel() {
    const keywords = settings.keywords;
    if (!keywords.length) return null;

    const scopes = [];
    const meta = document.querySelector('ytd-watch-metadata');
    if (meta) scopes.push(meta);

    const panels = document.querySelectorAll(
      'ytd-info-panel-content-renderer, ytd-engagement-panel-section-list-renderer, ytd-expandable-video-description-body-renderer'
    );
    panels.forEach((p) => scopes.push(p));

    // 専用コンポーネント
    const dedicated = document.querySelectorAll(
      'how-this-was-made-section-view-model, [class*="HowThisWasMade"], ytd-info-panel-content-renderer'
    );
    for (const el of dedicated) {
      const hit = textIncludesKeyword(el.textContent || '', keywords);
      if (hit) return { matched: hit, source: 'dedicated-panel' };
    }

    // メタデータバッジ
    const badges = document.querySelectorAll(
      'yt-metadata-badge-renderer, badge-shape, .badge-shape, ytd-badge-supported-renderer'
    );
    let badgeCount = 0;
    for (const badge of badges) {
      if (++badgeCount > 80) break;
      const blob = [
        badge.getAttribute('aria-label') || '',
        badge.getAttribute('title') || '',
        badge.textContent || ''
      ].join(' ');
      const hit = textIncludesKeyword(blob, keywords);
      if (hit) return { matched: hit, source: 'badge' };
    }

    // attributed-string 内のテキスト
    for (const scope of scopes) {
      const strings = scope.querySelectorAll('yt-attributed-string, #description, #info-contents');
      for (const s of strings) {
        const hit = textIncludesKeyword(s.textContent || '', keywords);
        if (hit) return { matched: hit, source: 'attributed-string' };
      }
    }

    // フォールバック: watch metadata 全体
    if (meta) {
      const hit = textIncludesKeyword(meta.textContent || '', keywords);
      if (hit) return { matched: hit, source: 'watch-metadata' };
    }

    return null;
  }

  function extractChannelFromWatchPage() {
    // オーナー名リンクを優先
    const candidates = [
      document.querySelector('ytd-video-owner-renderer a[href^="/@"]'),
      document.querySelector('ytd-video-owner-renderer a[href^="/channel/"]'),
      document.querySelector('#owner a[href^="/@"]'),
      document.querySelector('#owner a[href^="/channel/"]'),
      document.querySelector('ytd-channel-name a[href^="/@"]'),
      document.querySelector('ytd-channel-name a[href^="/channel/"]'),
      document.querySelector('#channel-name a[href^="/@"]'),
      document.querySelector('#channel-name a[href^="/channel/"]')
    ].filter(Boolean);

    const link = candidates[0];
    if (!link) return null;

    const href = link.getAttribute('href') || '';
    const id = normalizeChannelId(href);
    const name =
      link.textContent?.trim() ||
      document.querySelector('ytd-channel-name #text')?.textContent?.trim() ||
      id;

    const handle = id.startsWith('@') ? id : '';
    return { id, name, handle };
  }

  async function handleWatchPageDetection() {
    if (!settings.enabled || !isWatchPage()) return;

    const videoKey = getCurrentVideoKey();
    if (videoKey === lastHandledVideoKey) return;

    const detection = detectAiLabel();
    if (!detection) {
      log('No AI label on watch page');
      return;
    }

    const channel = extractChannelFromWatchPage();
    if (!channel?.id) {
      log('AI label found but channel not yet available; will retry');
      return;
    }

    lastHandledVideoKey = videoKey;
    log('AI label detected:', detection, 'channel:', channel);

    const added = await addBlockedChannel(channel);
    const nameLabel = channel.name || channel.id;

    if (added) {
      showToast(
        'AIチャンネルをブロックリストに追加しました',
        nameLabel
      );
    } else {
      showToast(
        'このチャンネルは既にブロック済みです',
        nameLabel
      );
    }

    // 一覧にも即反映
    scheduleFilter();

    const action = settings.autoAction;
    if (action === 'back') {
      setTimeout(() => {
        if (history.length > 1) {
          history.back();
        } else {
          location.href = 'https://www.youtube.com/';
        }
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
  // Feed / listing filter
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

    if (card.getAttribute(CHECKED_ATTR) === 'true') {
      // ブロック集合が変わった場合に再評価が必要なら属性を外して再実行する
      return;
    }

    const channelId = extractChannelIdFromCard(card);
    card.setAttribute(CHECKED_ATTR, 'true');

    if (!channelId) return;

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
      if (forceRecheck) {
        card.removeAttribute(CHECKED_ATTR);
      }
      filterCard(card);
    }
    log('Filtered cards:', cards.length, 'force=', forceRecheck);
  }

  function scheduleFilter(forceRecheck = false, delay = 120) {
    clearTimeout(filterTimer);
    filterTimer = setTimeout(() => filterAllCards(forceRecheck), delay);
  }

  // ---------------------------------------------------------------------------
  // Observers & navigation
  // ---------------------------------------------------------------------------

  function onNavigate() {
    lastHandledVideoKey = null;
    log('Navigate:', location.pathname + location.search);
    scheduleWatchDetection(600);
    scheduleFilter(true, 300);
  }

  function setupObservers() {
    const observer = new MutationObserver((mutations) => {
      let hasNewNodes = false;
      for (const m of mutations) {
        if (m.addedNodes && m.addedNodes.length) {
          hasNewNodes = true;
          break;
        }
      }
      if (!hasNewNodes) return;

      if (isWatchPage()) {
        scheduleWatchDetection(500);
      }
      scheduleFilter(false, 150);
    });

    const root = document.documentElement || document.body;
    observer.observe(root, { childList: true, subtree: true });

    document.addEventListener('yt-navigate-finish', onNavigate);
    document.addEventListener('yt-page-data-updated', () => {
      scheduleWatchDetection(400);
      scheduleFilter(false, 200);
    });

    // SPA でイベントが取れない場合のフォールバック
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
    if (changes.keywords) {
      settings.keywords = Array.isArray(changes.keywords.newValue)
        ? changes.keywords.newValue
        : [];
      lastHandledVideoKey = null;
      scheduleWatchDetection(200);
    }
    if (changes.debugLog) {
      settings.debugLog = Boolean(changes.debugLog.newValue);
    }
    if (changes.blockedChannels) {
      settings.blockedChannels = Array.isArray(changes.blockedChannels.newValue)
        ? changes.blockedChannels.newValue
        : [];
      rebuildBlockedSet();
      needRefilter = true;
    }

    if (needRefilter) {
      scheduleFilter(true, 50);
    }
  });

  // ---------------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------------

  async function init() {
    await loadSettings();
    setupObservers();
    scheduleWatchDetection(800);
    scheduleFilter(true, 400);
    log('Content script initialized');
  }

  init().catch((err) => warn('init failed', err));
})();
