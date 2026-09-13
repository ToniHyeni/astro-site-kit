// Скриншоты страницы в трёх ширинах через протокол отладки браузера.
// Зависимостей нет, нужен node 22+ (встроенный WebSocket) и браузер на базе Chromium.
// Умеет то, чего не умеет съёмка флагом --screenshot:
//   - снимает страницу целиком, а не первый экран;
//   - отличает живую страницу от страницы ошибки;
//   - меряет горизонтальный перелив - главную поломку на телефоне.
// Коды возврата: 0 - снято, 1 - поломка вёрстки (перелив), 2 - снять нечем.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const NECHEM = 2;        // проверка не состоялась
const POLOMKA = 1;       // нашлась поломка вёрстки

if (typeof WebSocket === 'undefined') {
  console.log('нужен node 22 или новее: в более старых нет встроенного WebSocket');
  console.log(`сейчас ${process.version}`);
  process.exit(NECHEM);
}

const [, , URL_ARG, OUT_DIR, LABEL, BROWSER] = process.argv;
const SIZES = [
  { name: 'desktop', width: 1440 },
  { name: 'tablet', width: 768 },
  { name: 'mobile', width: 390 },
];
const MAX_HEIGHT = 20000;      // выше этого кадр не читается ни человеком, ни ролью
const CALL_TIMEOUT = 15000;   // столько ждём ответа браузера, прежде чем считать съёмку несостоявшейся
const LOAD_TIMEOUT = 20000;
// Сколько ждём дорисовки после загрузки. Виджеты карт, отзывов и форм
// приходят позже, и замер перелива по недорисованной странице врёт.
// Медленный сторонний виджет - увеличить: SHOTS_WAIT=12 ./scripts/shots.sh ...
const WAIT_RAW = process.env.SHOTS_WAIT;
let waitSeconds = 5;
let waitComplaint = '';
if (WAIT_RAW !== undefined && WAIT_RAW !== '') {
  const n = Number(WAIT_RAW);
  if (!Number.isFinite(n) || n < 0) {
    waitComplaint = `SHOTS_WAIT=${WAIT_RAW} - это не число секунд, жду ${waitSeconds} секунд`;
  } else {
    waitSeconds = n;
  }
}
const SETTLE_MIN = waitSeconds * 1000;
const SETTLE_MAX = SETTLE_MIN + 10000;

if (!URL_ARG || !OUT_DIR || !BROWSER) {
  console.log('как запускать: node shots.js <адрес> <папка для кадров> <метка|""> <путь к браузеру>');
  console.log('обычно этот скрипт запускается через ./scripts/shots.sh');
  process.exit(NECHEM);
}
if (waitComplaint) console.log(waitComplaint);

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'shots-profile-'));
let browser = null;
let finishing = false;
let abortAll = () => {};      // заполняется при подключении: отклонить всё, что ждёт ответа

// Старые снимки удаляем до съёмки: иначе неснятый кадр оставит вчерашнюю
// картинку, и проверяющий будет судить о странице, которой уже нет.
const targets = SIZES.map((s) => path.join(OUT_DIR, `${s.name}${LABEL ? '-' + LABEL : ''}.png`));
for (const f of targets) fs.rmSync(f, { force: true });

async function cleanup() {
  if (browser && browser.exitCode === null) {
    const ended = new Promise((r) => browser.once('exit', r));
    browser.kill();
    await Promise.race([ended, new Promise((r) => setTimeout(r, 3000))]);
  }
  try {
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch { /* временный профиль - не повод падать */ }
}

function finish(code, lines = [], dropShots = false) {
  if (finishing) return;
  finishing = true;
  // Частичная съёмка - не доказательство: одинокий кадр легко принять за
  // полный комплект. Но найденный перелив кадры не отменяет - они нужны
  // проверяющему именно тогда, когда поломка нашлась.
  if (dropShots) for (const f of targets) fs.rmSync(f, { force: true });
  cleanup().then(() => {
    for (const l of lines) console.log(l);
    process.exit(code);
  });
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => finish(NECHEM, [`съёмка прервана (${sig})`], true));
}
process.on('unhandledRejection', (e) => finish(NECHEM, [`съёмка не состоялась: ${e && e.message ? e.message : e}`], true));
process.on('uncaughtException', (e) => finish(NECHEM, [`съёмка не состоялась: ${e && e.message ? e.message : e}`], true));

