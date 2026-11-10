#!/usr/bin/env bash
# Установка покер-рума на чистый сервер Ubuntu 22.04 / 24.04.
# Запускать от root:
#   curl -fsSL https://raw.githubusercontent.com/MrAlbusDumbledore/poker-room/main/deploy/install.sh | bash
# Свой домен (необязательно):
#   curl -fsSL .../install.sh | DOMAIN=poker.example.ru bash
# Повторный запуск безопасен: обновит код и перезапустит сервис, данные не трогает.
set -euo pipefail

REPO="${REPO:-https://github.com/MrAlbusDumbledore/poker-room.git}"
BRANCH="${BRANCH:-main}"
APP_DIR=/opt/poker-room
DATA_DIR=/var/lib/poker-room
ENV_FILE=/etc/poker-room.env
DOMAIN="${DOMAIN:-}"

say() { printf '\n\033[1;33m==> %s\033[0m\n' "$*"; }

if [ "$(id -u)" -ne 0 ]; then
  echo "Запустите скрипт от root (или через sudo)." >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive

say "Устанавливаю системные пакеты"
apt-get update -y
apt-get install -y curl git ca-certificates gnupg openssl debian-keyring debian-archive-keyring apt-transport-https

say "Устанавливаю Node.js 22"
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
node -v

say "Устанавливаю Caddy (веб-сервер с автоматическим HTTPS)"
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y
  apt-get install -y caddy
fi

say "Скачиваю код покер-рума"
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" fetch --depth 1 origin "$BRANCH"
  git -C "$APP_DIR" reset --hard "origin/$BRANCH"
else
  git clone --depth 1 --branch "$BRANCH" "$REPO" "$APP_DIR"
fi
cd "$APP_DIR"
npm ci --omit=dev --no-audit --no-fund

say "Настраиваю пользователя и папку для данных"
id poker >/dev/null 2>&1 || useradd --system --home-dir "$DATA_DIR" --shell /usr/sbin/nologin poker
mkdir -p "$DATA_DIR"
chown poker:poker "$DATA_DIR"
chmod 700 "$DATA_DIR"

if [ ! -f "$ENV_FILE" ]; then
  say "Создаю настройки и код приглашения"
  CODE="$(openssl rand -hex 4)"
  cat > "$ENV_FILE" <<EOF
PORT=3000
DB_PATH=$DATA_DIR/poker.db
REGISTRATION_CODE=$CODE
COOKIE_SECURE=1
TRUST_PROXY=1
NODE_ENV=production
EOF
  chmod 600 "$ENV_FILE"
fi

if [ -z "$DOMAIN" ]; then
  if [ -f /etc/poker-room.domain ]; then
    DOMAIN="$(cat /etc/poker-room.domain)"
  else
    IP="$(curl -4 -fsS https://api.ipify.org || hostname -I | awk '{print $1}')"
    # Бесплатный адрес вида 1-2-3-4.sslip.io указывает на IP сервера — для него Caddy получит HTTPS-сертификат.
    DOMAIN="${IP//./-}.sslip.io"
  fi
fi
echo "$DOMAIN" > /etc/poker-room.domain

say "Настраиваю адрес $DOMAIN"
cat > /etc/caddy/Caddyfile <<EOF
$DOMAIN {
  encode gzip
  reverse_proxy 127.0.0.1:3000
}
EOF

cat > /etc/systemd/system/poker-room.service <<EOF
[Unit]
Description=Покер-рум
After=network.target

[Service]
User=poker
Group=poker
WorkingDirectory=$APP_DIR
EnvironmentFile=$ENV_FILE
ExecStart=/usr/bin/node --disable-warning=ExperimentalWarning --import tsx src/server/index.ts
Restart=always
RestartSec=3
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$DATA_DIR
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF

# Ежедневная копия базы (безопасно на ходу, через VACUUM INTO), хранятся последние 14
cat > /etc/cron.daily/poker-room-backup <<'EOF'
#!/bin/sh
DATA_DIR=/var/lib/poker-room
[ -f "$DATA_DIR/poker.db" ] || exit 0
mkdir -p "$DATA_DIR/backups"
OUT="$DATA_DIR/backups/poker-$(date +%F).db"
rm -f "$OUT"
/usr/bin/node --disable-warning=ExperimentalWarning -e "new (require('node:sqlite').DatabaseSync)(process.argv[1]).exec(\"VACUUM INTO '\" + process.argv[2] + \"'\")" "$DATA_DIR/poker.db" "$OUT"
ls -1t "$DATA_DIR"/backups/poker-*.db | tail -n +15 | xargs -r rm -f
chown -R poker:poker "$DATA_DIR/backups"
EOF
chmod 755 /etc/cron.daily/poker-room-backup

if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then
  ufw allow 22/tcp >/dev/null
  ufw allow 80/tcp >/dev/null
  ufw allow 443/tcp >/dev/null
fi

say "Запускаю"
systemctl daemon-reload
systemctl enable poker-room >/dev/null
systemctl restart poker-room
systemctl enable caddy >/dev/null
systemctl restart caddy

for i in $(seq 1 20); do
  if curl -fsS http://127.0.0.1:3000/api/config >/dev/null 2>&1; then break; fi
  sleep 1
done
if ! curl -fsS http://127.0.0.1:3000/api/config >/dev/null 2>&1; then
  echo "Сервер не запустился. Последние строки журнала:" >&2
  journalctl -u poker-room -n 30 --no-pager >&2
  exit 1
fi

CODE="$(grep '^REGISTRATION_CODE=' "$ENV_FILE" | cut -d= -f2)"
printf '\n\033[1;32mГотово!\033[0m\n'
echo "Адрес сайта:       https://$DOMAIN"
echo "Код приглашения:   $CODE"
echo
echo "Первое открытие может занять до минуты — сервер получает HTTPS-сертификат."
echo "Обновить сайт после новых изменений: запустите эту же команду ещё раз."
