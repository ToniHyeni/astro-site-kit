#!/usr/bin/env bash
# Скриншоты страницы в трёх ширинах: широкий экран, планшет, телефон.
# Снимает страницу целиком, проверяет, что открылась именно она, и меряет
# горизонтальный перелив. Кладёт в evidence/shots/. Сайт не меняет.
#   ./scripts/shots.sh http://localhost:4321            одна страница
#   ./scripts/shots.sh https://домен/uslugi/ uslugi     с меткой в имени файла
#   SHOTS_WAIT=12 ./scripts/shots.sh ...                 ждать дорисовки дольше
# Коды: 0 - снято, 1 - поломка вёрстки (перелив), 2 - снять нечем.
set -uo pipefail
URL="${1:-}"
LABEL="${2:-}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="evidence/shots"

[ -z "$URL" ] && { echo "укажи адрес: ./scripts/shots.sh http://localhost:4321"; exit 2; }
command -v node >/dev/null 2>&1 || { echo "нужен node 22 или новее - он и так стоит рядом с Astro"; exit 2; }

# Браузер ищем по обычным местам. Версия из snap идёт последней: она не пишет
# файлы вне домашней папки и молча отдаёт пустой снимок.
BROWSER=""
for c in "$HOME"/.cache/ms-playwright/chromium-*/chrome-linux64/chrome \
         "$HOME"/.cache/ms-playwright/chromium-*/chrome-linux/chrome \
         "$HOME"/.cache/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-linux64/chrome-headless-shell; do
  [ -x "$c" ] && { BROWSER="$c"; break; }
done
if [ -z "$BROWSER" ]; then
  for c in google-chrome google-chrome-stable chromium chromium-browser; do
    command -v "$c" >/dev/null 2>&1 && { BROWSER="$(command -v "$c")"; break; }
  done
fi
[ -z "$BROWSER" ] && { echo "не нашёл браузер. Поставь: npx playwright install chromium"; exit 2; }

case "$BROWSER" in
  /snap/*) echo "внимание: браузер из snap - он не пишет файлы вне домашней папки." ;
           echo "          Держи проект в ~/, иначе снимки выйдут пустыми." ;;
esac

# Адрес должен отвечать ДО съёмки: иначе браузер послушно снимет страницу
# «сайт недоступен», и проверяющие будут изучать её вместо сайта.
if command -v curl >/dev/null 2>&1; then
  if ! curl -sf --max-time 10 -o /dev/null "$URL"; then
    echo "адрес не отвечает: $URL"
    echo "Локальный просмотр не запущен или адрес неверный. Снимать нечего."
    exit 2
  fi
fi

mkdir -p "$OUT"
echo "браузер: $BROWSER"
echo "адрес:   $URL"

node "$HERE/shots.js" "$URL" "$OUT" "$LABEL" "$BROWSER"
rc=$?

echo
if [ "$rc" -eq 2 ]; then
  echo "ИТОГ: снять нечем - смотри причину выше. Это не вердикт о вёрстке."
  exit 2
fi
if [ "$rc" -ne 0 ]; then
  echo "ИТОГ: съёмка нашла поломку вёрстки - смотри выше"
  exit 1
fi
echo "ИТОГ: три скриншота в $OUT"