browser = spawn(BROWSER, [
  '--headless=new', '--disable-gpu', '--no-sandbox',
  '--remote-debugging-port=0',
  `--user-data-dir=${profile}`,          // рабочий профиль браузера не трогаем
  '--force-prefers-reduced-motion',
  '--hide-scrollbars',
  'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] });

browser.on('error', (e) => finish(NECHEM, [`браузер не запустился: ${e.message}`], true));

let stderr = '';
const wsReady = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('браузер не отозвался за 20 секунд')), 20000);
  browser.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
    const m = stderr.match(/ws:\/\/[^\s]+/);
    if (m) { clearTimeout(timer); resolve(m[0]); }
  });
  browser.on('exit', (code) => {
    clearTimeout(timer);
    abortAll(`браузер завершился с кодом ${code}`);
    reject(new Error(`браузер завершился с кодом ${code}`));
  });
});

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const waiting = new Map();
    const events = new Map();      // имя события -> список разовых ожидающих
    const handlers = new Map();    // имя события -> постоянные обработчики
    let id = 0;

    // Оборванное соединение обязано отклонить все висящие запросы: иначе
    // цикл событий пустеет, node выходит с нулём, и неудача выглядит успехом.
    const abort = (why) => {
      const err = new Error(why);
      for (const { rej } of waiting.values()) rej(err);
      waiting.clear();
      for (const list of events.values()) for (const { rej } of list) rej(err);
      events.clear();
    };

    ws.onopen = () => resolve({
      send(method, params = {}, sessionId) {
        id += 1;
        const msg = { id, method, params };
        if (sessionId) msg.sessionId = sessionId;
        ws.send(JSON.stringify(msg));
        const myId = id;
        return new Promise((res, rej) => {
          const timer = setTimeout(() => {
            waiting.delete(myId);
            rej(new Error(`браузер не ответил на ${method} за ${CALL_TIMEOUT / 1000} секунд`));
          }, CALL_TIMEOUT);
          waiting.set(myId, {
            res: (v) => { clearTimeout(timer); res(v); },
            rej: (e) => { clearTimeout(timer); rej(e); },
          });
        });
      },
      on(eventName, handler) {
        const list = handlers.get(eventName) || [];
        list.push(handler);
        handlers.set(eventName, list);
      },
      once(eventName, timeoutMs) {
        return new Promise((res, rej) => {
          const timer = setTimeout(() => res('не дождались'), timeoutMs);
          const list = events.get(eventName) || [];
          list.push({ res: (v) => { clearTimeout(timer); res(v); }, rej: (e) => { clearTimeout(timer); rej(e); } });
          events.set(eventName, list);
        });
      },
      close: () => ws.close(),
    });

    ws.onerror = () => { abort('соединение с браузером оборвалось'); reject(new Error('не удалось подключиться к браузеру')); };
    ws.onclose = () => abort('браузер закрылся посреди съёмки');
    // Браузер может умереть, не закрыв сокет: тогда без этого обработчика
    // ответа пришлось бы ждать полный таймаут вызова.
    abortAll = (why) => { abort(why); try { ws.close(); } catch { /* уже закрыт */ } };
    ws.onmessage = (ev) => {
      const data = JSON.parse(ev.data);
      if (data.method) {
        const perm = handlers.get(data.method);
        if (perm) for (const h of perm) h(data.params);
        const list = events.get(data.method);
        if (list) { events.delete(data.method); for (const { res } of list) res(data.params); }
        return;
      }
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
  const evaluate = async (expression) =>
    (await call('Runtime.evaluate', { returnByValue: true, expression })).result.value;

  await call('Page.enable');
  await call('Runtime.enable');
  await call('Network.enable');

  // Пока в сети есть незавершённые запросы, страница ещё дорисовывается.
  // Одних размеров мало: между двумя порциями данных они стоят на месте,
  // и страница выглядит успокоившейся, хотя это всего лишь пауза.
  let inflight = 0;
  cdp.on('Network.requestWillBeSent', () => { inflight += 1; });
  const done = () => { inflight = Math.max(0, inflight - 1); };
  cdp.on('Network.loadingFinished', done);
  cdp.on('Network.loadingFailed', done);

  const results = [];
  const notShot = [];      // ширина не снята вовсе
  const doubts = [];       // кадр есть, но доверять замеру нельзя
  let reported = '';

  for (const size of SIZES) {
    const file = path.join(OUT_DIR, `${size.name}${LABEL ? '-' + LABEL : ''}.png`);
    await call('Emulation.setDeviceMetricsOverride', {
      width: size.width, height: 900, deviceScaleFactor: 1,
      // mobile:false намеренно: так ширина экрана меряется честно и не зависит
      // от meta viewport. Наличие самого meta viewport проверяет links.sh.
      mobile: false,
    });

    const loaded = cdp.once('Page.loadEventFired', LOAD_TIMEOUT);   // подписка до перехода
    const nav = await call('Page.navigate', { url: URL_ARG });
    if (nav.errorText) {
      loaded.catch(() => {});          // ждать больше нечего, гасим ожидание
      notShot.push(`${size.name}: страница не открылась (${nav.errorText})`);
      continue;
    }
    const waited = await loaded;
    if (waited === 'не дождались') {
      notShot.push(`${size.name}: страница не догрузилась за ${LOAD_TIMEOUT / 1000} секунд`);
      continue;
    }

    // Ждём, пока страница перестанет меняться: виджеты, шрифты и острова
    // дорисовываются позже загрузки, а замер перелива по недорисованной
    // странице врёт - именно так перелив и объявляется отсутствующим.
    let stable = null;
    let same = 0;
    const started = Date.now();
    while (Date.now() - started < SETTLE_MAX) {
      await new Promise((r) => setTimeout(r, 400));
      const now = await evaluate(
        '(() => { const d = document.documentElement; return [d.scrollHeight, d.scrollWidth, document.readyState === "complete" ? 1 : 0].join("x"); })()',
      );
      if (now === stable && now.endsWith('x1') && inflight === 0) same += 1; else same = 0;
      stable = now;
      // Раньше минимального срока не выходим: страница может выглядеть
      // спокойной ровно до того мгновения, когда придёт виджет.
      // Три замера подряд - чуть больше секунды покоя при тихой сети.
      if (same >= 3 && Date.now() - started >= SETTLE_MIN) break;
    }
    // Кадр снимем - глазами он полезен, - но замер перелива по меняющейся
    // странице недостоверен, и вердикт по ней не ставится.
    const restless = same < 3;
    if (restless) {
      doubts.push(`${size.name}: страница не успокоилась за ${SETTLE_MAX / 1000} секунд, кадр недорисован`);
    }

    const info = await evaluate(`(() => {
      const d = document.documentElement;
      return {
        height: Math.max(d.scrollHeight, document.body ? document.body.scrollHeight : 0),
        scrollWidth: d.scrollWidth,
        innerWidth: window.innerWidth,
        errorPage: !!document.querySelector('div#main-frame-error, .error-code'),
        href: location.href,
      };
    })()`);

    if (info.errorPage) {
      notShot.push(`${size.name}: браузер показал страницу ошибки, а не сайт`);
      continue;
    }
    if (!info.height || info.height < 50) {
      notShot.push(`${size.name}: страница пустая (высота ${info.height}px)`);
      continue;
    }
    if (info.href && !reported) {
      let same_url = false;
      try { same_url = new URL(info.href).href === new URL(URL_ARG).href; } catch { same_url = info.href === URL_ARG; }
      if (!same_url) reported = info.href;
    }

    const height = Math.min(info.height, MAX_HEIGHT);
    if (info.height > MAX_HEIGHT) {
      doubts.push(`${size.name}: страница ${info.height}px, кадр обрезан до ${MAX_HEIGHT}px - снимай отдельные секции`);
    }

    const shot = await call('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,                    // вся страница, а не первый экран
      clip: { x: 0, y: 0, width: size.width, height, scale: 1 },
    });
    fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));

    results.push({ ...size, file, height, restless, overflow: info.scrollWidth - info.innerWidth });
    console.log(`  ${file}  (${size.width}x${height}, ${fs.statSync(file).size} байт)`);
  }

  cdp.close();

  const out = [''];
  if (reported) out.push(`снято по адресу ${reported} - была переадресация с запрошенного`);
  for (const p of notShot) out.push(`  НЕ СНЯТО ${p}`);
  for (const d of doubts) out.push(`  ПОД СОМНЕНИЕМ ${d}`);

  const spilled = results.filter((r) => r.overflow > 1);
  if (spilled.length) {
    out.push('ГОРИЗОНТАЛЬНЫЙ ПЕРЕЛИВ - контент шире экрана:');
    for (const r of spilled) out.push(`  ${r.name} (${r.width}px): шире на ${r.overflow}px`);
    out.push('Это критичная находка вёрстки: на телефоне страница ездит вбок.');
  }

  // Сняты не все ширины - доказательства нет, кадры удаляем.
  if (results.length !== SIZES.length) {
    out.push(`снято ширин: ${results.length} из ${SIZES.length} - съёмка не состоялась`);
    return finish(NECHEM, out, true);
  }
  // Перелив - вердикт о вёрстке, кадры при этом нужны проверяющему.
  if (spilled.length) return finish(POLOMKA, out);
  // Страница менялась во время замера: вердикт «перелива нет» тут был бы враньём.
  if (results.some((r) => r.restless)) {
    out.push('вердикт по перелеву не ставится: страница менялась во время замера');
    out.push('дай ей больше времени: SHOTS_WAIT=12 ./scripts/shots.sh ...');
    return finish(NECHEM, out);
  }
  out.push('перелива нет ни на одной ширине');
  return finish(0, out);
})().catch((e) => {
  finish(NECHEM, [`съёмка не состоялась: ${e.message}`]);
});
