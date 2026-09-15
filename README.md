# ArmeniaBus

Веб-платформа автобусных поездок между Россией и Арменией. Разработка идёт по этапам из документов `ArmeniaBus_Final_PreDevelopment_Package.docx` и `ArmeniaBus_MVP_Full_Architecture_and_Development_Plan.docx`. Текущий этап — **B1: технический фундамент**. Пользователи, рейсы, бронирование и оплата пока не реализованы.

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

## Проверки

На Python 3.12+:

```powershell
python -m venv .venv
.venv\Scripts\python.exe -m pip install -e ".[dev]"
.venv\Scripts\python.exe -m ruff check src tests migrations
.venv\Scripts\python.exe -m pytest
```

## Следующий этап

B2: `User`, регистрация и вход, хеширование паролей, access/refresh lifecycle, роли и ownership. Затем B3–B5 добавят перевозчиков, автобусы, рейсы и поиск. Правила бронирования и оплаты из документов будут реализованы на backend; текущий фундамент не содержит имитации оплаты или бронирования.

Детальный порядок работ и состояние этапов: [docs/roadmap.md](docs/roadmap.md).
