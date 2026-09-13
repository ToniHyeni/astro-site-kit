#!/usr/bin/env bash
# Полный машинный прогон: сборка, проверка вёрстки, скриншоты.
# Останавливается на первой неудаче: проверять сломанную сборку бессмысленно.
#   ./scripts/check.sh                       собрать, проверить dist, снять скриншоты с локального просмотра
#   ./scripts/check.sh --url https://домен   то же, но скриншоты с живого адреса
set -uo pipefail

DIST="dist"
URL=""
BUILD="npm run build"
PREVIEW_URL="http://localhost:4321"

while [ $# -gt 0 ]; do
  case "$1" in
    --url)   URL="$2"; shift 2 ;;
    --dist)  DIST="$2"; shift 2 ;;
    --build) BUILD="$2"; shift 2 ;;
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

step "2. Проверка собранного сайта"
if ! ./scripts/links.sh "$DIST"; then
  echo
  echo "ИТОГ: в сборке есть нарушения. Чинить до скриншотов: проверяющие не должны смотреть на битую страницу."
  exit 1
fi

step "3. Скриншоты"
if [ -n "$URL" ]; then
  ./scripts/shots.sh "$URL" || exit 1
else
  echo "Локальный просмотр должен быть запущен: $PREVIEW_URL"
  echo "Не запущен - открой второе окно терминала и запусти 'npm run dev'."
  ./scripts/shots.sh "$PREVIEW_URL" || exit 1
fi

echo
echo "==============================="
echo "Машинные проверки пройдены."
echo "Дальше - четыре проверяющих из roles/, каждый отдельным заходом (см. 02-proverka.md)."
