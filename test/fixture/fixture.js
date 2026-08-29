// Ad-frame simulator: two chained "ads" (IMA-style, then text/countdown-style),
// a popunder trap on the first click, and reporting of everything the e2e
// runner asserts, mirrored to the parent page via postMessage.
'use strict';

const D = document.documentElement.dataset;
const v = document.getElementById('v');
const adui = document.getElementById('adui');
const player = document.getElementById('player');

const state = { popunders: 0 };

function report() {
  const snapshot = {};
  for (const k of Object.keys(D)) snapshot[k] = D[k];
  try { parent.postMessage({ __aasFixture: snapshot }, '*'); } catch { /* no parent */ }
}
setInterval(report, 400);

// ------------------------------------------------------------------- video

const canvas = document.createElement('canvas');
canvas.width = 640;
canvas.height = 360;
const ctx = canvas.getContext('2d');
let phaseLabel = 'загрузка';
(function draw() {
  ctx.fillStyle = '#310';
  ctx.fillRect(0, 0, 640, 360);
  ctx.fillStyle = '#fa4';
  ctx.font = '28px sans-serif';
  ctx.fillText(phaseLabel + ' ' + (Date.now() % 100000), 40, 180);
  requestAnimationFrame(draw);
})();
const stream = canvas.captureStream(15);
try {
  // Audible oscillator so a human running the fixture hears whether muting
  // works; harmless if AudioContext is unavailable.
  const ac = new AudioContext();
  const osc = ac.createOscillator();
  osc.frequency.value = 220;
  const dest = ac.createMediaStreamDestination();
  osc.connect(dest);
  osc.start();
  for (const track of dest.stream.getAudioTracks()) stream.addTrack(track);
} catch { /* no audio device */ }
v.srcObject = stream;
v.muted = false;
v.play().catch(() => {});

// -------------------------------------------------------------- popunder trap

document.addEventListener('click', () => {
  let w = null;
  try { w = window.open('about:blank', '_blank'); } catch { /* ignore */ }
  if (w) {
    if (w.closed) {
      D.guardWorked = '1'; // our MAIN-world guard returned the dummy
    } else {
      state.popunders += 1;
      try { w.close(); } catch { /* ignore */ }
    }
  }
  D.popunders = String(state.popunders);
  report();
}, { capture: true, once: true });
D.popunders = '0';

// ---------------------------------------------------------------- ad 1 (IMA)

function startAd1() {
  phaseLabel = 'реклама 1';
  const adStart = Date.now();
  adui.hidden = false;

  const mutePoll = setInterval(() => {
    if (v.muted && !D.mutedWithinMs) {
      D.mutedWithinMs = String(Date.now() - adStart);
      report();
    }
  }, 50);

  setTimeout(() => {
    const btn = document.createElement('button');
    btn.className = 'videoAdUiSkipButton';
    btn.textContent = 'Пропустить рекламу';
    btn.addEventListener('click', () => {
      clearInterval(mutePoll);
      D.ad1Skipped = '1';
      D.ad1SkippedMs = String(Date.now() - adStart);
      report();
      setTimeout(() => {
        btn.remove();
        adui.hidden = true;
        setTimeout(startAd2, 700); // chained second ad
      }, 100);
    });
    adui.appendChild(btn);
  }, 3000);
}

// ------------------------------------------------------- ad 2 (text/countdown)

function startAd2() {
  phaseLabel = 'реклама 2';
  D.ad2Started = '1';
  adui.hidden = false;

  const skip2 = document.createElement('div');
  skip2.id = 'skip2';
  skip2.className = 'waiting';
  let left = 3;
  skip2.textContent = `Пропустить рекламу (через ${left} сек)`;
  adui.appendChild(skip2);

  const tick = setInterval(() => {
    left -= 1;
    if (left > 0) {
      skip2.textContent = `Пропустить рекламу (через ${left} сек)`;
    } else {
      clearInterval(tick);
      skip2.className = '';
      skip2.textContent = 'Пропустить рекламу';
    }
  }, 1000);

  skip2.addEventListener('click', () => {
    if (left > 0) {
      // Clicked while the countdown was still ticking — a real player would
      // ignore this; record it so the e2e can flag premature clicks.
      D.prematureClicks = String(1 + Number(D.prematureClicks || 0));
      report();
      return;
    }
    D.ad2Skipped = '1';
    report();
    skip2.remove();
    adui.hidden = true;
    setTimeout(startContent, 200);
  });
}

// ----------------------------------------------------------------- content

function startContent() {
  phaseLabel = 'КОНТЕНТ';
  const contentStart = Date.now();
  const poll = setInterval(() => {
    if (!v.muted) {
      D.restored = '1';
      D.restoredMs = String(Date.now() - contentStart);
      clearInterval(poll);
      report();
    }
  }, 100);
}

setTimeout(startAd1, 300);
