// MV3 service worker: tab-level mute while any frame reports an active ad,
// skipped-ads stats + badge, GET_CTX responder for frames.
'use strict';

importScripts('common.js');

const UNMUTE_DEBOUNCE_MS = 1500; // bridges the silent gap between chained ads
const ORPHAN_SWEEP_DELAY_MS = 4000;

// tabId -> { frames: Map<portKey, {tabMute:boolean}>, unmuteTimer, weMuted, userMuted, skipped }
const tabs = new Map();
let statsQueue = Promise.resolve();

function tabState(tabId) {
  let st = tabs.get(tabId);
  if (!st) {
    st = { frames: new Map(), unmuteTimer: 0, weMuted: false, userMuted: false, skipped: 0 };
    tabs.set(tabId, st);
  }
  return st;
}

async function getSettings() {
  const stored = await chrome.storage.local.get('settings');
  return aasMergeSettings(stored.settings);
}

// ------------------------------------------------------------- persistence
// Mirror the "we muted these tabs" fact so an SW restart never strands a tab
// in the muted state.

function persistMuted() {
  const muted = [...tabs.entries()].filter(([, st]) => st.weMuted).map(([id]) => id);
  chrome.storage.session.set({ mutedTabs: muted }).catch(() => {});
}

async function sweepOrphanedMutes() {
  const { mutedTabs = [] } = await chrome.storage.session.get('mutedTabs').catch(() => ({}));
  for (const tabId of mutedTabs) {
    const st = tabs.get(tabId);
    if (st && st.frames.size > 0) continue; // ports reconnected — still legit
    await unmuteIfOurs(tabId);
    if (st) st.weMuted = false;
  }
  persistMuted();
}

setTimeout(() => { sweepOrphanedMutes().catch(() => {}); }, ORPHAN_SWEEP_DELAY_MS);

// ------------------------------------------------------------------- mute

async function muteTab(tabId) {
  const st = tabState(tabId);
  if (st.unmuteTimer) {
    clearTimeout(st.unmuteTimer);
    st.unmuteTimer = 0;
  }
  if (st.weMuted || st.userMuted) return;
  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return;
  }
  if (tab.mutedInfo?.muted) {
    // Someone else (likely the user) muted this tab — never touch it.
    st.userMuted = true;
    return;
  }
  try {
    await chrome.tabs.update(tabId, { muted: true });
    st.weMuted = true;
    persistMuted();
  } catch { /* tab gone */ }
}

async function unmuteIfOurs(tabId) {
  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return;
  }
  const info = tab.mutedInfo;
  if (info?.muted && info.reason === 'extension' && info.extensionId === chrome.runtime.id) {
    try { await chrome.tabs.update(tabId, { muted: false }); } catch { /* ignore */ }
  }
}

function scheduleUnmute(tabId) {
  const st = tabs.get(tabId);
  if (!st || st.unmuteTimer) return;
  st.unmuteTimer = setTimeout(async () => {
    st.unmuteTimer = 0;
    const wantMute = [...st.frames.values()].some((f) => f.tabMute);
    if (wantMute) return; // an ad came back during the debounce
    if (st.weMuted) {
      st.weMuted = false;
      persistMuted();
      await unmuteIfOurs(tabId);
    }
    st.userMuted = false;
  }, UNMUTE_DEBOUNCE_MS);
}

function onFrameAdState(tabId, portKey, active, tabMute) {
  const st = tabState(tabId);
  if (active) {
    st.frames.set(portKey, { tabMute });
    if (tabMute) muteTab(tabId);
  } else {
    st.frames.delete(portKey);
  }
  const anyMute = [...st.frames.values()].some((f) => f.tabMute);
  if (!anyMute) scheduleUnmute(tabId);
}

// ------------------------------------------------------------------ stats

function recordSkip(tabId, host) {
  if (tabId >= 0) {
    const st = tabState(tabId);
    st.skipped += 1;
    chrome.action.setBadgeText({ tabId, text: String(st.skipped) }).catch(() => {});
  }
  statsQueue = statsQueue.then(async () => {
    const stored = await chrome.storage.local.get('stats');
    const stats = aasMergeStats(stored.stats);
    stats.totalSkipped += 1;
    if (host) stats.perHost[host] = (stats.perHost[host] || 0) + 1;
    await chrome.storage.local.set({ stats });
  }).catch(() => {});
}

chrome.action.setBadgeBackgroundColor({ color: '#16a34a' }).catch(() => {});

// -------------------------------------------------------------- messaging

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.t === 'GET_CTX') {
    (async () => {
      const settings = await getSettings();
      const topHost = sender.tab ? aasHostFromUrl(sender.tab.url || '') : '';
      sendResponse({ topHost, settings });
    })();
    return true;
  }
  if (msg?.t === 'SKIPPED') {
    recordSkip(sender.tab ? sender.tab.id : -1, msg.host);
    return false;
  }
  if (msg?.t === 'GET_TAB_COUNT') {
    const st = tabs.get(msg.tabId);
    sendResponse({ count: st ? st.skipped : 0 });
    return false;
  }
  return false;
});

chrome.runtime.onConnect.addListener((p) => {
  if (p.name !== 'aas-ad' || !p.sender?.tab) return;
  const tabId = p.sender.tab.id;
  const portKey = `${tabId}:${p.sender.frameId}:${Math.random().toString(36).slice(2)}`;
  p.onMessage.addListener((msg) => {
    if (msg?.t === 'AD_STATE') onFrameAdState(tabId, portKey, msg.active, !!msg.tabMute);
    else if (msg?.t === 'SKIPPED') recordSkip(tabId, msg.host);
  });
  p.onDisconnect.addListener(() => {
    const st = tabs.get(tabId);
    if (!st) return;
    st.frames.delete(portKey);
    if (![...st.frames.values()].some((f) => f.tabMute)) scheduleUnmute(tabId);
  });
});

// -------------------------------------------------------------- tab hooks

chrome.tabs.onRemoved.addListener((tabId) => {
  const st = tabs.get(tabId);
  if (st?.unmuteTimer) clearTimeout(st.unmuteTimer);
  tabs.delete(tabId);
  persistMuted();
});

chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.status !== 'loading') return;
  const st = tabs.get(tabId);
  if (!st) return;
  st.frames.clear();
  st.skipped = 0;
  if (st.unmuteTimer) { clearTimeout(st.unmuteTimer); st.unmuteTimer = 0; }
  if (st.weMuted) {
    st.weMuted = false;
    persistMuted();
    unmuteIfOurs(tabId);
  }
  st.userMuted = false;
});
