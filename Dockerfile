FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONPATH=/app/src

WORKDIR /app
COPY pyproject.toml alembic.ini ./
COPY src ./src
COPY migrations ./migrations
RUN pip install --no-cache-dir .
RUN useradd --create-home --uid 10001 appuser
USER appuser

EXPOSE 8000
CMD ["uvicorn", "armeniabus.main:app", "--host", "0.0.0.0", "--port", "8000"]
