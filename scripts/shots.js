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
const SETTLE_MIN = (Number(process.env.SHOTS_WAIT) || 5) * 1000;
const SETTLE_MAX = SETTLE_MIN + 10000;

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'shots-profile-'));
let browser = null;
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

function finish(code, lines = []) {
  // Частичная съёмка - не доказательство: одинокий кадр легко принять за
  // полный комплект. Оставляем снимки только когда сняты все три ширины.
  if (code !== 0) for (const f of targets) fs.rmSync(f, { force: true });
  cleanup().then(() => {
    for (const l of lines) console.log(l);
    process.exit(code);
  });
}

browser = spawn(BROWSER, [
  '--headless=new', '--disable-gpu', '--no-sandbox',
  '--remote-debugging-port=0',
  `--user-data-dir=${profile}`,          // рабочий профиль браузера не трогаем
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
    const events = new Map();      // имя события -> список ожидающих
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

  const results = [];
  const problems = [];
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
      problems.push(`${size.name}: страница не открылась (${nav.errorText})`);
      continue;
    }
    const waited = await loaded;
    if (waited === 'не дождались') {
      problems.push(`${size.name}: страница не догрузилась за ${LOAD_TIMEOUT / 1000} секунд`);
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
      if (now === stable && now.endsWith('x1')) same += 1; else same = 0;
      stable = now;
      // Раньше минимального срока не выходим: страница может выглядеть
      // спокойной ровно до того мгновения, когда придёт виджет.
      if (same >= 2 && Date.now() - started >= SETTLE_MIN) break;
    }
    if (same < 2) {
      problems.push(`${size.name}: страница не успокоилась за ${SETTLE_MAX / 1000} секунд, кадр может быть недорисован`);
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
      problems.push(`${size.name}: браузер показал страницу ошибки, а не сайт`);
      continue;
    }
    if (!info.height || info.height < 50) {
      problems.push(`${size.name}: страница пустая (высота ${info.height}px)`);
      continue;
    }
    if (info.href && info.href !== URL_ARG && !reported) {
      reported = info.href;
    }

    const height = Math.min(info.height, MAX_HEIGHT);
    if (info.height > MAX_HEIGHT) {
      problems.push(`${size.name}: страница ${info.height}px, кадр обрезан до ${MAX_HEIGHT}px - снимай отдельные секции`);
    }

    const shot = await call('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,                    // вся страница, а не первый экран
      clip: { x: 0, y: 0, width: size.width, height, scale: 1 },
    });
    fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));

    results.push({ ...size, file, height, overflow: info.scrollWidth - info.innerWidth });
    console.log(`  ${file}  (${size.width}x${height}, ${fs.statSync(file).size} байт)`);
  }

  cdp.close();

  const out = [''];
  if (reported) out.push(`снято по адресу ${reported} - он отличается от запрошенного, была переадресация`);
  for (const p of problems) out.push(`  НЕ СНЯТО ${p}`);

  const spilled = results.filter((r) => r.overflow > 1);
  if (spilled.length) {
    out.push('ГОРИЗОНТАЛЬНЫЙ ПЕРЕЛИВ - контент шире экрана:');
    for (const r of spilled) out.push(`  ${r.name} (${r.width}px): шире на ${r.overflow}px`);
    out.push('Это критичная находка вёрстки: на телефоне страница ездит вбок.');
  }

  // Успех - только когда сняты все три ширины и ни одна не переливается.
  if (results.length !== SIZES.length) {
    out.push(`снято ширин: ${results.length} из ${SIZES.length} - съёмка не состоялась`);
    return finish(NECHEM, out);
  }
  if (spilled.length) return finish(POLOMKA, out);
  out.push('перелива нет ни на одной ширине');
  return finish(0, out);
})().catch((e) => {
  finish(NECHEM, [`съёмка не состоялась: ${e.message}`]);
});
