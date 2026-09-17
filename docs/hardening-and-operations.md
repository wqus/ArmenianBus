# B10 — защита и эксплуатация backend

Реализована базовая эксплуатационная подготовка. Это не подтверждение готовности публичного production: домен, сервер, реальные интеграции, внешние оповещения, резервное хранилище и нагрузочные цели ещё требуют настройки.

## API и журналы

- Тело запроса ограничено 64 KiB (`REQUEST_MAX_BYTES`, от 1 KiB до 1 MiB). Проверяются и Content-Length, и фактически полученные данные, включая chunked. Превышение возвращает 413; некорректный размер — 400. Загрузка тела ограничена 10 секундами (`REQUEST_BODY_TIMEOUT_SECONDS`), после чего возвращается 408. Это API JSON, загрузки файлов в MVP нет.
- `ALLOWED_HOSTS` ограничивает HTTP Host. В production обязательны явно заданный публичный host, HTTPS CORS origins, длинный JWT-секрет и пароль БД. Проверка длины/состава секрета не заменяет генерацию случайного значения.
- Ответы получают `no-store`, `nosniff`, запрет iframe и `no-referrer`; в production — HSTS. `/docs`, `/redoc` и `/openapi.json` в production отключены. Локальная документация сохранена.
- Входящий X-Request-ID принимается только при длине 1–128 и символах `A-Z a-z 0-9 . _ -`; иначе создаётся UUID. Журнал запроса содержит метод, шаблон маршрута, HTTP-код, длительность и request ID. Query string, фактический ID в пути, Authorization и тело запроса не записываются.
- Uvicorn access log отключён в контейнере, httpx/httpcore ограничены WARNING. JSON-formatter исключает значения исключений и строки исходного кода из traceback. Это защита контролируемых приложением сообщений, а не универсальная фильтрация любого стороннего logger: новые записи не должны включать секреты/персональные данные.
- Защита от массового трафика, лимиты соединений и внешний WAF не реализованы. Существующий Redis rate limit защищает auth endpoints. До публичного запуска нужны измерение нагрузки и подходящие лимиты на внешнем периметре.

## Диагностика

`GET /api/v1/health/live` проверяет процесс, `/api/v1/health/ready` — доступность PostgreSQL и Redis. `GET /api/v1/admin/operations/health` требует ADMIN и возвращает:

- worker `holds`, `payments`, `notifications`: `OK`, `DISABLED`, `MISSING`, `STALE`, `ERROR`, последнее выполнение/успех, число обработанных записей, безопасное имя класса ошибки;
- количество просроченных HELD, ожидающих сверки платежей, платежей для ручной проверки, открытых возвратов, FAILED и ожидающих доставки уведомлений;
- время самого старого ожидающего уведомления. Ожидающие уведомления могут включать запись с действующей lease — это размер накопившейся работы, не число свободных задач.

Heartbeat хранится в PostgreSQL после каждого batch. При ошибке последнее успешное время сохраняется; после следующего успешного batch ошибка очищается. Даже выключенный worker должен сообщать о себе. Порог STALE — 600 секунд (`WORKER_STALE_SECONDS`); при увеличении batch/таймаутов его нужно согласовать с максимальным временем цикла. Модель предназначена для одного экземпляра каждого worker: при нескольких репликах общий heartbeat не обнаружит отказ одной из них.

```powershell
docker compose ps
docker compose exec worker python -m armeniabus.healthcheck holds
docker compose exec payment-worker python -m armeniabus.healthcheck payments
docker compose exec notification-worker python -m armeniabus.healthcheck notifications
docker compose logs --since 10m api worker payment-worker notification-worker
```

Docker healthcheck возвращает ошибку для MISSING/STALE/ERROR или недоступной БД. `DISABLED` — исправно запущенный выключенный обработчик. Статус unhealthy сам по себе не перезапускает контейнер и не отправляет оповещения. При отключённых SMTP/платежах соответствующая очередь может ожидаемо расти. Автоматически включать интеграцию при этом нельзя.

Перед запуском подключить внешний монитор: readiness, состояния worker, возраст очереди, FAILED-уведомления/платежи для проверки и свободное место БД/архивов. Пороги и получателя оповещений согласовать с эксплуатацией. Встроенного Prometheus/Grafana и доставки алертов пока нет.

## Запросы и миграции

