# ArmeniaBus

Веб-платформа автобусных поездок между Россией и Арменией. Разработка идёт по этапам из документов `ArmeniaBus_Final_PreDevelopment_Package.docx` и `ArmeniaBus_MVP_Full_Architecture_and_Development_Plan.docx`. Реализован backend B1–B9 и базовая эксплуатационная подготовка B10: авторизация, перевозчики, автобусы, рейсы, поиск, бронирование, платежи, API кабинетов, уведомления, административные операции, защита API и диагностика. Реализован frontend F1–F10 (браузерная проверка Firefox/WebKit ещё не завершена): дизайн-система, публичные страницы, регистрация, вход, сессия и профили с доступом по ролям. Реализован публичный поиск рейсов с ценами и доступностью. Добавлена страница рейса с выбором свободного места. Работают создание удержания, таймер, отмена и восстановление брони после потери ответа. Добавлены подготовка оплаты, переход к ЮKassa и проверка результата по API. Кабинет пассажира показывает предстоящие поездки, историю, платежи и возвраты; оплаченная отмена доступна по правилам сервера. Кабинет перевозчика позволяет управлять автобусами и рейсами, просматривать брони своих пассажиров. Администратору доступны инспекция, активация перевозчиков, блокировки, операционные действия, аудит и обзор очередей. Платежи и отправка писем по умолчанию выключены; проверки с реальным тестовым магазином и SMTP требуют настройки. Production ещё не запущен.

## Локальный запуск

Нужны Docker Desktop с запущенным Linux Engine и Docker Compose. Для локальной разработки:

```powershell
Copy-Item .env.example .env
docker compose build api worker payment-worker notification-worker
docker compose run --rm api alembic upgrade head
docker compose up -d
Invoke-RestMethod http://localhost:8000/api/v1/health/live
Invoke-RestMethod http://localhost:8000/api/v1/health/ready
```

OpenAPI доступен по адресу `http://localhost:8000/docs`. PostgreSQL и Redis не публикуют порты наружу. API доступен только на `127.0.0.1:8000`. Значения в `.env.example` предназначены исключительно для локальной разработки.

## Авторизация

API авторизации: `POST /api/v1/auth/register`, `POST /api/v1/auth/login`, `POST /api/v1/auth/refresh`, `POST /api/v1/auth/logout`, `GET /api/v1/me`. Регистрация допускает роли `PASSENGER` и `CARRIER`. Для `CARRIER` обязательны `company_name` и `phone` в международном формате, например `+37499123456`. Пользователь и профиль `PENDING` создаются одной транзакцией. Самостоятельная регистрация `ADMIN` запрещена.

Access token действует 15 минут и передаётся как `Authorization: Bearer ...`. Refresh token обновляется при каждом использовании; его хеш хранится в БД, старый токен отзывается. Logout отзывает refresh token. Уже выданный access token остаётся действительным до своего срока истечения, если пользователь не заблокирован. Пароли хешируются Argon2; API не принимает и не хранит карточные данные.

## Frontend

При запущенном backend и установленном Node.js 24:

```powershell
cd frontend
npm ci
npm run dev
```

