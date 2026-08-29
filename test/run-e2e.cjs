#!/usr/bin/env node
// End-to-end check: loads the unpacked extension into the preinstalled
// Chromium and runs it against the ad fixture. No npm install needed:
//   NODE_PATH=/opt/node22/lib/node_modules node test/run-e2e.cjs
// Flags/env:
//   --serve-only        just start the fixture server and print the URL
//   AAS_HEADFUL=1       run headed (use under `xvfb-run -a` in containers)
//   AAS_VERBOSE=1       relay page console output
//   AAS_DEBUG=1         turn on the extension's debug logging before the run
'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const FIXTURE = path.join(__dirname, 'fixture');
const PROFILE = path.join(__dirname, '.profile');
const CHROMIUM = process.env.AAS_CHROMIUM || '/opt/pw-browsers/chromium';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

function loadPlaywright() {
  const candidates = ['playwright', '/opt/node22/lib/node_modules/playwright'];
  for (const c of candidates) {
    try { return require(c); } catch { /* keep looking */ }
  }
  console.error('playwright не найден. Запусти так:');
  console.error('  NODE_PATH=/opt/node22/lib/node_modules node test/run-e2e.cjs');
  process.exit(2);
}

function startServer() {
  const server = http.createServer((req, res) => {
    const name = path.normalize(decodeURIComponent(req.url.split('?')[0])).replace(/^([/\\])+/, '');
    const file = path.join(FIXTURE, name || 'player.html');
    if (!file.startsWith(FIXTURE) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(fs.readFileSync(file));
  });
  return new Promise((resolve) => {
    server.listen(0, () => resolve(server));
  });
}

async function main() {
  const server = await startServer();
  const port = server.address().port;
  const url = `http://localhost:${port}/player.html`;

  if (process.argv.includes('--serve-only')) {
    console.log(`Фикстура: ${url}`);
    console.log('Ctrl+C для остановки.');
    return; // keep the server alive
  }

  const { chromium } = loadPlaywright();
  fs.rmSync(PROFILE, { recursive: true, force: true });

  const failures = [];
  const check = (cond, msg) => { if (!cond) failures.push(msg); };
  let context;

  try {
    context = await chromium.launchPersistentContext(PROFILE, {
      headless: !process.env.AAS_HEADFUL,
      executablePath: CHROMIUM,
      viewport: { width: 1280, height: 900 },
      args: [
        `--disable-extensions-except=${ROOT}`,
        `--load-extension=${ROOT}`,
        '--autoplay-policy=no-user-gesture-required',
        '--no-sandbox',
        '--disable-dev-shm-usage',
      ],
    });

    let [sw] = context.serviceWorkers();
    if (!sw) {
      sw = await context.waitForEvent('serviceworker', { timeout: 15000 }).catch(() => null);
    }
    if (!sw) {
      throw new Error(
        'Service worker расширения не зарегистрировался — расширение не загрузилось. ' +
        'Попробуй: AAS_HEADFUL=1 xvfb-run -a node test/run-e2e.cjs',
      );
    }
    console.log('Расширение загружено:', sw.url().split('/')[2]);

    if (process.env.AAS_DEBUG) {
      await sw.evaluate(() => chrome.storage.local.set({ settings: { debug: true } }));
    }

    const page = context.pages()[0] || (await context.newPage());
    page.on('console', (m) => {
      if (process.env.AAS_VERBOSE) console.log(`[page:${m.type()}]`, m.text());
    });
    await page.goto(url);

    const waitFlag = async (name, timeout) => {
      await page
        .waitForFunction((n) => document.documentElement.dataset[n] === '1', name, { timeout })
        .catch(() => {});
    };

    await waitFlag('ad1Skipped', 15000);
    await waitFlag('ad2Skipped', 15000);
    await waitFlag('restored', 15000);
    await page.waitForTimeout(1500); // let decoys/late clicks surface

    const d = await page.evaluate(() => ({ ...document.documentElement.dataset }));
    console.log('Результаты фикстуры:', JSON.stringify(d, null, 2));

    check(d.ad1Skipped === '1', 'реклама 1 (IMA-стиль) не пропущена');
    check(d.ad2Skipped === '1', 'реклама 2 (текст + countdown) не пропущена');
    check(!!d.mutedWithinMs, 'видео рекламы вообще не было замучено');
    check(Number(d.mutedWithinMs || 1e9) <= 800, `мут слишком медленный: ${d.mutedWithinMs}мс > 800мс`);
    check(Number(d.ad1SkippedMs || 1e9) <= 6000, `скип рекламы 1 дольше 6с: ${d.ad1SkippedMs}мс`);
    check(d.restored === '1', 'звук/мут видео не восстановлен после рекламы');
    check((d.prematureClicks || '0') === '0', `клики до окончания countdown: ${d.prematureClicks}`);
    check(d.popunders === '0', `попандеры открылись: ${d.popunders}`);
    check(d.guardWorked === '1', 'заслонка window.open не сработала (guardWorked != 1)');
    check(d.decoyClicks === '0', `расширение кликнуло по декоям: ${d.decoyClicks}`);
    check(d.topMuted === '0', 'контентное видео верхней страницы было замучено');

    // Popup smoke test: renders without JS errors, default state on, and the
    // total counter reflects the two ads skipped in this very run.
    const extId = sw.url().split('/')[2];
    const popup = await context.newPage();
    const popupErrors = [];
    popup.on('pageerror', (e) => popupErrors.push(String(e)));
    await popup.goto(`chrome-extension://${extId}/popup/popup.html`);
    await popup.waitForTimeout(600);
    check(
      await popup.evaluate(() => document.getElementById('enabled')?.checked === true),
      'попап: мастер-тумблер не включён по умолчанию',
    );
    check(
      await popup.evaluate(() => document.getElementById('totalCount')?.textContent === '2'),
      'попап: счётчик «всего пропущено» не равен 2',
    );
    check(popupErrors.length === 0, `попап: ошибки JS: ${popupErrors.join('; ')}`);
  } catch (err) {
    failures.push(String(err && err.message ? err.message : err));
  } finally {
    if (context) await context.close().catch(() => {});
    server.close();
  }

  if (failures.length) {
    console.error('\nПРОВАЛ:');
    for (const f of failures) console.error(' -', f);
    process.exit(1);
  }
  console.log('\nOK: все проверки прошли.');
}

main();
