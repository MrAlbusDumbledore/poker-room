#!/usr/bin/env bash
# Автообновление покер-рума. Запускается таймером раз в 2 минуты, а установщиком — с флагом --now.
#
# 1. Проверяет, есть ли на GitHub новая версия.
# 2. Готовит её в отдельной папке, не трогая работающий сайт.
# 3. Ждёт паузы между раздачами и переключает сайт на новую версию (перезапуск ~2 секунды).
set -euo pipefail

ROOT="${POKER_ROOT:-/opt/poker}"
REPO="$ROOT/repo"
BRANCH="${BRANCH:-main}"
NOW=0
[ "${1:-}" = "--now" ] && NOW=1

# Не запускать два обновления одновременно
exec 9>"${POKER_LOCK:-/run/poker-room-update.lock}"
flock -n 9 || exit 0

git -C "$REPO" fetch -q --depth 1 origin "$BRANCH"
SHA="$(git -C "$REPO" rev-parse --short=12 "origin/$BRANCH")"
CUR="$(basename "$(readlink -f "$ROOT/current" 2>/dev/null || echo none)")"
if [ "$SHA" = "$CUR" ] && [ "$NOW" = 0 ]; then
  exit 0
fi

REL="$ROOT/releases/$SHA"
if [ ! -d "$REL" ]; then
  echo "Готовлю версию $SHA"
  rm -rf "$REL.tmp"
  mkdir -p "$REL.tmp"
  git -C "$REPO" archive "origin/$BRANCH" | tar -x -C "$REL.tmp"
  (cd "$REL.tmp" && npm ci --omit=dev --no-audit --no-fund --loglevel=error)
  mv "$REL.tmp" "$REL"
fi

# Ждём момента, когда ни за одним столом не идёт раздача (не дольше 10 минут)
wait_idle() {
  for _ in $(seq 1 1200); do
    n="$(curl -fsS "${POKER_BUSY_URL:-http://127.0.0.1:3000/api/internal/busy}" 2>/dev/null | sed -n 's/.*"handsInProgress":\([0-9]*\).*/\1/p')"
    if [ "${n:-0}" = 0 ]; then return 0; fi
    sleep 0.5
  done
  echo "Пауза между раздачами не наступила за 10 минут — обновляюсь сейчас"
}

# Если изменились настройки самого сервера (установщик), запускаем установщик целиком.
if [ "$NOW" = 0 ] && [ -z "${POKER_IN_INSTALL:-}" ]; then
  NEW_HASH="$(sha256sum "$REL/deploy/install.sh" | cut -d' ' -f1)"
  if [ "$NEW_HASH" != "$(cat "${POKER_INSTALLER_HASH:-/etc/poker-room.installer}" 2>/dev/null || true)" ]; then
    echo "Изменились настройки сервера — запускаю установщик"
    wait_idle
    exec 9>&- # отпускаем блокировку: установщик сам вызовет обновление
    bash "$REL/deploy/install.sh"
    exit 0
  fi
fi

[ "$NOW" = 1 ] || wait_idle

ln -sfn "$REL" "$ROOT/current.tmp"
mv -Tf "$ROOT/current.tmp" "$ROOT/current"
systemctl restart poker-room
echo "Сайт обновлён до версии $SHA"

# Храним три последние версии, чтобы при необходимости можно было откатиться
ls -1dt "$ROOT"/releases/*/ 2>/dev/null | tail -n +4 | while read -r old; do
  [ "$(readlink -f "$old")" = "$(readlink -f "$ROOT/current")" ] || rm -rf "$old"
done
