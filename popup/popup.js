/**
 * YT AI Channel Blocker - Popup UI
 */

const els = {
  enabledToggle: document.getElementById('enabledToggle'),
  blockedList: document.getElementById('blockedList'),
  blockedCount: document.getElementById('blockedCount'),
  emptyBlocked: document.getElementById('emptyBlocked'),
  allowedList: document.getElementById('allowedList'),
  allowedCount: document.getElementById('allowedCount'),
  emptyAllowed: document.getElementById('emptyAllowed'),
  exportBtn: document.getElementById('exportBtn'),
  importInput: document.getElementById('importInput'),
  importStatus: document.getElementById('importStatus'),
  debugToggle: document.getElementById('debugToggle')
};

function setStatus(message, isError = false) {
  els.importStatus.textContent = message || '';
  els.importStatus.classList.toggle('error', Boolean(isError));
}

function channelKey(ch) {
  return ch?.id || ch?.handle || ch?.channelUcId || '';
}

async function getSettings() {
  return chrome.storage.local.get([
    'enabled',
    'autoAction',
    'debugLog',
    'blockedChannels',
    'allowedChannels'
  ]);
}

function createMeta(ch) {
  const meta = document.createElement('div');
  meta.className = 'channel-meta';

  const name = document.createElement('div');
  name.className = 'channel-name';
  name.textContent = ch.name || ch.id || '(unknown)';
  meta.appendChild(name);

  const id = document.createElement('div');
  id.className = 'channel-id';
  id.textContent = [ch.id, ch.handle, ch.channelUcId].filter(Boolean).join(' / ');
  meta.appendChild(id);

  return meta;
}

function renderBlockedList(channels) {
  const list = Array.isArray(channels) ? channels : [];
  els.blockedCount.textContent = String(list.length);
  els.blockedList.innerHTML = '';
  els.emptyBlocked.classList.toggle('hidden', list.length > 0);

  for (const ch of list) {
    const li = document.createElement('li');
    li.appendChild(createMeta(ch));

    const actions = document.createElement('div');
    actions.className = 'channel-actions';

    const allowBtn = document.createElement('button');
    allowBtn.type = 'button';
    allowBtn.className = 'btn allow';
    allowBtn.textContent = 'このチャンネルは許可';
    allowBtn.title = '許可リストへ移動（以降ブロックしない）';
    allowBtn.addEventListener('click', async () => {
      const data = await getSettings();
      const key = channelKey(ch);
      const blockedNext = (data.blockedChannels || []).filter((c) => channelKey(c) !== key);
      const allowed = data.allowedChannels || [];
      const already = allowed.some((c) => channelKey(c) === key);
      const allowedNext = already
        ? allowed
        : [
            ...allowed,
            {
              id: ch.id,
              name: ch.name,
              handle: ch.handle || '',
              channelUcId: ch.channelUcId || '',
              allowedAt: new Date().toISOString()
            }
          ];

      await chrome.storage.local.set({
        blockedChannels: blockedNext,
        allowedChannels: allowedNext
      });
      renderBlockedList(blockedNext);
      renderAllowedList(allowedNext);
      setStatus(`「${ch.name || ch.id}」を許可しました`);
    });

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'btn danger';
    removeBtn.textContent = '解除';
    removeBtn.addEventListener('click', async () => {
      const data = await getSettings();
      const next = (data.blockedChannels || []).filter((c) => channelKey(c) !== channelKey(ch));
      await chrome.storage.local.set({ blockedChannels: next });
      renderBlockedList(next);
      setStatus(`「${ch.name || ch.id}」のブロックを解除しました`);
    });

    actions.appendChild(allowBtn);
    actions.appendChild(removeBtn);
    li.appendChild(actions);
    els.blockedList.appendChild(li);
  }
}

function renderAllowedList(channels) {
  const list = Array.isArray(channels) ? channels : [];
  els.allowedCount.textContent = String(list.length);
  els.allowedList.innerHTML = '';
  els.emptyAllowed.classList.toggle('hidden', list.length > 0);

  for (const ch of list) {
    const li = document.createElement('li');
    li.appendChild(createMeta(ch));

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'btn danger';
    removeBtn.textContent = '許可解除';
    removeBtn.addEventListener('click', async () => {
      const data = await getSettings();
      const next = (data.allowedChannels || []).filter((c) => channelKey(c) !== channelKey(ch));
      await chrome.storage.local.set({ allowedChannels: next });
      renderAllowedList(next);
      setStatus(`「${ch.name || ch.id}」の許可を解除しました`);
    });

    li.appendChild(removeBtn);
    els.allowedList.appendChild(li);
  }
}

async function render() {
  const data = await getSettings();

  els.enabledToggle.checked = data.enabled !== false;
  els.debugToggle.checked = Boolean(data.debugLog);

  const action = data.autoAction || 'notify';
  const radio = document.querySelector(`input[name="autoAction"][value="${action}"]`);
  if (radio) radio.checked = true;

  renderBlockedList(data.blockedChannels || []);
  renderAllowedList(data.allowedChannels || []);
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

els.debugToggle.addEventListener('change', async () => {
  await chrome.storage.local.set({ debugLog: els.debugToggle.checked });
  setStatus(els.debugToggle.checked ? 'デバッグログをONにしました' : 'デバッグログをOFFにしました');
});

els.exportBtn.addEventListener('click', async () => {
  const data = await getSettings();
  const payload = {
    version: 2,
    exportedAt: new Date().toISOString(),
    enabled: data.enabled !== false,
    autoAction: data.autoAction || 'notify',
    blockedChannels: data.blockedChannels || [],
    allowedChannels: data.allowedChannels || []
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

    const mergeList = (current, incoming) => {
      const map = new Map();
      for (const ch of [...(current || []), ...(incoming || [])]) {
        const key = channelKey(ch);
        if (!key) continue;
        if (!map.has(key)) map.set(key, ch);
      }
      return [...map.values()];
    };

    if (Array.isArray(json.blockedChannels)) {
      const current = (await getSettings()).blockedChannels || [];
      patch.blockedChannels = mergeList(current, json.blockedChannels);
    }
    if (Array.isArray(json.allowedChannels)) {
      const current = (await getSettings()).allowedChannels || [];
      patch.allowedChannels = mergeList(current, json.allowedChannels);
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
  if (changes.allowedChannels) {
    renderAllowedList(changes.allowedChannels.newValue || []);
  }
});

render().catch((err) => {
  console.error(err);
  setStatus('設定の読み込みに失敗しました', true);
});
