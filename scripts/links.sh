#!/usr/bin/env bash
# Механическая проверка собранного сайта: битые ссылки и гигиена разметки.
# Ничего не меняет, только читает. Выход 1, если нашлись нарушения.
#   ./scripts/links.sh [папка_сборки]      по умолчанию dist
set -uo pipefail
DIST="${1:-dist}"

[ -d "$DIST" ] || { echo "нет папки сборки: $DIST (сначала собери сайт)"; exit 2; }
command -v python3 >/dev/null || { echo "нужен python3"; exit 2; }

python3 - "$DIST" <<'PY'
import sys, os, json
from html.parser import HTMLParser
from urllib.parse import urlparse, unquote

dist = sys.argv[1]
checks = 0          # сколько проверок выполнено
problems = []       # (важность, файл, что не так)

def add(sev, f, msg):
    problems.append((sev, f, msg))

class Page(HTMLParser):
    def __init__(self):
        super().__init__()
        self.title = None
        self._in_title = False
        self.desc = None
        self.robots = None
        self.viewport = None
        self.canonical = None
        self.h = []              # (уровень, текст)
        self._cur_h = None
        self.imgs = []           # (src, alt_present, alt_text)
        self.srcs = []           # адреса из srcset и <source>
        self.links = []          # href
        self.jsonld = []
        self._in_ld = False

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == 'title':
            self._in_title = True
            self.title = ''
        elif tag == 'meta':
            name = (a.get('name') or '').lower()
            if name == 'viewport':
                self.viewport = a.get('content')
            if name == 'description':
                self.desc = a.get('content')
            elif name == 'robots':
                self.robots = a.get('content')
        elif tag == 'link' and (a.get('rel') or '').lower() == 'canonical':
            self.canonical = a.get('href')
        elif tag in ('h1', 'h2', 'h3', 'h4'):
            self._cur_h = [int(tag[1]), '']
        elif tag == 'img':
            self.imgs.append((a.get('src') or '', 'alt' in a, a.get('alt') or ''))
            self.srcs += srcset_urls(a.get('srcset'))
        elif tag == 'source':
            self.srcs += srcset_urls(a.get('srcset') or a.get('src'))
        elif tag == 'a':
            self.links.append(a.get('href'))
        elif tag == 'script' and (a.get('type') or '') == 'application/ld+json':
            self._in_ld = True
            self.jsonld.append('')

    def handle_endtag(self, tag):
        if tag == 'title':
            self._in_title = False
        elif tag in ('h1', 'h2', 'h3', 'h4') and self._cur_h:
            self.h.append(tuple(self._cur_h))
            self._cur_h = None
        elif tag == 'script':
            self._in_ld = False

    def handle_data(self, data):
        if self._in_title and self.title is not None:
            self.title += data
        if self._cur_h:
            self._cur_h[1] += data
        if self._in_ld and self.jsonld:
            self.jsonld[-1] += data

def srcset_urls(value):
    """Адреса из srcset: 'a.webp 320w, b.webp 640w' -> ['a.webp', 'b.webp']."""
    if not value:
        return []
    out = []
    for part in value.split(','):
        part = part.strip()
        if part:
            out.append(part.split()[0])
    return out


def local(url):
    """Ссылка ведёт внутрь сайта - её можно проверить на месте.
    Всё, у чего есть схема (https:, mailto:, tel:, javascript:), - не наше дело."""
    if not url:
        return False
    u = url.strip()
    if u.startswith('//'):
        return False
    return not urlparse(u).scheme

def resolve(href, page_path):
    """Куда на диске смотрит внутренняя ссылка."""
    p = unquote(urlparse(href).path)
    if not p:
        return None                       # чистый якорь вида #contacts
    base = dist if p.startswith('/') else os.path.dirname(page_path)
    t = os.path.normpath(os.path.join(base, p.lstrip('/')))
    root = os.path.normpath(dist)
    if os.path.commonpath([os.path.abspath(t), os.path.abspath(root)]) != os.path.abspath(root):
        return False                      # ссылка уводит за пределы сборки - на сервере это 404
    for cand in (t, t + '.html', os.path.join(t, 'index.html')):
        if os.path.isfile(cand):          # каталог без index.html сервер тоже отдаст как 404
            return cand
    return False

pages = []
for root, _, files in os.walk(dist):
    for f in files:
        if f.endswith('.html'):
            pages.append(os.path.join(root, f))
