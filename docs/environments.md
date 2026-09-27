# D1 — local, staging и production

Подготовлен общий стек frontend + API. Публичные staging/production ещё не развёрнуты: адреса в примерах — заглушки, сервер и DNS не выбраны. Проверка на компьютере использует отдельные контейнеры и синтетические данные.

| Окружение | Конфигурация | Интерфейс и API | Данные и секреты |
| --- | --- | --- | --- |
| Local | `compose.yaml` + `.env.example`, Vite отдельно | `http://localhost:5173`, proxy к API `:8000` | Существующий локальный проект/volume |
| Staging | `compose.production.yaml` + `.env.staging.example`, `-p armeniabus-staging` | Один HTTPS-домен staging | Собственные PostgreSQL, Redis, volumes и три новых секрета |
| Production | `compose.production.yaml` + `.env.production.example`, `-p armeniabus-production` | Один HTTPS-домен продукта | Независимые PostgreSQL, Redis, volumes и секреты |

Staging использует `APP_ENV=production`: Secure cookie, закрытая документация API, строгие проверки секретов/hosts и те же образы, что планируются для выпуска. Отдельного ослабленного режима приложения для staging нет. Примеры предполагают **разные серверы** для staging и production: одинаковые опубликованные 80/443 на одном IP конфликтуют. Разные project names изолируют ресурсы Compose, но не заменяют отдельные серверы/права доступа и не изолируют опубликованные порты.

## Сборка и маршрутизация

`deploy/frontend.Dockerfile` собирает UI через Node.js 24 / `npm ci` / TypeScript / Vite. В финальном образе остаются Caddy, конфигурация и статические файлы `dist`; Node.js и dev server для обслуживания сайта не нужны. Отдельный Docker ignore исключает `.env*`, локальные зависимости, test-results и рабочие каталоги из frontend build context. Секреты не передаются через build args или `VITE_*`.

Оба окружения используют одну пару release tags: `APP_IMAGE` для API/workers и `WEB_IMAGE` для frontend/proxy. Код frontend работает с относительным `/api/v1`; переключение окружения не требует сборки с другими API URL. Caddyfile включён в образ, поэтому изменение маршрутизации требует новой сборки WEB_IMAGE.

- `https://APP_DOMAIN/api` и `/api/*` проксируются в FastAPI с сохранением префикса и Host. Ошибка/404 API не превращается в HTML приложения.
- `/assets/*` обслуживает только реальные файлы: отсутствующий JS получает 404. Существующие файлы с хешем Vite кэшируются `immutable` на год.
- Клиентские пути (`/login`, `/bookings/...`, `/carrier/...`) получают `index.html`, включая прямое открытие и reload. HTML не кэшируется (`no-store`).
- `/docs`, `/redoc`, `/openapi.json`, dotfiles, `/src/*` и `/node_modules/*` закрыты на proxy. Runtime API тоже не публикует документацию.
- Сайт получает CSP с JS/connect/font только со своего origin, запрет встраивания, `nosniff`, `no-referrer` и HSTS. Inline CSS разрешён для стилей React, inline JS — нет. Переход по ссылке оплаты во внешний сервис остаётся обычной навигацией.
- Только Caddy публикует порты. API доверяет forwarded headers только от `PROXY_IP`. Диапазон динамических адресов `EDGE_DYNAMIC_RANGE` должен находиться внутри `EDGE_SUBNET` и **исключать** статический адрес proxy. Так API не занимает адрес proxy при запуске.

После выпуска новой сборки уже открытая вкладка может запросить удалённый старый JS-модуль. F10 показывает ручное обновление страницы. Хранение ассетов предыдущих releases/CDN ещё не реализовано.

## Подготовка окружения

Скопировать соответствующий example в защищённый файл **вне репозитория**. Задать реальный `APP_DOMAIN` без схемы/пути/порта и release tags обоих образов. Сгенерировать отдельные случайные hex-значения для POSTGRES_PASSWORD, POSTGRES_APP_PASSWORD и JWT_SECRET_KEY (например, по 32 случайных байта). Не переносить секреты и реальные персональные данные из production в staging.

В D1 `API_DOMAIN` заменён на `APP_DOMAIN`: теперь это домен всего сайта. `CORS_ORIGINS` и `PAYMENT_RETURN_URL` вычисляются из него; старые отдельные значения из env больше не используются этим шаблоном. Browser-auth проверяет точный origin; после смены домена проверить вход/refresh/выход. Платёжный return URL — `/payment/result` на том же сайте, конкретную бронь добавляет backend.

Проверка/первый запуск на подготовленном staging-сервере:

