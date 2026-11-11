# Как выложить покер-рум в интернет

Нужен сервер с Ubuntu 22.04 или 24.04: 1 ядро и 1 ГБ памяти хватит на несколько столов.

## Установка

1. Сделайте репозиторий публичным (GitHub → Settings → General → Danger Zone → Change visibility → Public).
   Код станет виден всем, но пароли, код приглашения и данные игроков хранятся только на сервере.
2. Откройте консоль сервера (у хостинга есть консоль в браузере) и выполните одну команду:

   ```bash
   curl -fsSL https://raw.githubusercontent.com/MrAlbusDumbledore/poker-room/main/deploy/install.sh | bash
   ```

3. В конце скрипт напишет адрес сайта (вида `https://1-2-3-4.sslip.io`) и код приглашения.
   Отправьте их друзьям.

Со своим доменом: сначала направьте домен на IP сервера (A-запись у регистратора), потом:

```bash
curl -fsSL https://raw.githubusercontent.com/MrAlbusDumbledore/poker-room/main/deploy/install.sh | DOMAIN=poker.example.ru bash
```

## Обновление

Сайт обновляется сам. Раз в 2 минуты сервер проверяет GitHub, и если в ветке `main` появилась новая версия:

1. готовит её в отдельной папке (`/opt/poker/releases/…`), не трогая работающий сайт;
2. ждёт момента, когда ни за одним столом не идёт раздача;
3. переключается на новую версию — перезапуск занимает пару секунд, игроки остаются на своих местах.

Журнал обновлений: `journalctl -u poker-room-update -n 50`.
Обновить вручную прямо сейчас: `bash /opt/poker/current/deploy/update.sh`.

## Где что лежит

| Что | Где |
| --- | --- |
| Код текущей версии | `/opt/poker/current` (ссылка на папку в `/opt/poker/releases`) |
| База данных | `/var/lib/poker-room/poker.db` |
| Резервные копии (каждый день, 14 последних) | `/var/lib/poker-room/backups` |
| Настройки и код приглашения | `/etc/poker-room.env` |
| Адрес сайта для веб-сервера | `/etc/caddy/sites/poker-room.caddy` |

## Несколько сайтов на одном сервере

Каждый сайт описывается своим файлом в `/etc/caddy/sites/`, поэтому на этом же сервере можно разместить и другие сайты:
они не мешают покер-руму. После добавления файла выполните `systemctl reload caddy`.

## Полезные команды

```bash
systemctl status poker-room            # работает ли сайт
systemctl list-timers poker-room-update   # когда следующая проверка обновлений
journalctl -u poker-room -n 100        # журнал сайта
systemctl restart poker-room           # перезапуск
grep REGISTRATION_CODE /etc/poker-room.env   # посмотреть код приглашения
```

Сменить код приглашения: отредактируйте `/etc/poker-room.env` (`nano /etc/poker-room.env`) и выполните
`systemctl restart poker-room`.
