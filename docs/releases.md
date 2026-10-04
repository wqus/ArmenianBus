# D2: выпуск и обновление

Реализованы ручной GitHub Actions workflow выпуска, manifest неизменяемой пары API/web, обновление существующего Compose-стека с окном недоступности и ограниченный откат кода. Публикация в GHCR и запуск на внешнем сервере пока не выполнялись. Первое создание окружения описано в [environments.md](environments.md).

## Выпуск

Запустить **Release images** (`workflow_dispatch`) на `main`. Workflow сначала вызывает полный CI: backend, frontend и браузеры, HTTPS smoke и учебное обновление/откат. После успешных проверок собирает API и web с одинаковой OCI-меткой Git SHA, проверяет именно эту пару через HTTPS и публикует её в GHCR. Теги включают SHA, run ID и номер попытки. `release.json` содержит digest каждого опубликованного образа и точную Alembic revision; deploy не принимает изменяемые теги.

Workflow использует `GITHUB_TOKEN` с `packages: write` только в publish job. Для чтения приватных образов на сервере нужен отдельный доступ `read:packages`; пароль передавать Docker через `--password-stdin`, не записывать в команды, репозиторий или журналы. См. [документацию GHCR](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry).

Артефакт `release-<SHA>-<run>-<attempt>` сохраняется на 90 дней: manifest, production Compose, overlay и Caddyfile для существующего Nginx, init SQL shell и Python-утилиты. Сохранить проверенный артефакт и журнал выпуска в защищённом хранилище на принятый срок поддержки. Не выполнять произвольные manifests из непроверенного источника: digest фиксирует содержимое, но сам по себе не удостоверяет автора. Базовые образы пока используют теги; повторная сборка того же SHA не гарантирует те же байты. На production переносится та же проверенная в staging пара digest без пересборки.

## Подготовка сервера

Нужны Docker Compose v2 с `up --wait`, Python 3.12+, работающий стек D1, доступ к registry и публичному HTTPS origin. Текущий workflow собирает Linux/amd64; ARM-серверы требуют отдельной сборки и проверки. Разместить содержимое артефакта в постоянном каталоге с сохранением структуры; `scripts` и `deploy` находятся рядом с `compose.production.yaml`. Не перемещать этот каталог в течение окна отката: Compose разрешает bind mounts относительно него.

Секретный env-файл, Compose project name, Docker context и каталог `release-state/<environment>` должны быть отдельными для staging и production. Ограничить ACL/права каталога состояния: dump содержит пользовательские данные. Утилита не шифрует архивы. Включить независимое защищённое резервное копирование вне этого сервера. Освободить место для backup, временной восстановленной БД и двух поколений образов. Не удалять прежние локальные image IDs до завершения окна отката.

Окружение процесса имеет приоритет над env-файлом. Запускать из чистой административной сессии с нужным Docker context, без случайных POSTGRES/SMTP/APP_DOMAIN переменных. `APP_IMAGE` и `WEB_IMAGE` утилита задаёт из manifest. Один lock-файл в каталоге env сериализует операции для project; не запускать другие Compose-команды параллельно. Это локальная защита, не распределённая блокировка нескольких серверов.

## Обновление существующего staging

Из корня распакованного артефакта (пример путей сервера):

```sh
python scripts/release_deploy.py apply --project armeniabus-staging --env-file /secure/staging.env --manifest release.json --state release-state/staging/release-001.json
python scripts/release_deploy.py apply --project armeniabus-staging --env-file /secure/staging.env --manifest release.json --state release-state/staging/release-001.json --execute
```

Первая команда лишь выводит план, не проверяет сервер и не вызывает Docker. Вторая выполняет операцию. Для каждого обновления нужен новый путь журнала; существующий не перезаписывается. Все журналы одного окружения хранятся в одном каталоге, рядом с общим `active.env`.

Порядок выполнения:

1. Проверить Compose, получить образы по digest, сверить обе метки SHA и единственный Alembic head. Сохранить предыдущие image IDs, текущую revision, Docker daemon ID и хеш конфигурации (без записи её значений).
2. Остановить proxy, затем API и три worker. В течение обслуживания сайт и webhook недоступны; заранее согласовать окно, учитывать сроки удержания брони и повторную доставку webhook.
3. Создать новый PostgreSQL dump и проверить его восстановление в отдельной временной БД, включая revision, ограничения и индексы. При ошибке не выполнять миграцию.
4. Выполнить `alembic upgrade <release revision>` с ролью владельца и проверить достигнутую revision. Запустить API/workers и дождаться healthchecks, затем proxy.
5. Проверить публичные HTTPS readiness и HTML приложения с проверкой сертификата. Сохранить выбранные образы в `active.env`, отметить журнал `complete`.

