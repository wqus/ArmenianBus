# ArmeniaBus на VPS с существующим Nginx

Этот вариант предназначен для хоста, где другой Compose-проект уже публикует 80/443. Публичный путь: Cloudflare → Nginx (`bus.mathbot.site`, HTTPS) → `armeniabus-web:80` в общей Docker-сети → API во внутренней сети проекта. PostgreSQL, Redis и API не публикуют host-порты. Не останавливать и не пересоздавать чужой Nginx-проект ради установки ArmeniaBus.

## Проверки перед установкой

1. Проверить свободные RAM, место под два поколения образов и backup с временным восстановлением, а также занятые Docker-подсети. Текущий VPS обслуживает другие приложения; при нехватке ресурсов увеличить его до установки нового стека.
2. Убедиться, что `docker compose version` поддерживает YAML `!reset` и `up --wait`. Проверка `docker compose -f compose.production.yaml -f compose.existing-nginx.yaml --env-file /secure/armeniabus.env config --quiet` должна завершиться без ошибки. Не печатать полный `config`: в нём есть секреты.
3. Сохранить исходный конфиг Nginx и выяснить путь его bind mount, не меняя чужие виртуальные хосты. Проверить, что сеть `nginx-proxy` существует, а Nginx-контейнер подключён к ней. Узнать текущий IP Nginx-контейнера в этой сети для `INGRESS_PROXY_IP`.
4. Подготовить в Cloudflare запись `bus.mathbot.site` на VPS. Для HTTPS нужен сертификат на этот поддомен внутри Nginx; если используется Cloudflare Origin CA, режим TLS Cloudflare должен проверять сертификат origin. Не переключать DNS на новую площадку до работающего Nginx virtual host и локальной проверки.

## Конфигурация приложения

Создать защищённый env-файл вне Git по `.env.production.example`. Указать `APP_DOMAIN=bus.mathbot.site`, отдельные случайные секреты и свободную `EDGE_SUBNET`. Добавить `INGRESS_NETWORK=nginx-proxy` и `INGRESS_PROXY_IP=<IP контейнера nginx-proxy-nginx-1 в этой сети>`. Для первого запуска оставить `PAYMENTS_ENABLED=false` и `NOTIFICATIONS_ENABLED=false`; test YooKassa и SMTP проверять после доступного HTTPS. Env-файл читается администраторами Docker; ограничить права. Не передавать его в чат, Git или логи.

Всегда указывать **оба** Compose-файла и одно постоянное имя проекта:

```sh
docker compose -p armeniabus -f compose.production.yaml -f compose.existing-nginx.yaml --env-file /secure/armeniabus.env config --quiet
```

`compose.existing-nginx.yaml` убирает публикацию 80/443 из веб-контейнера, подключает его к существующей внешней сети под именем `armeniabus-web` и заменяет Caddy-конфиг на внутренний HTTP. Caddy принимает `X-Forwarded-*` только от текущего IP Nginx. При смене IP Nginx обновить `INGRESS_PROXY_IP` и пересоздать только веб-контейнер. Не добавлять PostgreSQL или API в общую сеть.

## Виртуальный хост Nginx

Добавить отдельный `server_name bus.mathbot.site` в существующую конфигурацию Nginx после размещения сертификата по путям, доступным **внутри** контейнера. Пример: заменить пути сертификата на фактические, затем `nginx -t` перед `nginx -s reload`.

```nginx
server {
    listen 80;
    server_name bus.mathbot.site;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    server_name bus.mathbot.site;
    ssl_certificate /etc/nginx/certs/bus_fullchain.pem;
    ssl_certificate_key /etc/nginx/certs/bus_privkey.pem;

    resolver 127.0.0.11 valid=10s ipv6=off;
    location / {
        set $armeniabus_backend armeniabus-web;
        proxy_pass http://$armeniabus_backend:80;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Переменная в `proxy_pass` заставляет Nginx повторно разрешать Docker DNS после пересоздания веб-контейнера. Внешний HTTP перенаправляется на HTTPS; Caddy намеренно передаёт API `X-Forwarded-Proto: https`. Защита браузерной сессии, CSRF и return URL требуют единого HTTPS origin `https://bus.mathbot.site`. Отдельно проверить реальный клиентский IP за Cloudflare до открытия регистрации: текущие другие Nginx-хосты используют `$proxy_add_x_forwarded_for`, а приложение ограничивает попытки входа по адресу клиента.

До DNS-переключения проверить Nginx-ответ с заданным Host через `curl --resolve` или аналог и настоящий сертификат. После переключения проверить `/api/v1/health/ready`, frontend, вход/выход, webhook-путь, заголовки безопасности и отсутствие публичных портов БД/API/web. HTTP 404 на `/telegram/` другого проекта не служит проверкой ArmeniaBus.

## Обновления

Для `scripts/release_deploy.py` передавать `--compose-override compose.existing-nginx.yaml` и при apply, и при rollback. Утилита применит одинаковую пару Compose-файлов также к backup/restore-check и запишет хеш эффективной конфигурации. Изменение этого флага между apply и rollback блокирует откат. Обычные ручные Compose-команды после релиза используют оба файла и `release-state/<environment>/active.env` вслед за защищённым env. Не запускать `down --volumes`.

Полный запуск и проверка платежей/SMTP следуют [environments.md](environments.md), [releases.md](releases.md) и [staging-integrations.md](staging-integrations.md). В существующем Nginx публичный TLS обслуживает он, поэтому шаги Caddy ACME из standalone-варианта не применяются.
