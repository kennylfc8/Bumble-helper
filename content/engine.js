// Per-frame ad engine: detect ads, mute media, click "Skip" when it goes live.
// Runs in the ISOLATED world of every frame (all_frames). patterns.js and
// common.js are loaded before this file in the same world.
'use strict';

(() => {
  const P = globalThis.__AAS_PATTERNS__;
  if (!P || typeof chrome === 'undefined' || !chrome.runtime?.id) return;

  const SCAN_DEBOUNCE_MS = 250;
  const IDLE_INTERVAL_MS = 1000;
  const HOT_INTERVAL_MS = 200;
  const EXIT_GRACE_MS = 1200;      // bridges the gap between chained ads
  const CLICK_VERIFY_MS = 800;
  const CLICK_MIN_GAP_MS = 700;
  const CLICKS_PER_MIN_MAX = 30;
  const BLACKLIST_MS = 10_000;
  const MAX_ATTEMPT_ROUNDS = 3;
  const COUNTDOWN_MEMORY_MS = 30_000;
  const SMALL_DOC_ELEMENTS = 2500;
  const TEXT_SCAN_CAP = 3000;

  const IS_AD_FRAME = P.isAdHost(location.hostname);

  let settings = aasMergeSettings(null);
  let topHost = location.hostname;
  let parked = true;
  let ctxKnown = false;

  let observer = null;
  let scanTimer = 0;
  let idleTimer = 0;
  let hotTimer = 0;

  let adActive = false;
  let lastPositiveTs = 0;
  let countdownSeenTs = 0;

  let port = null;
  const savedMedia = new WeakMap();  // media el -> { muted, volume }
  const clickState = new WeakMap();  // candidate el -> { round, blacklistUntil, pendingVerify }
  let lastClickTs = 0;
  let clickTimestamps = [];

  const dbg = (...a) => {
    if (settings.debug) console.debug('[AAS]', location.hostname, ...a);
  };
  const dbgThrottleTs = new Map();
  const dbgThrottled = (key, ...a) => {
    if (!settings.debug) return;
    const now = Date.now();
    if (now - (dbgThrottleTs.get(key) || 0) < 1000) return;
    dbgThrottleTs.set(key, now);
    console.debug('[AAS]', location.hostname, key, ...a);
  };

  // ---------------------------------------------------------------- context

  function requestCtx(attempt = 0) {
    let sent = false;
    try {
      chrome.runtime.sendMessage({ t: 'GET_CTX' }, (resp) => {
        if (chrome.runtime.lastError || !resp) {
          if (attempt < 3) {
            setTimeout(() => requestCtx(attempt + 1), 400 * (attempt + 1));
          } else {
            applyCtx({ topHost: location.hostname, settings: null });
          }
          return;
        }
        applyCtx(resp);
      });
      sent = true;
    } catch {
      /* extension context invalidated */
    }
    if (!sent && attempt < 3) setTimeout(() => requestCtx(attempt + 1), 400 * (attempt + 1));
  }

  function applyCtx(resp) {
    ctxKnown = true;
    topHost = resp.topHost || location.hostname;
    settings = aasMergeSettings(resp.settings);
    updateParked();
  }

  function shouldBeParked() {
    return !settings.enabled || !!settings.siteDisabled[topHost];
  }

  function updateParked() {
    const want = shouldBeParked();
    if (want === parked && ctxKnown) {
      if (!parked) scheduleScan();
      return;
    }
    parked = want;
    if (parked) {
      if (observer) { observer.disconnect(); observer = null; }
      clearTimeout(scanTimer); scanTimer = 0;
      clearInterval(idleTimer); idleTimer = 0;
      if (adActive) exitAdState();
      dbg('parked');
    } else {
      ensureObserver();
      scheduleScan();
      dbg('unparked');
    }
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.settings) return;
    settings = aasMergeSettings(changes.settings.newValue);
    updateParked();
  });

  // ------------------------------------------------------------- observers

  function ensureObserver() {
    if (observer) return;
    const root = document.documentElement;
    if (!root) {
      document.addEventListener('readystatechange', ensureObserver, { once: true });
      return;
    }
    observer = new MutationObserver(() => scheduleScan());
    observer.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'style', 'disabled', 'aria-disabled', 'hidden'],
    });
  }

  function scheduleScan() {
    if (parked || scanTimer) return;
    scanTimer = setTimeout(() => {
      scanTimer = 0;
      scan();
    }, SCAN_DEBOUNCE_MS);
  }

  function startHotLoop() {
    if (hotTimer) return;
    hotTimer = setInterval(scan, HOT_INTERVAL_MS);
  }

  function stopHotLoop() {
    clearInterval(hotTimer);
    hotTimer = 0;
  }

  function syncIdleLoop(needed) {
    if (needed && !idleTimer) idleTimer = setInterval(scheduleScan, IDLE_INTERVAL_MS);
    if (!needed && idleTimer) { clearInterval(idleTimer); idleTimer = 0; }
  }

  // ------------------------------------------------------------ collectors

  function docSize() {
    return document.getElementsByTagName('*').length;
  }

  function deepAllowed() {
    return adActive || IS_AD_FRAME || docSize() <= SMALL_DOC_ELEMENTS;
  }

  function collectMedia() {
    if (deepAllowed()) return P.deepQueryAll(document, 'video, audio');
    return Array.from(document.querySelectorAll('video, audio'));
  }

  function isShown(el) {
    if (!el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return false;
    const cs = getComputedStyle(el);
    return cs.display !== 'none' && cs.visibility === 'visible' && parseFloat(cs.opacity) >= 0.05;
  }

  function collectContainers() {
    const sels = [...P.AD_CONTAINER_SELECTORS];
    if (IS_AD_FRAME) sels.push(...P.AD_CONTAINER_SELECTORS_IN_AD_FRAME);
    const adapter = P.ADAPTERS[topHost];
    if (adapter?.adSelectors) sels.push(...adapter.adSelectors);
    const out = [];
    for (const sel of sels) {
      for (const el of P.deepQueryAll(document, sel)) {
        if (isShown(el) && !out.includes(el)) out.push(el);
      }
    }
    return out;
  }

  // Scopes for the text scan: whole doc when it is small or a known ad frame,
  // otherwise only ad containers and the ancestor chains of media elements —
  // player chrome lives there, and it keeps big pages cheap.
  function textScanScopes(containers, mediaEls) {
    if (IS_AD_FRAME || docSize() <= SMALL_DOC_ELEMENTS) return [document];
    const scopes = [...containers];
    for (const m of mediaEls) {
      let el = m;
      for (let i = 0; i < 4 && el; i++) {
        const parent = el.parentElement || el.getRootNode()?.host || null;
        if (!parent) break;
        el = parent;
      }
      if (el && !scopes.includes(el)) scopes.push(el);
    }
    return scopes;
  }

  // priority: 0 adapter, 1 tier-B selector, 2 strong text, 3 weak text
  function collectSkipCandidates(containers, mediaEls) {
    const seen = new Set();
    const candidates = [];
    let badgeFound = false;
    let countdownNow = false;

    const push = (el, priority) => {
      if (!el || seen.has(el)) return;
      seen.add(el);
      candidates.push({ el, priority });
    };

    const adapter = P.ADAPTERS[topHost];
    if (adapter?.skipSelectors) {
      for (const sel of adapter.skipSelectors) {
        for (const el of P.deepQueryAll(document, sel)) push(el, 0);
      }
    }
    for (const sel of P.SKIP_SELECTORS) {
      for (const el of P.deepQueryAll(document, sel)) push(el, 1);
    }

    let budget = TEXT_SCAN_CAP;
    for (const scope of textScanScopes(containers, mediaEls)) {
      if (budget <= 0) break;
      const els = P.deepQueryAll(scope, 'button, a, [role="button"], div, span');
      for (const el of els) {
        if (--budget <= 0) break;
        if (el.childElementCount > 2) continue;
        const text = P.normText(el);
        if (!text || text.length > 60) continue;
        if (text.length <= 25 && P.AD_BADGE_RE.test(text)) badgeFound = true;
        const hasSkipWord = /пропустить|пропустити|skip|закрыть|закрити|close/i.test(text);
        if (!hasSkipWord) continue;
        if (P.SKIP_NEGATIVE_RE.test(text)) continue;
        const hasCountdown = P.COUNTDOWN_RE.test(text);
        if (hasCountdown) countdownNow = true;
        if (P.SKIP_STRONG_RE.test(text) || hasCountdown) push(el, 2);
        else if (P.SKIP_WEAK_RE.test(text)) push(el, 3);
      }
    }

    if (countdownNow) countdownSeenTs = Date.now();
    candidates.sort((a, b) => a.priority - b.priority);
    return { candidates, badgeFound };
  }

  // ------------------------------------------------------------------ scan

  function scan() {
    if (parked) return;
    const now = Date.now();

    const mediaEls = collectMedia();
    const containers = collectContainers();
    const { candidates, badgeFound } = collectSkipCandidates(containers, mediaEls);

    const mediaPresent = mediaEls.length > 0;
    const s1 = IS_AD_FRAME;
    const s2 = containers.length > 0;
    const strong = candidates.filter((c) => c.priority <= 2);
    const weak = candidates.filter((c) => c.priority === 3);
    const s3strong = strong.length > 0;
    const s3weak = weak.length > 0;
    const s4 = badgeFound;
    const countdownRecent = now - countdownSeenTs < COUNTDOWN_MEMORY_MS;

    // A bare "Skip" near a video is not enough on its own (Netflix-style
    // "skip intro" pages, tutorials): the weak form additionally needs an
    // ad badge or a countdown seen recently.
    const adRaw =
      (s1 && (mediaPresent || s2 || s3strong || s3weak)) ||
      s2 ||
      (s3strong && (mediaPresent || s4)) ||
      (s3weak && mediaPresent && (s4 || countdownRecent));

    if (adRaw) {
      lastPositiveTs = now;
      if (!adActive) enterAdState();
    } else if (adActive && now - lastPositiveTs > EXIT_GRACE_MS) {
      exitAdState();
    }

    if (adActive) {
      muteMedia(mediaEls);
      if (settings.fastForward) fastForward(mediaEls, containers);
      huntSkip(candidates);
    }

    syncIdleLoop(mediaPresent || IS_AD_FRAME);
  }

  // ------------------------------------------------------------- ad state

  function enterAdState() {
    adActive = true;
    dbg('ad detected');
    startHotLoop();
    connectPort();
    postAdState(true);
  }

  function exitAdState() {
    adActive = false;
    dbg('ad over');
    stopHotLoop();
    restoreMedia();
    postAdState(false);
    disconnectPort();
  }

  function muteMedia(mediaEls) {
    if (settings.muteMode === 'off') return;
    for (const el of mediaEls) {
      if (!savedMedia.has(el)) savedMedia.set(el, { muted: el.muted, volume: el.volume });
      if (!el.muted) el.muted = true;
    }
  }

  function restoreMedia() {
    if (settings.muteMode === 'off') return;
    for (const el of collectMedia()) {
      const saved = savedMedia.get(el);
      if (!saved) continue;
      el.muted = saved.muted;
      try { el.volume = saved.volume; } catch { /* ignore */ }
      savedMedia.delete(el);
    }
  }

  function fastForward(mediaEls, containers) {
    for (const el of mediaEls) {
      if (el.tagName !== 'VIDEO') continue;
      const isAdVideo = IS_AD_FRAME || containers.some((c) => c.contains(el));
      if (!isAdVideo) continue;
      try {
        if (isFinite(el.duration) && el.duration > 1 && el.currentTime < el.duration - 0.5) {
          el.currentTime = el.duration - 0.3;
        }
        el.playbackRate = 16;
      } catch { /* some players throw on seek */ }
    }
  }

  // ------------------------------------------------------------------ skip

  // Returns null when the element is genuinely clickable, otherwise a short
  // reason string (also used for debug diagnostics on stubborn sites).
  function clickabilityIssue(el) {
    if (!el.isConnected) return 'detached';
    if (el.matches(':disabled') || el.disabled) return 'disabled';
    if (el.getAttribute('aria-disabled') === 'true') return 'aria-disabled';
    if (el.closest('[aria-hidden="true"]')) return 'aria-hidden';
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return 'no-box';
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility !== 'visible') return 'hidden';
    if (parseFloat(cs.opacity) < 0.05) return 'transparent';
    if (cs.pointerEvents === 'none') return 'pointer-events'; // inherits — covers ancestors
    if (P.COUNTDOWN_RE.test(P.normText(el))) return 'countdown'; // still ticking
    const root = el.getRootNode();
    const from = typeof root.elementFromPoint === 'function' ? root : document;
    const top = from.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    if (!top) return 'off-viewport';
    if (!(el === top || el.contains(top) || top.contains(el))) return 'overlaid';
    return null;
  }

  function isClickable(el) {
    return clickabilityIssue(el) === null;
  }

  function realClick(el, target) {
    const t = target || el;
    const r = t.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    const base = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      clientX: x,
      clientY: y,
      button: 0,
    };
    const seq = [
      ['pointerover', PointerEvent],
      ['pointerenter', PointerEvent],
      ['mouseover', MouseEvent],
      ['mousemove', MouseEvent],
      ['pointerdown', PointerEvent],
      ['mousedown', MouseEvent],
      ['pointerup', PointerEvent],
      ['mouseup', MouseEvent],
      ['click', MouseEvent],
    ];
    try { t.focus?.(); } catch { /* ignore */ }
    for (const [type, Ctor] of seq) {
      const init = {
        ...base,
        buttons: /down/.test(type) ? 1 : 0,
        ...(Ctor === PointerEvent ? { pointerId: 1, pointerType: 'mouse', isPrimary: true } : {}),
      };
      t.dispatchEvent(new Ctor(type, init));
    }
  }

  function armPopunderGuard() {
    if (!settings.clickPopunderGuard) return;
    // dispatchEvent is synchronous across worlds (postMessage is not), so the
    // guard is armed before the very next synthetic click lands.
    try { window.dispatchEvent(new Event('__aas_guard')); } catch { /* ignore */ }
  }

  function huntSkip(candidates) {
    const now = Date.now();
    if (!candidates.length) {
      dbgThrottled('no skip candidates');
      return;
    }
    if (now - lastClickTs < CLICK_MIN_GAP_MS) return;
    clickTimestamps = clickTimestamps.filter((t) => now - t < 60_000);
    if (clickTimestamps.length >= CLICKS_PER_MIN_MAX) return;

    for (const { el } of candidates) {
      const st = clickState.get(el) || { round: 0, blacklistUntil: 0, pendingVerify: false };
      if (st.pendingVerify || st.blacklistUntil > now) continue;
      const issue = clickabilityIssue(el);
      if (issue) {
        dbgThrottled(`candidate not clickable (${issue})`, el);
        continue;
      }

      lastClickTs = now;
      clickTimestamps.push(now);
      armPopunderGuard();

      if (st.round === 0) {
        realClick(el);
      } else if (st.round === 1) {
        try { el.click(); } catch { /* ignore */ }
      } else {
        const r = el.getBoundingClientRect();
        const root = el.getRootNode();
        const from = typeof root.elementFromPoint === 'function' ? root : document;
        const retarget = from.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) || el.parentElement;
        if (retarget) realClick(el, retarget);
      }
      dbg('clicked skip, round', st.round, el);

      st.pendingVerify = true;
      clickState.set(el, st);
      setTimeout(() => verifyClick(el), CLICK_VERIFY_MS);
      return; // one candidate per tick
    }
  }

  function verifyClick(el) {
    const st = clickState.get(el);
    if (!st) return;
    st.pendingVerify = false;
    const gone = !el.isConnected || !isShown(el) || !adActive;
    if (gone) {
      clickState.delete(el);
      reportSkipped();
      dbg('skip confirmed');
      return;
    }
    st.round += 1;
    if (st.round >= MAX_ATTEMPT_ROUNDS) {
      st.round = 0;
      st.blacklistUntil = Date.now() + BLACKLIST_MS;
      dbg('candidate blacklisted', el);
    }
    clickState.set(el, st);
  }

  // ---------------------------------------------------------- SW messaging

  function connectPort() {
    if (port) return;
    try {
      port = chrome.runtime.connect({ name: 'aas-ad' });
      port.onDisconnect.addListener(() => {
        port = null;
        // SW may have restarted mid-ad — reconnect so the tab mute survives.
        if (adActive) {
          setTimeout(() => {
            if (adActive && !port) {
              connectPort();
              postAdState(true);
            }
          }, 300);
        }
      });
    } catch {
      port = null;
    }
  }

  function disconnectPort() {
    if (!port) return;
    try { port.disconnect(); } catch { /* ignore */ }
    port = null;
  }

  function postAdState(active) {
    if (!port) return;
    try {
      port.postMessage({
        t: 'AD_STATE',
        active,
        tabMute: settings.muteMode === 'tab+video',
      });
    } catch {
      port = null;
    }
  }

  function reportSkipped() {
    const msg = { t: 'SKIPPED', host: topHost };
    try {
      if (port) port.postMessage(msg);
      else chrome.runtime.sendMessage(msg, () => void chrome.runtime.lastError);
    } catch { /* ignore */ }
  }

  // ------------------------------------------------------------------ init

  window.addEventListener('pageshow', () => {
    if (!parked) {
      ensureObserver();
      scheduleScan();
    }
  });

  requestCtx();
})();