```powershell
docker compose -p armeniabus-staging -f compose.production.yaml --env-file /secure/staging.env config --quiet
docker compose -p armeniabus-staging -f compose.production.yaml --env-file /secure/staging.env build api proxy
docker compose -p armeniabus-staging -f compose.production.yaml --env-file /secure/staging.env up -d --wait db redis
docker compose -p armeniabus-staging -f compose.production.yaml --env-file /secure/staging.env run --rm migrate
docker compose -p armeniabus-staging -f compose.production.yaml --env-file /secure/staging.env up -d --wait api worker payment-worker notification-worker proxy
```

Для production выбрать его env и имя проекта; для **уже существующего** стека сохранять прежнее имя проекта, иначе Compose создаст другие volumes. Не запускать `down --volumes` для постоянных окружений. При обновлении сначала выполнить backup/restore-check по [инструкции B10](hardening-and-operations.md). Init SQL применяется только к пустому volume; изменение env не меняет пароль существующей роли PostgreSQL.

Заполненный env доступен администраторам Docker: файловые права обязательны, внешнее secret-хранилище пока не подключено. Не публиковать вывод обычного `docker compose config` — он раскрывает подставленные секреты; использовать `config --quiet`. Переменные shell имеют приоритет над env-файлом: запускать из контролируемого окружения, не смешивать staging/production exports.

Публичный TLS по умолчанию выдаётся через ACME: нужны DNS и доступные 80/443, реальный выпуск сертификата здесь не выполнялся. `TLS_ISSUER=internal` предназначен только для изолированной локальной проверки, не для публичного сайта. `PROXY_BIND`, `HTTP_PORT`, `HTTPS_PORT`, `ORIGIN_PORT_SUFFIX` используются smoke-проверкой для loopback-портов; в обычном staging/production оставить стандартные 80/443 и пустой suffix. При нестандартном mapping локальный HTTP redirect указывает на обычный HTTPS 443; smoke открывает HTTPS-адрес напрямую.

PAYMENTS_ENABLED и NOTIFICATIONS_ENABLED остаются false. Ключи тестового магазина/провайдера писем, внешний webhook и проверка доставляемости относятся к D3; изменение окружения не включает их автоматически. У staging пока нет внешнего IP allowlist/VPN/basic-auth барьера — настроить доступ на целевом сервере до размещения непубличных данных.

## Изолированная проверка полного стека

Нужны Docker Compose, Python 3.12+, Node.js 24, `npm ci` в frontend и браузер Playwright:

```powershell
cd frontend
npm ci
npx playwright install chromium
cd ..
python scripts/deployment_smoke.py
```

Для установленного Edge добавить `$env:PLAYWRIGHT_CHANNEL = 'msedge'`. Скрипт создаёт уникальный проект `armeniabus-deployment-smoke-...`, генерирует временные секреты в памяти, собирает два образа, проверяет Caddy, применяет миграции в новой БД, запускает API/три worker/proxy и браузерные тесты. В `finally` удаляет только свой проект, его БД и локальный CA. Рабочий `.env` и основной проект не используются. При принудительном завершении всего процесса проверить оставшиеся ресурсы по напечатанному имени проекта; не удалять чужие проекты.

Порты 18080/18443 и подсеть 172.30.90.0/24 должны быть свободны. Сертификат выдан временным CA Caddy, его корень не устанавливается в ОС. Playwright игнорирует проверку сертификата только в отдельной конфигурации с фиксированным loopback-target `armeniabus.localhost:18443`. Проверки создают синтетического пассажира и проверяют реальные register/login/refresh/logout, Secure/HttpOnly/SameSite cookie, CSRF, CSP, SPA reload, asset cache и закрытые/несуществующие пути. `--skip-build` допустим для повтора с уже собранными `deployment-smoke` images после изменения только Compose/тестов; после изменения кода/Caddyfile повторить сборку.

CI получил отдельный deployment-smoke job. Это локальная проверка сборки/связности окружения, не публикация образов или автоматический deploy. D2 ещё должен описать и реализовать доставку release, процедуру обновления и отката. Проверки F10 в Firefox/WebKit остаются открытыми.

Проверка D1: собраны API и frontend/Caddy images, миграции 0001–0010 применены на новой БД, API и три worker прошли healthchecks. Три HTTPS browser smoke-теста в Edge и 50 unit-тестов прошли; TypeScript/build, ESLint, Prettier, Ruff и обе Compose-конфигурации проходят. Временный проект и volumes удалены. Полный набор 112 UI E2E из F10 в этом этапе повторно не запускался; удалённый CI и публичные DNS/ACME не проверялись. В предварительных прогонах исправлены конфликт статического IP, конфликт встроенного шрифта с CSP и заголовки кэширования.

Источники решений: [Caddy SPA/API patterns](https://caddyserver.com/docs/caddyfile/patterns), [TLS issuer](https://caddyserver.com/docs/caddyfile/directives/tls), [Compose project isolation](https://docs.docker.com/compose/how-tos/project-name/), [env precedence](https://docs.docker.com/compose/how-tos/environment-variables/variable-interpolation/).
