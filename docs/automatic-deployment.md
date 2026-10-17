# Автоматический CI/CD

Push в `main` запускает `Release images`: CI, сборку API/web, HTTPS-проверку этой пары,
публикацию в GHCR и затем SSH-деплой. PR и другие ветки выполняют CI без деплоя.
Ручной `Run workflow` остаётся для повторного выпуска. Repository variable
`PRODUCTION_DEPLOY_ENABLED=true` включается один раз после подготовки VPS и Secrets;
пока её нет, только deploy job пропускается. Подтверждение каждого выпуска не требуется.

## Серверная процедура

Постоянные пути: `/opt/armeniabus/current` — файлы выпуска,
`/opt/armeniabus/shared/production.env` — секреты,
`/opt/armeniabus/release-state/production` — журналы, backup и active.env.
Compose project всегда `armeniabus`; bind mounts не перемещаются между выпусками.

Первый `init` разрешён только без контейнеров проекта, PostgreSQL volume и истории
установки. Создаёт БД/Redis, мигрирует схему, запускает приложение и проверяет HTTPS.
Старой БД для backup нет. Частичный init поверх оставшихся данных не повторяется.
Последующий `apply` проверяет digest/SHA, останавливает ingress и writers, делает dump
и проверку восстановления в отдельную временную БД, миграции, запуск и HTTPS-проверку.
PostgreSQL/Redis при обычном обновлении приложения сохраняются.

Backup создаётся при каждом **деплое**, включая frontend-only изменения, а не при
каждом push. CI failure не меняет VPS. Workflow concurrency и host lock сериализуют
обновления. SSH проверяет заранее доверенный ключ VPS; StrictHostKeyChecking не отключается.
Краткоживущий job-scoped GITHUB_TOKEN с packages:read передаётся по stdin и используется
во временном Docker config, удаляемом при выходе. Постоянный registry PAT для автодеплоя
не нужен. Env и его значения в bundle/лог не попадают.

Deploy получает артефакт по ID из output job `publish`. Повтор только упавших jobs
использует прежний проверенный bundle, даже если `run_attempt` уже изменился.
Файлы bundle не содержат секретов и распаковываются с правами 644, несмотря на
приватную umask SSH-сессии: PostgreSQL читает bind mount скрипта от своего UID.
Корневая директория выпуска остаётся закрытой, а `shared/production.env` сохраняет
права 600 и не входит в bundle. CI проверяет фактическую распаковку под umask 077.

## Ограниченный пилот

В `/opt/armeniabus/shared/deployment-profile` записать `pilot`. Используются три файла:
production → existing-nginx → pilot. Для семи постоянных контейнеров суммарные потолки
памяти — 832 МиБ, CPU — 0,9 ядра; каждому задан отдельный лимит и запрет swap.
PostgreSQL/Redis настроены под уменьшенные бюджеты. Первый запуск требует MemAvailable
не ниже 896 МиБ после подготовки образов. Если памяти временно меньше, первый запуск
ожидает до 180 секунд, затем отказывает до создания контейнеров и журнала установки.
Порог и лимиты памяти сохраняются; другие приложения не останавливаются.
Пилот принудительно использует test YooKassa;
при первоначальной настройке платежи и письма выключены.

Лимиты ограничивают новый стек, но не гарантируют запас для роста чужих приложений или
production-нагрузку. CI включает первый запуск и браузерную проверку пилота под лимитами.
Worker healthcheck читает heartbeat напрямую через asyncpg, без повторной загрузки
FastAPI/ORM. Это сохраняет проверку свежести и ошибок при небольшом CPU-бюджете.
В пилоте timeout worker healthcheck — 30 секунд, startup grace — 60 секунд:
ограничение CPU замедляет даже импорт Python. Проверка запроса к БД ограничена 5 секундами.
После деплоя печатается потребление контейнеров. При OOM/restarts выяснить причину и
скорректировать ресурсы после проверки. Для production отдельно увеличить ресурсы и
поменять профиль; это изменение конфигурации влияет на возможность отката.

## Однократная настройка