pages.sort()

if not pages:
    print(f"в папке {dist} нет ни одного .html - проверять нечего")
    sys.exit(2)

for path in pages:
    rel = os.path.relpath(path, dist)
    p = Page()
    try:
        p.feed(open(path, encoding='utf-8', errors='replace').read())
    except Exception as e:
        add('критично', rel, f'не разобрался в HTML: {e}')
        continue

    # 1. заголовок вкладки
    checks += 1
    if not (p.title or '').strip():
        add('критично', rel, 'нет заголовка вкладки <title> или он пустой')
    elif len(p.title.strip()) > 60:
        add('мелочь', rel, f'заголовок вкладки длинный: {len(p.title.strip())} знаков при норме 60')

    # 2. описание
    checks += 1
    if not (p.desc or '').strip():
        add('существенно', rel, 'нет описания страницы <meta name="description">')
    elif len(p.desc.strip()) > 160:
        add('мелочь', rel, f'описание длинное: {len(p.desc.strip())} знаков при норме 160')

    # 3. ровно один h1
    checks += 1
    h1 = [t for lvl, t in p.h if lvl == 1]
    if len(h1) == 0:
        add('критично', rel, 'на странице нет h1')
    elif len(h1) > 1:
        add('критично', rel, f'заголовков h1 на странице: {len(h1)}, должен быть один')

    # 4. уровни заголовков без пропуска
    checks += 1
    prev = 0
    for lvl, _ in p.h:
        if prev and lvl > prev + 1:
            add('существенно', rel, f'пропущен уровень заголовка: после h{prev} идёт h{lvl}')
            break
        prev = lvl

    # 5. описания картинок
    for src, has_alt, alt in p.imgs:
        checks += 1
        if not has_alt:
            add('существенно', rel, f'картинка без описания alt: {src}')
        elif alt.strip() and os.path.basename(src).split('.')[0].lower() == alt.strip().lower():
            add('мелочь', rel, f'в alt имя файла вместо описания: {src}')

    # 6. локальные картинки существуют, включая srcset и <source>
    for src in [i[0] for i in p.imgs] + p.srcs:
        if local(src):
            checks += 1
            if resolve(src, path) is False:
                add('критично', rel, f'картинка не найдена в сборке: {src}')

    # 7. внутренние ссылки существуют
    for href in p.links:
        checks += 1
        if href is None:
            add('существенно', rel, 'ссылка <a> без адреса href')
            continue
        h = href.strip()
        if h == '#':
            add('существенно', rel, 'ссылка-заглушка href="#" - никуда не ведёт')
            continue
        if h == '':
            add('существенно', rel, 'пустой адрес в href - ссылка перезагружает текущую страницу')
            continue
        if local(h):
            r = resolve(h, path)
            if r is False:
                add('критично', rel, f'битая внутренняя ссылка: {h}')

    # 8. мобильный вьюпорт
    checks += 1
    if not (p.viewport or '').strip():
        add('критично', rel, 'нет <meta name="viewport"> - на телефоне страница покажется уменьшенной копией десктопа')
    elif 'width=device-width' not in p.viewport.replace(' ', ''):
        add('существенно', rel, f'в meta viewport нет width=device-width: {p.viewport}')

    # 9. запрет индексации
    checks += 1
    if p.robots and 'noindex' in p.robots.lower():
        add('существенно', rel, 'на странице стоит запрет индексации noindex - проверь, что так и задумано')

    # 10. разметка для поиска не битая
    checks += 1
    for block in p.jsonld:
        if block.strip():
            try:
                json.loads(block)
            except Exception as e:
                add('критично', rel, f'битая разметка JSON-LD: {e}')

print(f"страниц проверено: {len(pages)}")
print(f"проверок выполнено: {checks}")
print(f"нарушений найдено: {len(problems)}")

if problems:
    print()
    order = {'критично': 0, 'существенно': 1, 'мелочь': 2}
    for sev, f, msg in sorted(problems, key=lambda x: (order.get(x[0], 3), x[1])):
        print(f"  [{sev}] {f}: {msg}")
    blocking = [p for p in problems if p[0] == 'критично']
    print()
    print(f"ИТОГ: не пройдено, критичных - {len(blocking)}")
    sys.exit(1)

print("ИТОГ: пройдено")
PY
