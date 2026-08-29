// MAIN-world guard: while armed, the page's window.open() is a no-op dummy.
// The engine (isolated world) arms it right before a synthetic skip-click so
// click-hijacking popunders die silently. The page itself could forge the
// arming message, but all that achieves is blocking its own popunders.
'use strict';

(() => {
  if (window.__aasGuardInstalled) return;
  window.__aasGuardInstalled = true;

  let armedUntil = 0;
  const ARM_MS = 1800;

  // A plain Event (no detail) crosses the isolated/MAIN world boundary
  // synchronously — the engine arms the guard right before a synthetic click.
  window.addEventListener('__aas_guard', () => {
    armedUntil = Date.now() + ARM_MS;
  });

  const realOpen = window.open.bind(window);
  const dummyWindow = () => ({
    closed: true,
    close() {},
    focus() {},
    blur() {},
    postMessage() {},
    location: { href: 'about:blank' },
  });

  try {
    Object.defineProperty(window, 'open', {
      configurable: true,
      writable: true,
      value: function open(...args) {
        if (Date.now() < armedUntil) return dummyWindow();
        return realOpen(...args);
      },
    });
  } catch {
    /* page froze window.open — nothing we can do */
  }
})();