1. На Windows создать отдельную пару Ed25519 `~/.ssh/armeniabus_actions` без passphrase
   для Actions. Личный ключ `ben` не использовать. Private key добавляется только в
   GitHub Secret; на VPS переносится public `.pub`.
2. В PowerShell:

   ```powershell
   scp "$env:USERPROFILE\.ssh\armeniabus_actions.pub" D:\Python_project\ArmenianBus\scripts\prepare_ci_vps.py armeniabus:
   ```

3. На VPS в сессии ben:

   ```sh
   sudo python3 ~/prepare_ci_vps.py --public-key ~/armeniabus_actions.pub
   ```

   Скрипт проверяет Docker/VPN-подсети и IP Nginx, создаёт пользователя `armeniabus-ci`,
   директории, независимые случайные пароли БД/JWT в файле 600 и профиль pilot.
   Секреты не печатает, существующий env не перезаписывает, контейнеры не запускает.
   Docker group даёт этому техническому пользователю административные возможности
   на обычном Docker-хосте. SSH key с `restrict`: без PTY/forwarding, с SCP/SFTP и
   неинтерактивными командами. Это отдельный доступ, а не изоляция Docker от хоста.
4. Если в SSH настроен AllowUsers, добавить armeniabus-ci, сохранив ben. Проверить
   `sudo /usr/sbin/sshd -t` перед reload ssh. Проверить новый доступ с компьютера:
   `ssh armeniabus-ci "docker info --format '{{.ServerVersion}}'"` (при настроенном alias).
5. В HTTPS-блоке bus убрать return 503/default_type/Retry-After и подключить proxy
   с динамическим Docker DNS из [vps-existing-nginx.md](vps-existing-nginx.md).
   До запуска приложения 502 ожидаем. Проверить nginx -t, reload и Cloudflare Full (strict).
   До открытого пилота восстановить реальный клиентский IP: доверять CF-Connecting-IP
   только официальным Cloudflare подсетям и передавать remote_addr/X-Forwarded-For.
6. GitHub → Settings → Secrets and variables → Actions → repository Secrets:

   | Secret | Значение |
   | --- | --- |
   | DEPLOY_HOST | 95.81.100.204 |
   | DEPLOY_USER | armeniabus-ci |
   | DEPLOY_PORT | 22 (необязателен) |
   | DEPLOY_SSH_PRIVATE_KEY | Полное содержимое локального armeniabus_actions |
   | DEPLOY_SSH_KNOWN_HOSTS | Уже доверенная запись ключа VPS из локального known_hosts |

   Для host key использовать запись `ssh-keygen -F 95.81.100.204`, не свежий непроверенный
   ssh-keyscan. Private key не присылать в чат. Environment approvals/платный GitHub
   environment для этой базовой схемы не нужны.
7. Добавить repository Variable PRODUCTION_DEPLOY_ENABLED=true. Запустить Release images
   на main; последующие push в main запускают всю цепочку самостоятельно.

## Проверка и восстановление

Успех: Automatic deployment completed, публичный сайт/вход/бронирование работают,
контейнеры healthy, нет OOM/restarts. Для ручных операций сохранять все три файла:

```sh
cd /opt/armeniabus/current
docker compose -p armeniabus -f compose.production.yaml -f compose.existing-nginx.yaml -f compose.pilot.yaml --env-file /opt/armeniabus/shared/production.env --env-file /opt/armeniabus/release-state/production/active.env ps
```

Отказ проверки памяти до создания журнала разрешает повтор после появления запаса RAM.
Сбой отмечается failed, неполный журнал блокирует следующий деплой. Проверить фазу,
контейнеры и revision; не редактировать фазу для обхода защиты и не удалять volumes.
Автоматического восстановления БД/downgrade нет: платежи и новые данные требуют сверки.
Rollback кода допускается только при совместимой неизменённой схеме/конфигурации.
Окно недоступности при обновлении сохраняется. Dump на том же VPS не защищает от потери
VPS: внеплощадочные копии, retention и оповещения настраиваются отдельно перед production.

Источники: [GitHub Secrets](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets),
[GHCR](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry),
[Docker memory/CPU](https://docs.docker.com/engine/containers/resource_constraints/).
