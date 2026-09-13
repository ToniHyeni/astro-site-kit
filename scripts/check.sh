#!/usr/bin/env bash
# Полный машинный прогон: сборка, проверка вёрстки, скриншоты.
# Останавливается на первой неудаче: проверять сломанную сборку бессмысленно.
#   ./scripts/check.sh                       собрать, проверить, снять с локального просмотра
#   ./scripts/check.sh --url https://домен   то же, но скриншоты с живого адреса
# Команду сборки, папку сборки и адрес просмотра берёт из PROJECT.md,
# если они там записаны. Флаги --build/--dist/--url перекрывают файл.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$HERE")"
PROJECT_FILE="$ROOT/PROJECT.md"

# Значения по умолчанию - обычные для Astro. PROJECT.md их перекрывает.
BUILD="npm run build"
DIST="dist"
PREVIEW_URL="http://localhost:4321"
URL=""

# Читаем строки вида: - **Команда сборки:** `npm run build`
from_project() {
  [ -f "$PROJECT_FILE" ] || return 1
  grep -m1 -- "$1" "$PROJECT_FILE" 2>/dev/null \
    | sed -e 's/.*\*\*[^*]*\*\*//' -e 's/`//g' -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//'
}
v="$(from_project 'Команда сборки:')"       ; [ -n "${v:-}" ] && BUILD="$v"
v="$(from_project 'Куда кладётся результат:')"; [ -n "${v:-}" ] && DIST="$v"
v="$(from_project 'Адрес локального просмотра:')"; [ -n "${v:-}" ] && PREVIEW_URL="$v"

need_value() { [ $# -ge 2 ] && [ -n "$2" ] || { echo "флаг $1 требует значения"; exit 2; }; }
while [ $# -gt 0 ]; do
  case "$1" in
    --url)   need_value "$1" "${2:-}"; URL="$2";   shift 2 ;;
    --dist)  need_value "$1" "${2:-}"; DIST="$2";  shift 2 ;;
    --build) need_value "$1" "${2:-}"; BUILD="$2"; shift 2 ;;
    *) echo "неизвестный аргумент: $1"; exit 2 ;;
  esac
done

step() { echo; echo "--- $1 ---"; }

step "1. Сборка: $BUILD"
if ! eval "$BUILD"; then
  echo
  echo "ИТОГ: сборка упала. Дальше не идём - проверять нечего."
  exit 1
fi

step "2. Проверка собранного сайта: $DIST"
"$HERE/links.sh" "$DIST"
rc=$?
if [ "$rc" -eq 2 ]; then
  echo
  echo "ИТОГ: проверить нечем - смотри причину выше. Это не вердикт о вёрстке."
  exit 2
fi
if [ "$rc" -ne 0 ]; then
  echo
  echo "ИТОГ: в сборке есть нарушения. Чинить до скриншотов: проверяющие не должны смотреть на битую страницу."
  exit 1
fi

step "3. Скриншоты"
TARGET="${URL:-$PREVIEW_URL}"
[ -z "$URL" ] && echo "Локальный просмотр должен быть запущен ($PREVIEW_URL). Не запущен - открой второе окно терминала и запусти команду просмотра."
"$HERE/shots.sh" "$TARGET" ${URL:+prod}
rc=$?
if [ "$rc" -eq 2 ]; then
  echo
  echo "ИТОГ: снять нечем - смотри причину выше."
  exit 2
fi
[ "$rc" -ne 0 ] && exit 1

echo
echo "==============================="
echo "Машинные проверки пройдены."
echo "Дальше - четыре проверяющих из roles/, каждый отдельным заходом (см. 02-proverka.md)."
