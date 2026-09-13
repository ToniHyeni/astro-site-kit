#!/usr/bin/env bash
# Скриншоты страницы в трёх ширинах: широкий экран, планшет, телефон.
# Кладёт в evidence/shots/. Ничего не меняет на сайте.
#   ./scripts/shots.sh http://localhost:4321           одна страница
#   ./scripts/shots.sh https://домен/uslugi/ uslugi    с меткой в имени файла
set -uo pipefail
URL="${1:-}"
LABEL="${2:-}"
OUT="evidence/shots"

[ -z "$URL" ] && { echo "укажи адрес: ./scripts/shots.sh http://localhost:4321"; exit 2; }

# Браузер ищем по обычным местам: на разных машинах он называется по-разному.
# Сначала пробуем браузер от playwright: версия из snap не умеет писать файлы
# за пределы домашней папки и молча отдаёт пустой скриншот.
BROWSER=""
for c in "$HOME"/.cache/ms-playwright/chromium-*/chrome-linux64/chrome \
         "$HOME"/.cache/ms-playwright/chromium-*/chrome-linux/chrome \
         "$HOME"/.cache/ms-playwright/chromium_headless_shell-*/chrome-linux64/headless_shell; do
  [ -x "$c" ] && { BROWSER="$c"; break; }
done
if [ -z "$BROWSER" ]; then
  for c in google-chrome google-chrome-stable chromium chromium-browser; do
    command -v "$c" >/dev/null 2>&1 && { BROWSER="$(command -v "$c")"; break; }
  done
fi
[ -z "$BROWSER" ] && { echo "не нашёл браузер. Поставь его: npx playwright install chromium"; exit 2; }

case "$(readlink -f "$BROWSER")" in
  /snap/*) echo "внимание: браузер из snap. Он не пишет файлы вне домашней папки -" ;
           echo "          держи проект в ~/, иначе скриншоты выйдут пустыми." ;;
esac

mkdir -p "$OUT"
echo "браузер: $BROWSER"
echo "адрес:   $URL"

snap() {
  local name="$1" width="$2" height="$3"
  local file="$OUT/${name}${LABEL:+-$LABEL}.png"
  "$BROWSER" \
    --headless --disable-gpu --no-sandbox \
    --hide-scrollbars \
    --force-prefers-reduced-motion \
    --virtual-time-budget=6000 \
    --window-size="${width},${height}" \
    --screenshot="$file" \
    "$URL" >/dev/null 2>&1
  if [ -s "$file" ]; then
    echo "  $file  ($(stat -c%s "$file") байт)"
  else
    echo "  НЕ СНЯЛОСЬ: $file"
    return 1
  fi
}

# Высота с запасом: обрезанный низ прячет ровно то, что чаще всего ломается.
fail=0
snap desktop 1440 3000 || fail=1
snap tablet   768 2600 || fail=1
snap mobile   390 2400 || fail=1

echo
if [ "$fail" -ne 0 ]; then
  echo "ИТОГ: сняты не все размеры"
  exit 1
fi
echo "ИТОГ: три скриншота в $OUT"
echo "Снимок выглядит пустым - обычно виноваты блоки с появлением при прокрутке."
echo "Флаг --force-prefers-reduced-motion уже включён; если не помогло, отключи анимацию появления на время съёмки."
