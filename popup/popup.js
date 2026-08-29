'use strict';

const $ = (id) => document.getElementById(id);

let currentHost = '';
let currentTabId = -1;

// Read-modify-write against fresh storage so we never clobber a concurrent
// change (e.g. another popup window or a future options page).
async function updateSettings(mutate) {
  const stored = await chrome.storage.local.get('settings');
  const settings = aasMergeSettings(stored.settings);
  mutate(settings);
  await chrome.storage.local.set({ settings });
  return settings;
}

function render(settings, stats) {
  $('enabled').checked = settings.enabled;
  document.body.classList.toggle('disabled', !settings.enabled);
  $('fastForward').checked = settings.fastForward;
  $('popunderGuard').checked = settings.clickPopunderGuard;
  $('debug').checked = settings.debug;
  $('muteMode').value = settings.muteMode;
  $('totalCount').textContent = String(stats.totalSkipped);

  if (currentHost) {
    $('siteRow').hidden = false;
    $('siteHost').textContent = currentHost;
    $('siteEnabled').checked = !settings.siteDisabled[currentHost];
  } else {
    $('siteRow').hidden = true;
  }
}

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) {
    currentTabId = tab.id;
    const host = aasHostFromUrl(tab.url || '');
    if (host && /^https?:$/.test(new URL(tab.url).protocol)) currentHost = host;
  }

  const stored = await chrome.storage.local.get(['settings', 'stats']);
  render(aasMergeSettings(stored.settings), aasMergeStats(stored.stats));

  if (currentTabId >= 0) {
    chrome.runtime.sendMessage({ t: 'GET_TAB_COUNT', tabId: currentTabId }, (resp) => {
      if (!chrome.runtime.lastError && resp) $('tabCount').textContent = String(resp.count);
    });
  }

  $('enabled').addEventListener('change', async (e) => {
    const s = await updateSettings((st) => { st.enabled = e.target.checked; });
    document.body.classList.toggle('disabled', !s.enabled);
  });

  $('siteEnabled').addEventListener('change', async (e) => {
    if (!currentHost) return;
    await updateSettings((st) => {
      if (e.target.checked) delete st.siteDisabled[currentHost];
      else st.siteDisabled[currentHost] = true;
    });
  });

  $('fastForward').addEventListener('change', (e) =>
    updateSettings((st) => { st.fastForward = e.target.checked; }));

  $('popunderGuard').addEventListener('change', (e) =>
    updateSettings((st) => { st.clickPopunderGuard = e.target.checked; }));

  $('debug').addEventListener('change', (e) =>
    updateSettings((st) => { st.debug = e.target.checked; }));

  $('muteMode').addEventListener('change', (e) =>
    updateSettings((st) => { st.muteMode = e.target.value; }));
}

init();