`0010` добавляет worker_heartbeats и индексы сортировки административных списков пользователей, аудита, платежей, броней, уведомлений и рейсов; отдельный частичный индекс обслуживает платежи с review_reason. Интеграционный EXPLAIN ANALYZE на 20 000 синтетических событий проверяет использование индекса аудита для последних 20 записей. Это проверка плана одного запроса, не нагрузочный benchmark всего продукта.

Списки ограничены пагинацией. Счётчики очередей и общий COUNT административной выдачи всё ещё зависят от объёма данных; при росте нужны отдельные измерения и, при необходимости, агрегирование/кэширование.

Индексы создаются обычным CREATE INDEX в транзакционной миграции: на большой рабочей БД это блокирует запись на время построения. Применять в согласованное окно, предварительно проверив время на копии данных. Downgrade проверяется только на изолированной тестовой БД. В рабочем окружении перед миграцией выполнить backup и restore-check.

## Зависимости и сборка

`requirements.lock` и `requirements-dev.lock` фиксируют версии установленных прямых и транзитивных Python-зависимостей для Python 3.12/Linux. Docker и CI используют их, затем устанавливают пакет с `--no-deps`. Слой зависимостей кэшируется отдельно от кода. CI выполняет pip check, Ruff, миграции, проверку моделей, тесты и сборку.

Это снимок версий без hashes. Базовые Docker images и build dependencies ещё не закреплены digest/hash; сборка не заявляется полностью воспроизводимой. Обновлять зависимости отдельным изменением с тестами и проверкой актуальных security advisories. Автоматического сканера уязвимостей и подписи образов пока нет.

## Резервное копирование и проверка восстановления

Скрипт `scripts/database_backup.py` использует pg_dump custom archive и pg_restore внутри работающего PostgreSQL-контейнера. Бинарный поток передаётся напрямую subprocess, без текстового перенаправления PowerShell. Нужны Python 3.12+ и Docker Compose.

```powershell
python scripts/database_backup.py backup backups/before-0010.dump
python scripts/database_backup.py restore-check backups/before-0010.dump --expected-revision 0009
```

После обновления схемы ожидаемая ревизия — `0010`. Для production-шаблона явно выбрать compose/env и то же имя проекта, что использовалось при запуске:

```powershell
python scripts/database_backup.py backup backups/release.dump --compose-file compose.production.yaml --env-file /secure/armeniabus.env --project-name armeniabus
python scripts/database_backup.py restore-check backups/release.dump --compose-file compose.production.yaml --env-file /secure/armeniabus.env --project-name armeniabus --expected-revision 0010
```

Backup отказывается перезаписывать существующий файл; рядом создаётся manifest с SHA-256, размером и временем. При неудаче может остаться частичный файл без manifest: не считать его пригодной копией, повторить с новым именем. `restore-check` проверяет checksum до доступа к БД, создаёт отдельную БД с автоматически сгенерированным именем `armeniabus_<id>_restorecheck`, восстанавливает в одной транзакции, проверяет ревизию, валидность ограничений/индексов и выводит счётчики основных таблиц. Временная БД удаляется в finally; существующие БД не очищаются. При аварийном завершении процесса временная БД может остаться — проверить её назначение перед ручным удалением. Не запускать одновременные тяжёлые drill без оценки места/нагрузки.

Требуются права создания БД, поэтому команды выполняются от POSTGRES_USER внутри DB-контейнера. Приложение таких прав не имеет. Восстанавливать только доверенные архивы. SHA-256 выявляет случайное повреждение, но не подтверждает подлинность архива при замене архива вместе с manifest.

Архив содержит персональные данные и хеши паролей: каталог закрыть правами ОС, хранить вне Git, шифровать и копировать в отдельное защищённое хранилище. `.gitignore` не является защитой доступа. Автоматическое расписание, retention, шифрование, offsite-копии и PITR не настроены. Выбрать RPO/RTO, расписание копирования и регулярный drill до запуска.

Скрипт намеренно не заменяет рабочую БД. Аварийное переключение выполняется оператором: остановить запись API/workers, сохранить текущую БД, восстановить доверенный архив в новую БД, проверить схему/данные/права приложения, переключить DATABASE_URL и повторить readiness/сверку платежей. После восстановления outbox может повторить доставку; денежное состояние нужно сверять с провайдером. Roles, SMTP/payment credentials и TLS-данные не входят в pg_dump и должны иметь отдельную процедуру восстановления.

## Production-шаблон

