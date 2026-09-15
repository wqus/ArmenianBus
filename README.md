# ArmeniaBus

Веб-платформа автобусных поездок между Россией и Арменией. Разработка идёт по этапам из документов `ArmeniaBus_Final_PreDevelopment_Package.docx` и `ArmeniaBus_MVP_Full_Architecture_and_Development_Plan.docx`. Реализованы фундамент, авторизация и этап B3: профили перевозчиков, активация, автобусы и места. Рейсы, бронирование и оплата пока не реализованы.

## Локальный запуск

Нужны Docker Desktop с запущенным Linux Engine и Docker Compose. Для локальной разработки:

```powershell
Copy-Item .env.example .env
docker compose build api
docker compose run --rm api alembic upgrade head
docker compose up -d
Invoke-RestMethod http://localhost:8000/api/v1/health/live
Invoke-RestMethod http://localhost:8000/api/v1/health/ready
```

OpenAPI доступен по адресу `http://localhost:8000/docs`. PostgreSQL и Redis не публикуют порты наружу. API доступен только на `127.0.0.1:8000`. Значения в `.env.example` предназначены исключительно для локальной разработки.

## Авторизация

API авторизации: `POST /api/v1/auth/register`, `POST /api/v1/auth/login`, `POST /api/v1/auth/refresh`, `POST /api/v1/auth/logout`, `GET /api/v1/me`. Регистрация допускает роли `PASSENGER` и `CARRIER`. Для `CARRIER` обязательны `company_name` и `phone` в международном формате, например `+37499123456`. Пользователь и профиль `PENDING` создаются одной транзакцией. Самостоятельная регистрация `ADMIN` запрещена.

Access token действует 15 минут и передаётся как `Authorization: Bearer ...`. Refresh token обновляется при каждом использовании; его хеш хранится в БД, старый токен отзывается. Logout отзывает refresh token. Уже выданный access token остаётся действительным до своего срока истечения, если пользователь не заблокирован. Пароли хешируются Argon2; API не принимает и не хранит карточные данные.

## Перевозчики и автобусы

Создание администратора выполняется локальной командой. Пароль вводится скрыто и не передаётся в аргументах процесса; существующий пользователь не будет изменён:

```powershell
docker compose run --rm api python -m armeniabus.cli create-admin --email admin@example.com
```

Администратор входит через обычный `/auth/login`, просматривает `/api/v1/admin/carriers` и активирует профиль через `PATCH /api/v1/admin/carriers/{id}/status`. Активный перевозчик может создавать, просматривать, переименовывать и архивировать свои автобусы через `/api/v1/buses`. Номера мест и вместимость фиксируются при создании; архивирование сохраняет записи мест. Блокировка профиля закрывает доступ к операциям с автобусами. Статусы и изменения сохраняются в `audit_log` в той же транзакции.

API-сценарий и ограничения этапа: [docs/carriers-and-buses.md](docs/carriers-and-buses.md).

## Проверки

На Python 3.12+:

```powershell
python -m venv .venv
.venv\Scripts\python.exe -m pip install -e ".[dev]"
.venv\Scripts\python.exe -m ruff check src tests migrations
.venv\Scripts\python.exe -m pytest
```

Интеграционные тесты запускаются в контейнере с отдельными PostgreSQL и Redis. Миграции применяются автоматически. Тестовая БД хранится в памяти контейнера; рабочая БД не используется. Тестовый runner отказывается работать с БД, имя которой не заканчивается на `_test`:

```powershell
docker compose --profile test build test
docker compose --profile test run --rm test
```

## Следующий этап

B4 добавит рейсы, динамические направления РФ ↔ Армения, жизненный цикл и правила изменения рейсов. На B5 появятся поиск и доступность мест. При добавлении рейсов будут введены ограничения на архивацию автобусов с действующими рейсами.

Детальный порядок работ и состояние этапов: [docs/roadmap.md](docs/roadmap.md).