После обновления для ручных операций Compose использовать оба env-файла; второй фиксирует текущие образы:

```sh
docker compose -p armeniabus-staging -f compose.production.yaml --env-file /secure/staging.env --env-file release-state/staging/active.env ps
```

На хосте с уже работающим Nginx при каждом `apply` и `rollback` дополнительно передавать `--compose-override compose.existing-nginx.yaml`. Для ручных Compose-команд тоже указывать этот второй файл после `compose.production.yaml`; одинаковая пара применяется к backup и restore-check. Первичную настройку такого хоста описывает [vps-existing-nginx.md](vps-existing-nginx.md).

Не запускать обычный `up` с устаревшими тегами из исходного env. Утилита обновления сама подставляет manifest, поэтому ей `active.env` не требуется. После приёмки staging повторить процедуру с тем же manifest, production project/env и отдельным каталогом состояния. Изменения env, Compose или схемы требуют отдельного плана совместимости; утилита не обновляет PostgreSQL/Redis и не выполняет zero-downtime deploy.

## Сбой и откат

При сбое после начала обслуживания приложение остаётся остановленным; автоматического восстановления БД или понижения схемы нет. Журнал сохраняет последнюю фазу (`prepared`, `backup`, `migration`, `starting`, `complete`). Проверить exit status, журнал, `compose ps -a`, ограниченные логи сервисов и фактическую revision БД. Не публиковать полный `compose config`: он содержит секреты. После аварийного завершения процесса lock может остаться; удалить его вручную только после проверки отсутствия активной операции.

Для отката к прежним локальным образам:

```sh
python scripts/release_deploy.py rollback --project armeniabus-staging --env-file /secure/staging.env --state release-state/staging/release-001.json
python scripts/release_deploy.py rollback --project armeniabus-staging --env-file /secure/staging.env --state release-state/staging/release-001.json --execute
```

Откат допускается только при прежней revision БД, неизменных конфигурации и Docker host и контейнерах, принадлежащих старому/целевому выпуску журнала. Это защищает от случайного применения устаревшего журнала. Сохраняются все записи, появившиеся после обновления. Проверка revision не доказывает семантическую совместимость кода: в рамках выпуска отдельно оценивать изменения формата данных и внешних эффектов.

Если schema revision изменилась, использовать исправляющий выпуск и движение вперёд после анализа миграции. Катастрофическое восстановление dump — отдельная ручная процедура из [hardening-and-operations.md](hardening-and-operations.md), с оценкой потери новых записей и сверкой платежей/уведомлений с внешними системами. Нельзя автоматически восстанавливать backup после уже совершённых платежей или отправок: это может повторить внешние действия. Не обходить защиту редактированием журнала.

## Локальная проверка

```powershell
$env:PLAYWRIGHT_CHANNEL = 'msedge' # либо установленный Playwright Chromium
python scripts/deployment_smoke.py --release-drill
```

Drill использует только уникальный временный Compose project, синтетические данные и выключенные платежи/SMTP. После трёх браузерных HTTPS-проверок создаёт два производных локальных образа с новыми IDs, применяет их через настоящий release helper, проверяет замену и откатывает код. Backup действительно восстанавливается в отдельную БД; HTTPS проверяется с временным CA без установки доверия в ОС. Это сценарий с неизменной схемой 0010; изменение схемы и запреты при сбоях проверяются unit-тестами. Окружение, архивы и временный CA удаляются после проверки. CI выполняет тот же drill.

Границы: удалённый workflow/GHCR, публичный TLS и deploy на сервер ещё не проверены. Firefox/WebKit QA остаётся открытым до успешного запуска соответствующих браузеров; выпуск в CI заблокирован, если эти проверки не проходят.

Проверка D2: 23 теста release/backup safety, три HTTPS browser smoke-теста в Edge и реальный цикл backup → restore-check → применение образов → HTTPS → возврат прежних image IDs прошли. Временный стек и volumes удалены; основной API/frontend отвечают 200. Ruff, формат новых Python-файлов, YAML parsing workflow и Git diff check проходят. Общий локальный Python-прогон до добавления последнего регрессионного теста: 70 passed, 92 DB-теста skipped. Проверки удалённого CI не запускались.
