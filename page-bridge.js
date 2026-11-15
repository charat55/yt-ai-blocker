/**
 * YT AI Channel Blocker - Page Bridge (MAIN world)
 * 公式 AI バッジ（プレイヤー下の「AI」）とチャンネル情報を Polymer / ytInitialData から読み取り、
 * CustomEvent で content script へ渡す。
 */
(() => {
  'use strict';

  const EVENT_NAME = 'yt-ai-blocker-page-data';

  /** 公式 AI バッジの accessibility 文言パターン */
  const AI_BADGE_A11Y = [
    /^ai\s*:/i,
    /コンテンツは\s*ai\s*を利用して作成/i,
    /content was made with ai/i,
    /made with ai/i
  ];

  function isOfficialAiBadge(badge) {
    if (!badge || typeof badge !== 'object') return false;
    const label = String(badge.label || '').trim();
    if (label !== 'AI') return false;
    const a11y =
      (badge.accessibilityData && badge.accessibilityData.label) ||
      (badge.accessibility && badge.accessibility.label) ||
      '';
    // aria が空でも、INFO + label "AI" は公式バッジとして扱う
    if (!a11y) return badge.icon?.iconType === 'INFO' || badge.style === 'BADGE_STYLE_TYPE_SIMPLE';
    return AI_BADGE_A11Y.some((re) => re.test(a11y));
  }

  function walk(root, visit, maxNodes = 12000) {
    const stack = [root];
    let seen = 0;
    while (stack.length && seen < maxNodes) {
      const node = stack.pop();
      seen += 1;
      if (!node || typeof node !== 'object') continue;
      if (visit(node) === true) return true;
      if (Array.isArray(node)) {
        for (let i = 0; i < node.length; i += 1) stack.push(node[i]);
      } else {
        for (const key of Object.keys(node)) stack.push(node[key]);
      }
    }
    return false;
  }

  function collectRoots() {
    const roots = [];
    const push = (v) => {
      if (v && typeof v === 'object') roots.push(v);
    };

    push(window.ytInitialData);
    push(window.ytInitialPlayerResponse);

    const flexy = document.querySelector('ytd-watch-flexy');
    push(flexy && flexy.data);
    push(flexy && flexy.__data && flexy.__data.data);
    // プレイリスト視聴時も playerResponse がここに載ることがある
    push(flexy && flexy.playerData);
    push(flexy && flexy.__data && flexy.__data.playerData);

    const app = document.querySelector('ytd-app');
    push(app && app.data);
    push(app && app.__data && app.__data.data);

    const meta = document.querySelector('ytd-watch-metadata');
    push(meta && meta.data);
    push(meta && meta.__data && meta.__data.data);

    const primary = document.querySelector(
      'ytd-video-primary-info-renderer, ytd-watch-metadata #title'
    );
    push(primary && primary.data);
    push(primary && primary.__data && primary.__data.data);

    return roots;
  }

  function detectAiBadge(roots) {
    let found = null;
    for (const root of roots) {
      walk(root, (node) => {
        if (node.metadataBadgeRenderer && isOfficialAiBadge(node.metadataBadgeRenderer)) {
          const b = node.metadataBadgeRenderer;
          found = {
            matched: 'AI',
            source: 'main-metadataBadge',
            a11y:
              (b.accessibilityData && b.accessibilityData.label) ||
              (b.accessibility && b.accessibility.label) ||
              'AI'
          };
          return true;
        }
        // badges 配列の直下も検査（composite primary info）
        if (Array.isArray(node.badges)) {
          for (const item of node.badges) {
            const badge = item && item.metadataBadgeRenderer;
            if (isOfficialAiBadge(badge)) {
              found = {
                matched: 'AI',
                source: 'main-badges-array',
                a11y:
                  (badge.accessibilityData && badge.accessibilityData.label) ||
                  'AI'
              };
              return true;
            }
          }
        }
        return false;
      });
      if (found) break;
    }
    return found;
  }

  function extractChannel(roots) {
    let found = null;
    for (const root of roots) {
      walk(root, (node) => {
        if (node.videoOwnerRenderer) {
          const owner = node.videoOwnerRenderer;
          const nav = owner.navigationEndpoint && owner.navigationEndpoint.browseEndpoint;
          const href =
            (nav && nav.canonicalBaseUrl) ||
            (owner.navigationEndpoint &&
              owner.navigationEndpoint.commandMetadata &&
              owner.navigationEndpoint.commandMetadata.webCommandMetadata &&
              owner.navigationEndpoint.commandMetadata.webCommandMetadata.url) ||
            '';
          const name =
            (owner.title && owner.title.runs && owner.title.runs[0] && owner.title.runs[0].text) ||
            (owner.title && owner.title.simpleText) ||
            '';
          const browseId = (nav && nav.browseId) || '';
          if (href || browseId) {
            found = { href, browseId, name };
            return true;
          }
        }
        // microformat / videoDetails フォールバック
        if (node.videoDetails && node.videoDetails.channelId) {
          found = {
            href: '',
            browseId: node.videoDetails.channelId,
            name: node.videoDetails.author || ''
          };
          return true;
        }
        if (node.ownerChannelName && node.externalChannelId) {
          found = {
            href: '',
            browseId: node.externalChannelId,
            name: node.ownerChannelName
          };
          return true;
        }
        return false;
      });
      if (found) break;
    }
    return found;
  }

  function publish() {
    if (location.pathname !== '/watch') {
      document.documentElement.dispatchEvent(
        new CustomEvent(EVENT_NAME, {
          detail: { videoId: null, detection: null, channel: null }
        })
      );
      return;
    }

    const params = new URLSearchParams(location.search);
    const videoId = params.get('v');
    const roots = collectRoots();
    const detection = detectAiBadge(roots);
    const channel = extractChannel(roots);

    document.documentElement.dispatchEvent(
      new CustomEvent(EVENT_NAME, {
        detail: { videoId, detection, channel, list: params.get('list') || null }
      })
    );
  }

  let timer = null;
  function schedule(delay) {
    clearTimeout(timer);
    timer = setTimeout(publish, delay);
  }

  document.addEventListener('yt-navigate-finish', () => schedule(500));
  document.addEventListener('yt-page-data-updated', () => schedule(350));
  window.addEventListener('load', () => schedule(700));
  schedule(900);

  document.documentElement.addEventListener('yt-ai-blocker-request-scan', () => {
    schedule(80);
  });
})();
