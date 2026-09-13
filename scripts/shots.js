// Скриншоты страницы в трёх ширинах через протокол отладки браузера.
// Никаких зависимостей: только node и браузер на базе Chromium.
// Умеет то, чего не умеет съёмка флагом --screenshot:
//   - снимает страницу целиком, а не первый экран;
//   - отличает живую страницу от страницы ошибки;
//   - меряет горизонтальный перелив - главную поломку на телефоне.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const [, , URL_ARG, OUT_DIR, LABEL, BROWSER] = process.argv;
const SIZES = [
  { name: 'desktop', width: 1440 },
  { name: 'tablet', width: 768 },
  { name: 'mobile', width: 390 },
];

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'shots-profile-'));
const browser = spawn(BROWSER, [
  '--headless=new', '--disable-gpu', '--no-sandbox',
  '--remote-debugging-port=0',
  `--user-data-dir=${profile}`,          // не трогаем рабочий профиль браузера
  '--force-prefers-reduced-motion',
  '--hide-scrollbars',
  'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] });

let stderr = '';
const wsReady = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('браузер не отозвался за 20 секунд')), 20000);
  browser.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
    const m = stderr.match(/ws:\/\/[^\s]+/);
    if (m) { clearTimeout(timer); resolve(m[0]); }
  });
  browser.on('exit', (code) => { clearTimeout(timer); reject(new Error(`браузер завершился с кодом ${code}`)); });
});

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const waiting = new Map();
    let id = 0;
    ws.onopen = () => resolve({
      send(method, params = {}, sessionId) {
        id += 1;
        const msg = { id, method, params };
        if (sessionId) msg.sessionId = sessionId;
        ws.send(JSON.stringify(msg));
        return new Promise((res, rej) => waiting.set(id, { res, rej }));
      },
      close: () => ws.close(),
    });
    ws.onerror = () => reject(new Error('не удалось подключиться к браузеру'));
    ws.onmessage = (ev) => {
      const data = JSON.parse(ev.data);
      const slot = waiting.get(data.id);
      if (!slot) return;
      waiting.delete(data.id);
      data.error ? slot.rej(new Error(data.error.message)) : slot.res(data.result);
    };
  });
}

(async () => {
  const cdp = await connect(await wsReady);
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const call = (m, p = {}) => cdp.send(m, p, sessionId);

  await call('Page.enable');
  await call('Runtime.enable');

  const results = [];
  let failed = false;

  for (const size of SIZES) {
    const file = path.join(OUT_DIR, `${size.name}${LABEL ? '-' + LABEL : ''}.png`);
    await call('Emulation.setDeviceMetricsOverride', {
      width: size.width, height: 900, deviceScaleFactor: 1,
      // mobile:false намеренно: так ширина экрана меряется честно и не зависит
      // от meta viewport. Наличие самого meta viewport проверяет links.sh.
      mobile: false,
    });

    const nav = await call('Page.navigate', { url: URL_ARG });
    if (nav.errorText) {
      console.log(`  НЕ СНЯЛОСЬ ${size.name}: страница не открылась (${nav.errorText})`);
      failed = true;
      continue;
    }
    await new Promise((r) => setTimeout(r, 2500));   // шрифты и отложенная отрисовка

    // Страница ошибки браузера выглядит как обычная страница: отличаем её по признакам.
    const probe = await call('Runtime.evaluate', {
      returnByValue: true,
      expression: `(() => {
        const d = document.documentElement;
        return {
          height: Math.max(d.scrollHeight, document.body ? document.body.scrollHeight : 0),
          scrollWidth: d.scrollWidth,
          innerWidth: window.innerWidth,
          text: (document.body ? document.body.innerText : '').slice(0, 400),
          errorPage: !!document.querySelector('div#main-frame-error, .error-code'),
          title: document.title,
        };
      })()`,
    });
    const info = probe.result.value;

    if (info.errorPage) {
      console.log(`  НЕ СНЯЛОСЬ ${size.name}: браузер показал страницу ошибки, а не сайт`);
      failed = true;
      continue;
    }
    if (!info.height || info.height < 50) {
      console.log(`  НЕ СНЯЛОСЬ ${size.name}: страница пустая (высота ${info.height}px)`);
      failed = true;
      continue;
    }

    const shot = await call('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,                    // вся страница, а не первый экран
      clip: { x: 0, y: 0, width: size.width, height: info.height, scale: 1 },
    });
    fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));

    const overflow = info.scrollWidth - info.innerWidth;
    results.push({ ...size, file, height: info.height, overflow });
    console.log(`  ${file}  (${size.width}x${info.height}, ${fs.statSync(file).size} байт)`);
  }

  cdp.close();
  browser.kill();
  fs.rmSync(profile, { recursive: true, force: true });

  console.log('');
  const spilled = results.filter((r) => r.overflow > 1);
  if (spilled.length) {
    console.log('ГОРИЗОНТАЛЬНЫЙ ПЕРЕЛИВ - контент шире экрана:');
    for (const r of spilled) console.log(`  ${r.name} (${r.width}px): шире на ${r.overflow}px`);
    console.log('Это критичная находка вёрстки: на телефоне страница ездит вбок.');
    process.exit(1);
  }
  if (failed) process.exit(1);
  console.log('перелива нет ни на одной ширине');
  process.exit(0);
})().catch((e) => {
  browser.kill();
  fs.rmSync(profile, { recursive: true, force: true });
  console.log(`съёмка не состоялась: ${e.message}`);
  process.exit(1);
});
