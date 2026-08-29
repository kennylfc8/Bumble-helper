// Heuristic data for ad detection, tiered by confidence. Data only — no behavior.
// Loaded before engine.js in the same isolated world.
'use strict';

globalThis.__AAS_PATTERNS__ = (() => {
  // ---- Tier A: frame origins that are presumed to host ad creatives -------
  // Matched as a suffix of the frame's own location.hostname.
  const AD_FRAME_HOSTS = [
    'doubleclick.net',
    'googlesyndication.com',
    'imasdk.googleapis.com',
    '2mdn.net',
    'googleadservices.com',
    'an.yandex.ru',
    'yandexadexchange.net',
    'adfox.ru',
    'ad.mail.ru',
    'rs.mail.ru',
    'betweendigital.com',
    'buzzoola.com',
    'videoroll.net',
    'adtelligent.com',
    'seedr.ru',
    'videonow.ru',
    'exelator.com',
    'adriver.ru',
    'utraff.com',
  ];

  // ---- Tier B: selectors of documented ad tech ----------------------------
  // Containers: presence of a *visible* match means an ad UI is on screen.
  const AD_CONTAINER_SELECTORS = [
    // Google IMA / VAST
    '.videoAdUi',
    '.videoAdUiSkipContainer',
    '[id^="google_ads_iframe"]',
    '.ima-ad-container',
    // video.js + videojs-ima
    '.vjs-ad-playing',
    '.vjs-ima-ad-container',
    // JW Player
    '.jw-ad',
    '.jw-ad-visible',
    // generic VAST-style UIs
    '[class*="vast-skip"]',
    '[class*="videoad" i]',
  ];

  // Skip buttons of documented ad tech — clicked without text analysis.
  const SKIP_SELECTORS = [
    '.videoAdUiSkipButton',
    '.videoAdUiSkipButtonExperimentalText',
    '.jw-skip',
    '.jw-skiptext',
    '[class*="vast-skip-button"]',
    '[class*="skip-button" i]',
    '[class*="skip_button" i]',
  ];

  // Too generic to trust anywhere — only meaningful inside Tier-A frames.
  const AD_CONTAINER_SELECTORS_IN_AD_FRAME = [
    '[class*="adv_"]',
    '[class^="ad-"]',
    '[class*=" ad-"]',
  ];

  // ---- Tier C: text / aria-label patterns ---------------------------------
  // Applied to normalized text: trimmed, whitespace collapsed, lowercased, <= 60 chars.
  // NB: JS \b only knows [A-Za-z0-9_], so it silently breaks next to Cyrillic —
  // word edges are expressed as explicit lookarounds instead.
  const W = '[0-9a-zа-яёіїєґ]'; // letters of ru/uk + latin + digits ('i' flag covers case)
  // Strong: explicitly mentions ad — safe to act on near media.
  const SKIP_STRONG_RE = new RegExp(
    `^(?:пропустить|пропустити|skip)\\s+(?:рекламу|ad|ads|this\\s+ad|advert)(?!${W})` +
      `|^(?:close|закрыть|закрити)\\s+(?:ad|рекламу)(?!${W})`,
    'i',
  );
  // Weak: a bare skip word — needs extra corroboration (countdown or ad badge).
  const SKIP_WEAK_RE = /^(?:пропустить|пропустити|skip)\s*(?:»|›|>|→|⇥|>>)*$/i;
  // Never click these — they skip content, not ads.
  const SKIP_NEGATIVE_RE =
    /заставк|интро|опенинг|эндинг|титр|трейлер|продолжени|серию|intro|recap|opening|ending|credits|episode|next/i;
  // A candidate exists but the countdown is still ticking.
  const COUNTDOWN_RE = new RegExp(
    `(?:через|in|за|through)\\s*\\d+|(?<!${W})\\d+\\s*(?:сек|с|c|sec|s)(?!${W})`,
    'i',
  );
  // Corroboration only, never a trigger by itself.
  const AD_BADGE_RE = new RegExp(
    `^(?:реклама|advertisement|advert|ad|sponsored|спонсор)(?!${W})`,
    'i',
  );

  // ---- Optional per-site adapters (keyed by TOP-page hostname) ------------
  // Escape hatch for resistant sites; merged into Tier B at engine init.
  // Shape: { "example.org": { skipSelectors: [...], adSelectors: [...] } }
  const ADAPTERS = {};

  // ---- Helpers ------------------------------------------------------------

  function normText(el) {
    const own = (el.textContent || '') + ' ' + (el.getAttribute?.('aria-label') || '');
    return own.replace(/\s+/g, ' ').trim().toLowerCase();
  }

  function isAdHost(hostname) {
    if (!hostname) return false;
    return AD_FRAME_HOSTS.some(
      (h) => hostname === h || hostname.endsWith('.' + h),
    );
  }

  // querySelectorAll across open shadow roots. maxHosts caps the traversal so
  // a scan can never blow up on a pathological page.
  function deepQueryAll(root, selector, maxHosts = 300) {
    const out = [];
    const stack = [root];
    let hosts = 0;
    while (stack.length) {
      const r = stack.pop();
      let found;
      try {
        found = r.querySelectorAll(selector);
      } catch {
        return out; // bad selector — fail closed
      }
      for (const el of found) out.push(el);
      if (hosts >= maxHosts) continue;
      const all = r.querySelectorAll('*');
      for (const el of all) {
        if (el.shadowRoot) {
          stack.push(el.shadowRoot);
          if (++hosts >= maxHosts) break;
        }
      }
    }
    return out;
  }

  return {
    AD_FRAME_HOSTS,
    AD_CONTAINER_SELECTORS,
    AD_CONTAINER_SELECTORS_IN_AD_FRAME,
    SKIP_SELECTORS,
    SKIP_STRONG_RE,
    SKIP_WEAK_RE,
    SKIP_NEGATIVE_RE,
    COUNTDOWN_RE,
    AD_BADGE_RE,
    ADAPTERS,
    normText,
    isAdHost,
    deepQueryAll,
  };
})();
