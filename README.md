# ArmeniaBus

Веб-платформа автобусных поездок между Россией и Арменией. Разработка идёт по этапам из документов `ArmeniaBus_Final_PreDevelopment_Package.docx` и `ArmeniaBus_MVP_Full_Architecture_and_Development_Plan.docx`. Выполнены **B1: технический фундамент** и **B2: пользователи и авторизация**. Рейсы, бронирование и оплата пока не реализованы.

## Локальный запуск

Нужны Docker Desktop с запущенным Linux Engine и Docker Compose. Для локальной разработки:

```powershell
Copy-Item .env.example .env
docker compose up --build -d
docker compose run --rm api alembic upgrade head
Invoke-RestMethod http://localhost:8000/api/v1/health/live
Invoke-RestMethod http://localhost:8000/api/v1/health/ready
```

OpenAPI доступен по адресу `http://localhost:8000/docs`. PostgreSQL и Redis не публикуют порты наружу. API доступен только на `127.0.0.1:8000`. Значения в `.env.example` предназначены исключительно для локальной разработки.

## Авторизация

API этапа B2: `POST /api/v1/auth/register`, `POST /api/v1/auth/login`, `POST /api/v1/auth/refresh`, `POST /api/v1/auth/logout`, `GET /api/v1/me`. Регистрация допускает роли `PASSENGER` и `CARRIER`. Пользователь с ролью `CARRIER` пока не может создавать автобусы: профиль и активация перевозчика относятся к B3. Самостоятельная регистрация `ADMIN` запрещена.

Access token действует 15 минут и передаётся как `Authorization: Bearer ...`. Refresh token обновляется при каждом использовании; его хеш хранится в БД, старый токен отзывается. Logout отзывает refresh token. Уже выданный access token остаётся действительным до своего срока истечения, если пользователь не заблокирован. Пароли хешируются Argon2; API не принимает и не хранит карточные данные.

## Проверки

На Python 3.12+:

```powershell
python -m venv .venv
.venv\Scripts\python.exe -m pip install -e ".[dev]"
.venv\Scripts\python.exe -m ruff check src tests migrations
.venv\Scripts\python.exe -m pytest
```

Интеграционный тест с реальными PostgreSQL и Redis запускается в отдельном контейнере:

```powershell
docker compose --profile test build test
docker compose --profile test run --rm test
```

## Следующий этап

B3 добавит профили перевозчиков, активацию, автобусы и места. Затем B4–B5 добавят рейсы и поиск. Правила бронирования и оплаты из документов будут реализованы на backend; текущий API не имитирует покупку.

Детальный порядок работ и состояние этапов: [docs/roadmap.md](docs/roadmap.md).
