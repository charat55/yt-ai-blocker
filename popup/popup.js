/**
 * YT AI Channel Blocker - Popup UI
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

const els = {
  enabledToggle: document.getElementById('enabledToggle'),
  keywordsInput: document.getElementById('keywordsInput'),
  saveKeywordsBtn: document.getElementById('saveKeywordsBtn'),
  resetKeywordsBtn: document.getElementById('resetKeywordsBtn'),
  blockedList: document.getElementById('blockedList'),
  blockedCount: document.getElementById('blockedCount'),
  emptyBlocked: document.getElementById('emptyBlocked'),
  exportBtn: document.getElementById('exportBtn'),
  importInput: document.getElementById('importInput'),
  importStatus: document.getElementById('importStatus'),
  debugToggle: document.getElementById('debugToggle')
};

function setStatus(message, isError = false) {
  els.importStatus.textContent = message || '';
  els.importStatus.classList.toggle('error', Boolean(isError));
}

async function getSettings() {
  return chrome.storage.local.get([
    'enabled',
    'autoAction',
    'keywords',
    'debugLog',
    'blockedChannels'
  ]);
}

function parseKeywords(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function renderBlockedList(channels) {
  const list = Array.isArray(channels) ? channels : [];
  els.blockedCount.textContent = String(list.length);
  els.blockedList.innerHTML = '';
  els.emptyBlocked.classList.toggle('hidden', list.length > 0);

  for (const ch of list) {
    const li = document.createElement('li');

    const meta = document.createElement('div');
    meta.className = 'channel-meta';

    const name = document.createElement('div');
    name.className = 'channel-name';
    name.textContent = ch.name || ch.id || '(unknown)';
    meta.appendChild(name);

    const id = document.createElement('div');
    id.className = 'channel-id';
    id.textContent = ch.id || ch.handle || '';
    meta.appendChild(id);

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'btn danger';
    removeBtn.textContent = '解除';
    removeBtn.addEventListener('click', async () => {
      const data = await getSettings();
      const next = (data.blockedChannels || []).filter(
        (c) => (c.id || c.handle) !== (ch.id || ch.handle)
      );
      await chrome.storage.local.set({ blockedChannels: next });
      renderBlockedList(next);
      setStatus(`「${ch.name || ch.id}」を解除しました`);
    });

    li.appendChild(meta);
    li.appendChild(removeBtn);
    els.blockedList.appendChild(li);
  }
}

async function render() {
  const data = await getSettings();

  els.enabledToggle.checked = data.enabled !== false;
  els.debugToggle.checked = Boolean(data.debugLog);

  const action = data.autoAction || 'notify';
  const radio = document.querySelector(`input[name="autoAction"][value="${action}"]`);
  if (radio) radio.checked = true;

  const keywords = Array.isArray(data.keywords) && data.keywords.length
    ? data.keywords
    : DEFAULT_KEYWORDS;
  els.keywordsInput.value = keywords.join('\n');

  renderBlockedList(data.blockedChannels || []);
}

els.enabledToggle.addEventListener('change', async () => {
  await chrome.storage.local.set({ enabled: els.enabledToggle.checked });
  setStatus(els.enabledToggle.checked ? '拡張機能を有効化しました' : '拡張機能を無効化しました');
});

document.querySelectorAll('input[name="autoAction"]').forEach((input) => {
  input.addEventListener('change', async () => {
    if (!input.checked) return;
    await chrome.storage.local.set({ autoAction: input.value });
    setStatus('検知時の動作を保存しました');
  });
});

els.saveKeywordsBtn.addEventListener('click', async () => {
  const keywords = parseKeywords(els.keywordsInput.value);
  if (!keywords.length) {
    setStatus('キーワードを1つ以上入力してください', true);
    return;
  }
  await chrome.storage.local.set({ keywords });
  setStatus(`キーワードを ${keywords.length} 件保存しました`);
});

els.resetKeywordsBtn.addEventListener('click', async () => {
  els.keywordsInput.value = DEFAULT_KEYWORDS.join('\n');
  await chrome.storage.local.set({ keywords: DEFAULT_KEYWORDS });
  setStatus('デフォルトキーワードに戻しました');
});

els.debugToggle.addEventListener('change', async () => {
  await chrome.storage.local.set({ debugLog: els.debugToggle.checked });
  setStatus(els.debugToggle.checked ? 'デバッグログをONにしました' : 'デバッグログをOFFにしました');
});

els.exportBtn.addEventListener('click', async () => {
  const data = await getSettings();
  const payload = {
    version: 1,
    exportedAt: new Date().toISOString(),
    enabled: data.enabled !== false,
    autoAction: data.autoAction || 'notify',
    keywords: data.keywords || DEFAULT_KEYWORDS,
    blockedChannels: data.blockedChannels || []
  };

  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `yt-ai-blocker-export-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
  setStatus('JSONをエクスポートしました');
});

els.importInput.addEventListener('change', async () => {
  const file = els.importInput.files?.[0];
  if (!file) return;

  try {
    const text = await file.text();
    const json = JSON.parse(text);

    const patch = {};
    if (typeof json.enabled === 'boolean') patch.enabled = json.enabled;
    if (typeof json.autoAction === 'string') patch.autoAction = json.autoAction;
    if (Array.isArray(json.keywords)) patch.keywords = json.keywords.filter(Boolean);
    if (Array.isArray(json.blockedChannels)) {
      // 既存とマージ（id 重複はスキップ）
      const current = (await getSettings()).blockedChannels || [];
      const map = new Map();
      for (const ch of [...current, ...json.blockedChannels]) {
        const key = ch.id || ch.handle;
        if (!key) continue;
        if (!map.has(key)) map.set(key, ch);
      }
      patch.blockedChannels = [...map.values()];
    }

    if (!Object.keys(patch).length) {
      setStatus('インポート可能なデータが見つかりませんでした', true);
      return;
    }

    await chrome.storage.local.set(patch);
    await render();
    setStatus('JSONをインポートしました');
  } catch (err) {
    console.error(err);
    setStatus('JSONの読み込みに失敗しました', true);
  } finally {
    els.importInput.value = '';
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.blockedChannels) {
    renderBlockedList(changes.blockedChannels.newValue || []);
  }
});

render().catch((err) => {
  console.error(err);
  setStatus('設定の読み込みに失敗しました', true);
});