Использовать **отдельный** `compose.production.yaml`, не объединять его с development compose. Начальная конфигурация: `.env.production.example`. Хранить заполненный env-файл вне репозитория с ограниченными правами. Сгенерировать три независимых случайных секрета; для паролей БД использовать hex, чтобы не требовалось URL-encoding. Переменные окружения доступны администратору Docker — отдельное secret-хранилище пока не подключено.

Порядок после подготовки сервера, DNS, домена, секретов, firewall и резервного хранилища:

```powershell
docker compose -p armeniabus -f compose.production.yaml --env-file /secure/armeniabus.env config --quiet
docker compose -p armeniabus -f compose.production.yaml --env-file /secure/armeniabus.env build api
docker compose -p armeniabus -f compose.production.yaml --env-file /secure/armeniabus.env up -d db redis
docker compose -p armeniabus -f compose.production.yaml --env-file /secure/armeniabus.env run --rm migrate
docker compose -p armeniabus -f compose.production.yaml --env-file /secure/armeniabus.env up -d api worker payment-worker notification-worker proxy
```

APP_IMAGE должен обозначать проверенный release, не плавающий development tag. В дальнейшем предпочтительна доставка проверенного образа из registry. На обновлении сначала проверить backup, применить миграции сервисом migrate, затем пересоздать приложения из нового образа.

- Только Caddy публикует 80/443; API/БД/Redis не публикуют порты. DNS должен указывать на сервер, 80/443 доступны для TLS issuance. Реальный сертификат в этой работе не выпускался.
- Uvicorn доверяет forwarded headers только конкретному адресу Caddy в отдельной edge-сети; не заменять его на `*`. При конфликте подсети изменить EDGE_SUBNET и PROXY_IP согласованно. Если добавляется CDN/proxy перед Caddy, отдельно настроить доверенные адреса и проверить защиту от подделки IP.
- Приложения запускаются не от root, с read-only root filesystem, ограничением памяти/процессов, без Linux capabilities и с no-new-privileges. `/tmp` — ограниченный tmpfs. Docker журналы ротируются.
- `deploy/init-app-db.sh` создаёт runtime-роль `armeniabus_app` без superuser/CREATEDB и права DML через default privileges. DDL выполняет только сервис migrate от владельца. Init-script действует **только на новом пустом PostgreSQL volume**; на существующем требуется отдельное создание роли/GRANT на существующие таблицы оператором. Не удалять volume ради применения init-script. Изменение пароля в env также не меняет существующую роль автоматически.
- Redis используется для вспомогательных функций, доступен только внутри backend-сети. Компрометация сервера/Docker или приложения остаётся отдельным риском; этот шаблон не реализует сетевую изоляцию между всеми доверенными внутренними сервисами.
- PAYMENTS_ENABLED и NOTIFICATIONS_ENABLED по умолчанию false. Перед включением — настроить тестовый магазин/HTTPS webhook и SMTP, выполнить внешние интеграционные проверки; перед live-платежами завершить бизнес-настройки продавца и фискализации.

Проверка 2026-09-17: production-шаблон запущен локально без proxy и опубликованных портов, на отдельном временном volume с синтетическими данными; миграции прошли, API и три worker здоровы. Проверены отсутствие superuser/CREATEDB/CREATE schema у runtime-роли и её доступ к таблицам. Caddy прошёл `validate`, но публичные DNS/TLS и работа на целевом VPS не проверялись. Выполнен backup/restore drill с одной синтетической записью пользователя, ревизией 0010, без невалидных ограничений/индексов.

Автоматические проверки: основной прогон — 128 passed; дополнительно 4 passed для безопасности backup-скрипта. После добавления схемы ответа мониторинга повторно прошли его 3 интеграционных теста и 4 теста backup. Миграция 0010 прошла upgrade → downgrade 0009 → upgrade на тестовой БД; `alembic check` не обнаружил расхождений моделей. Ruff и Compose config проходят. Два предупреждения deprecation относятся к связке Starlette/httpx/AnyIO в TestClient.

Официальные справочники: [pg_dump](https://www.postgresql.org/docs/17/app-pgdump.html), [pg_restore](https://www.postgresql.org/docs/17/app-pgrestore.html), [Compose services](https://docs.docker.com/reference/compose-file/services/), [Caddy automatic HTTPS](https://caddyserver.com/docs/automatic-https), [Caddy reverse proxy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy).
