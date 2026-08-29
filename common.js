// Shared between the service worker (importScripts), the popup (script tag)
// and content scripts (first entry in the content_scripts js list).
'use strict';

// Settings and stats live under separate storage.local keys ('settings',
// 'stats') so the popup and the service worker never clobber each other.
const AAS_DEFAULTS = Object.freeze({
  enabled: true,
  siteDisabled: {},          // { "example.org": true } — keyed by TOP-page hostname
  muteMode: 'tab+video',     // 'tab+video' | 'video' | 'off'
  clickPopunderGuard: true,
  fastForward: false,        // experimental, OFF by default
  debug: false,
});

function aasMergeSettings(stored) {
  const s = stored && typeof stored === 'object' ? stored : {};
  return {
    ...AAS_DEFAULTS,
    ...s,
    siteDisabled: { ...(s.siteDisabled || {}) },
  };
}

function aasMergeStats(stored) {
  const s = stored && typeof stored === 'object' ? stored : {};
  return {
    totalSkipped: s.totalSkipped || 0,
    perHost: { ...(s.perHost || {}) },
  };
}

function aasHostFromUrl(url) {
  try {
    return new URL(url).hostname || '';
  } catch {
    return '';
  }
}

// globalThis works in all three contexts; content scripts get their own copy per frame.
globalThis.AAS_DEFAULTS = AAS_DEFAULTS;
globalThis.aasMergeSettings = aasMergeSettings;
globalThis.aasMergeStats = aasMergeStats;
globalThis.aasHostFromUrl = aasHostFromUrl;