Интерфейс: [localhost:5173](http://localhost:5173/). Доступны поиск на главной и `/search`, страницы `/trips/{uuid}`, `/trips/{uuid}/book?seat={uuid}`, `/bookings` и `/bookings/{uuid}`, `/register`, `/login`, `/account` и `/carrier`, а также публичные страницы. Браузер получает refresh в HttpOnly-cookie, access хранится только в памяти. `/design-system` показывает компоненты и состояние соединения с API только в development. Инструкции: [frontend/README.md](frontend/README.md); контракт и проверки F2: [docs/browser-auth.md](docs/browser-auth.md); поиск F3: [docs/frontend-search.md](docs/frontend-search.md); места F4: [docs/frontend-trips.md](docs/frontend-trips.md); бронирование F5: [docs/frontend-bookings.md](docs/frontend-bookings.md); оплата F6: [docs/frontend-payments.md](docs/frontend-payments.md); кабинет F7: [docs/frontend-passenger-cabinet.md](docs/frontend-passenger-cabinet.md); кабинет перевозчика F8: [docs/frontend-carrier-cabinet.md](docs/frontend-carrier-cabinet.md); администрирование F9: [docs/frontend-admin.md](docs/frontend-admin.md); устойчивость и доступность F10: [docs/frontend-hardening.md](docs/frontend-hardening.md).

## Перевозчики и автобусы

Создание администратора выполняется локальной командой. Пароль вводится скрыто и не передаётся в аргументах процесса; существующий пользователь не будет изменён:

```powershell
docker compose run --rm api python -m armeniabus.cli create-admin --email admin@example.com
```

Администратор входит через обычный `/auth/login`, просматривает `/api/v1/admin/carriers` и активирует профиль через `PATCH /api/v1/admin/carriers/{id}/status`. Активный перевозчик может создавать, просматривать, переименовывать и архивировать свои автобусы через `/api/v1/buses`. Номера мест и вместимость фиксируются при создании; архивирование сохраняет записи мест. Блокировка профиля закрывает доступ к операциям с автобусами. Статусы и изменения сохраняются в `audit_log` в той же транзакции.

API-сценарий и ограничения этапа: [docs/carriers-and-buses.md](docs/carriers-and-buses.md).

## Рейсы

Активный перевозчик создаёт рейс в статусе `DRAFT` через `POST /api/v1/routes`, просматривает свои рейсы через `GET /api/v1/routes/my`, детали через `GET /api/v1/routes/my/{id}` и управляет отдельным рейсом через `PATCH/DELETE /api/v1/routes/{id}`. Эти операции доступны только владельцу-перевозчику.

Направления задаются свободными названиями точек с кодами стран `RU` и `AM`. Время должно включать часовой пояс и хранится в UTC. Цена передаётся десятичной строкой, например `"4500.50"`, и сохраняется как PostgreSQL `NUMERIC`, валюта — RUB. Автобус должен принадлежать перевозчику и быть неархивным; владение закреплено также внешним ключом БД.

Жизненный цикл: `DRAFT → ACTIVE → DEPARTED → COMPLETED`, либо `ACTIVE → CANCELLED`. `DELETE` архивирует черновик или отменяет активный рейс, сохраняя историю. Автобус нельзя архивировать, пока на нём есть неархивные `DRAFT/ACTIVE/DEPARTED` рейсы. Контракт и примеры: [docs/routes.md](docs/routes.md).

## Публичный поиск и места

Без авторизации доступны `GET /api/v1/routes/search?origin=Ростов-на-Дону&destination=Гюмри&date=2030-06-01`, `GET /api/v1/routes/{id}` и `GET /api/v1/routes/{id}/seats`. Поиск сравнивает полные названия без учёта регистра; дата означает день UTC. Есть пагинация, цена, название перевозчика/автобуса и число свободных мест. Выдача скрывает непубличные и прошедшие рейсы, архивные автобусы и заблокированных перевозчиков.

Доступность вычисляется по бронированиям конкретного рейса и времени PostgreSQL: `FREE`, `HELD`, `PAID`. Просроченный hold не занимает место даже при задержке worker. Показ свободного места не гарантирует успешный последующий POST: транзакция бронирования может вернуть `409`. Контракт и ограничения даты: [docs/search-and-availability.md](docs/search-and-availability.md).

## Бронирование и hold

Пассажир создаёт удержание через `POST /api/v1/bookings` с `route_id` и `seat_id`, просматривает `/bookings/my` и `/bookings/{id}`, отменяет неоплаченный hold через `DELETE /bookings/{id}`. Цена фиксируется сервером. Hold действует 10 минут (настраивается), максимум до отправления. После первой брони критические поля рейса закрываются для редактирования.

PostgreSQL блокировки и уникальный индекс защищают от двойной продажи; Redis для этого не требуется. Compose запускает отдельный `worker`, который переводит просроченные удержания в EXPIRED. Разовый запуск: `docker compose run --rm worker python -m armeniabus.worker --once`. Оплаченный билет отменяется не менее чем за 24 часа до отправления (настраивается), с заявкой на ручной возврат. Контракт: [docs/bookings.md](docs/bookings.md).

## Платежи

`POST /api/v1/bookings/{id}/pay` требует токен владельца и `Idempotency-Key: UUID`. Сумма берётся из Booking. `GET /api/v1/bookings/{id}/payment` показывает состояние. Webhook `/api/v1/webhooks/payments` проверяется запросом к YooKassa; redirect не подтверждает оплату. Отдельный `payment-worker` восстанавливает состояние после потерянного уведомления.

Без `PAYMENTS_ENABLED=true` и ключей магазина оплата возвращает `503 PAYMENTS_DISABLED`. Тесты работают с имитацией провайдера. Позднее списание не восстанавливает истёкшую бронь: платёж получает отметку ручного возврата. Настройка тестового магазина, HTTPS webhook, ограничения чеков и статусы: [docs/payments.md](docs/payments.md).

## Кабинеты и уведомления

`GET /api/v1/cabinet/bookings` показывает поездки пассажира, `/api/v1/carriers/me/bookings` — бронирования собственных рейсов перевозчика. Доступны фильтры истории/предстоящих поездок, статуса и пагинация; DTO содержит номер места, данные поездки, оплату и признак заявки на возврат. Администратору доступен `/api/v1/admin/refund-cases`.

Отмена PAID и рейса создаёт заявку на ручной возврат; подтверждённый платёж остаётся SUCCEEDED. Письма об оплате/отмене сохраняются в той же транзакции в outbox. `notification-worker` выполняет доставку с повторами через SMTP over TLS. По умолчанию `NOTIFICATIONS_ENABLED=false`: письма накапливаются, но не отправляются. Границы ручного возврата и гарантии доставки: [docs/cabinets-and-notifications.md](docs/cabinets-and-notifications.md).

## Администрирование

ADMIN видит пользователей, перевозчиков, рейсы, брони, платежи, уведомления и аудит через `/api/v1/admin`. Доступны блокировка аккаунта с отзывом refresh-сессий, операционная отмена ACTIVE рейса, проверка платежа через GET провайдера, запись результата ручного возврата и повтор FAILED-уведомлений. Эти действия проверяют состояние под блокировкой и сохраняют аудит. Результат возврата записывает оператор; API не перечисляет деньги. Контракт и ограничения: [docs/admin-operations.md](docs/admin-operations.md).

## Проверки

На Python 3.12+:

В PyCharm отметьте каталог `src` как **Sources Root** и выберите интерпретатор `.venv`. Пакет импортируется как `armeniabus`, без префикса `src`. Иначе Python может загрузить модели дважды, а запуск установленного пакета и миграций завершится ошибкой. Ruff проверяет единообразие импортов.

```powershell
python -m venv .venv
.venv\Scripts\python.exe -m pip install -r requirements-dev.lock
.venv\Scripts\python.exe -m pip install --no-deps -e .
.venv\Scripts\python.exe -m pip check
.venv\Scripts\python.exe -m ruff check src tests migrations scripts
.venv\Scripts\python.exe -m pytest
```

Интеграционные тесты запускаются в контейнере с отдельными PostgreSQL и Redis. Миграции применяются автоматически. Тестовая БД хранится в памяти контейнера; рабочая БД не используется. Тестовый runner отказывается работать с БД, имя которой не заканчивается на `_test`:

```powershell
docker compose --profile test build test
docker compose --profile test run --rm test
```

## Следующий этап

B10: добавлены ограничения запросов, безопасные журналы, диагностика worker/очередей, индексы административных списков, фиксация зависимостей, backup/restore-check и отдельный production-шаблон с Caddy. Инструкции и проверенные границы: [docs/hardening-and-operations.md](docs/hardening-and-operations.md).

F1–F7 реализованы. Далее F8: кабинет перевозчика, управление автобусами и рейсами, просмотр броней. Рабочий UI администратора относится к F9. Подключение тестового магазина YooKassa, реальная SMTP-доставка и публичный запуск остаются отдельными работами после настройки окружения.

Детальный порядок работ и состояние этапов: [docs/roadmap.md](docs/roadmap.md).
