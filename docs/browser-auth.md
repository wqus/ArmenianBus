# F2 — браузерная авторизация

Реализованы регистрация пассажира/перевозчика, вход, выход, восстановление сессии, профиль аккаунта, профиль компании и защищённые маршруты по ролям. Регистрация ADMIN через интерфейс отсутствует: администратор создаётся существующей CLI-командой. Поиск/бронирование и управление рейсами в UI относятся к следующим этапам.

## Маршруты интерфейса

- `/register`: PASSENGER или CARRIER; для компании нужны название и международный телефон. Перевозчик создаётся со статусом PENDING. После успешной регистрации предлагается войти; пароль не переносится между страницами и не сохраняется в storage.
- `/login`: вход, перевод типовых ошибок на русский, безопасный `next` только для известных приватных маршрутов.
- `/account`: текущая почта, роль, статус и выход. Информация приходит из `/me`.
- `/carrier`: только CARRIER, данные компании и её PENDING/ACTIVE/BLOCKED. Административная блокировка профиля не превращается в блокировку всего аккаунта.
- `/admin`: только ADMIN, подтверждение роли и ссылка на профиль; рабочий интерфейс администратора остаётся этапом F9.

Без сессии приватная страница переводит на вход. При временной недоступности проверки сессии показывается ошибка с повтором, а не сообщение об успешном выходе. Неподходящая роль получает страницу «Нет доступа»; backend независимо проверяет все права. Успешный выход очищает память и QueryClient, а другие открытые вкладки получают событие без токенов/персональных данных.

## Backend-контракт

Существующие JSON endpoints `/api/v1/auth/login`, `/refresh`, `/logout` сохранены для совместимости API/CLI. Браузер использует отдельный транспорт:

| Endpoint | Запрос | Результат |
| --- | --- | --- |
| POST `/api/v1/auth/web/login` | JSON email/password | access_token, token_type, expires_in; refresh только в Set-Cookie |
| POST `/api/v1/auth/web/refresh` | HttpOnly refresh cookie, без JSON-токена | ротация refresh и новый access |
| POST `/api/v1/auth/web/logout` | refresh cookie | 204, отзыв текущего refresh и удаление cookie |

Все три требуют `X-ArmeniaBus-Web: 1` и точного Origin из `CORS_ORIGINS`. `Sec-Fetch-Site: cross-site` также отклоняется. Нет доверия произвольному Host/Referer и нет wildcard-origin. Некорректный запрос получает `403 CSRF_REJECTED` до изменений сессии. CORS разрешает специальный заголовок только настроенным origins. Регистрация остаётся отдельным существующим POST `/auth/register`, который не использует cookie авторизации.

Production-cookie: `__Host-armeniabus_refresh`, HttpOnly, Secure, SameSite=Strict, Path=/, без Domain. Development на HTTP localhost: `armeniabus_refresh`, без Secure, остальные атрибуты сохранены. В JSON browser endpoints refresh никогда не возвращается. Ошибки истёкшего/отозванного refresh или заблокированного пользователя удаляют cookie; временная недоступность БД/rate limiter сохраняет её для повторной попытки. Вход заменяет и отзывает предыдущую refresh-сессию этого браузера после проверки новых учётных данных.

Браузерный транспорт использует существующие hashing, rotation, user locks и rate limit. Анонимный refresh без cookie возвращает 401 без расходования лимита refresh. Cookie сама по себе не авторизует `/me` и бизнесовые endpoints: им нужен Bearer access. Logout отзывает refresh, но уже выданный access может действовать до истечения (до 15 минут по текущим настройкам); блокировка пользователя проверяется backend на каждом запросе. Схема БД не менялась, ревизия остаётся 0010.

## Сессия во frontend

Access хранится только в памяти экземпляра `Session`. Токены не сохраняются в localStorage/sessionStorage. С F6 localStorage используется только для ключа попытки оплаты: [frontend-payments.md](frontend-payments.md). После reload браузер получает access по HttpOnly-cookie и загружает `/me`. Формат access/user/carrier проверяется во время исполнения.

Web Locks сериализует login/refresh/logout между вкладками одного origin; в пределах страницы refresh объединяется в один Promise. BroadcastChannel сообщает только login/logout. Номер поколения сессии отбрасывает запоздалые ответы после выхода/смены пользователя. QueryClient очищается при потере или смене авторизованного пользователя; обычный refresh того же пользователя и первоначальное анонимное открытие страницы не отменяют публичные запросы.

Перед авторизованным запросом access обновляется при приближении срока истечения. GET после 401 может быть повторён один раз после refresh; изменяющие запросы не повторяются автоматически. Автоматического бесконечного refresh/retry нет. Если ответ с ротированным cookie потерян в сети, возможен повторный вход: старый refresh уже отозван. Синхронизация вкладок действует в одном origin; не следует одновременно использовать один cookie-host через несколько frontend origins/портов. Для пользовательского запуска выбрать один постоянный адрес.

Нужен современный браузер с Web Locks, BroadcastChannel, AbortSignal.any/timeout; HTTPS в production, localhost в development. Нет fallback-хранения refresh в JavaScript. Восстановление пароля, email verification, MFA, редактирование профиля и отзыв всех сессий пользователем не входят в F2. Письма/платежи остаются выключены.

## Запуск и проверки

Для локального API задать CORS_ORIGINS с `http://localhost:5173` и, при использовании, `http://127.0.0.1:5173`. Vite проксирует `/api` на backend и сохраняет browser Origin. Новые endpoints требуют пересборки API:

```powershell
docker compose build api
docker compose up -d api worker payment-worker notification-worker
cd frontend
npm ci
npm run dev
```

Backend-тесты проверяют cookie flags, отсутствие refresh в JSON, ротацию/replay/logout, замену сессии, блокировку и CSRF без побочных изменений. Frontend unit-тесты проверяют параллельные refresh, поздние ответы, отсутствие повторной мутации и безопасный redirect. UI-тесты проверяют роли, формы, ошибки, reload и межвкладочный выход; axe применяется к странице входа на desktop/mobile.

Дополнительный live E2E использует **отдельный Compose project**, собственные PostgreSQL/Redis и API на loopback:8001. Он создаёт только синтетических пользователей в этой временной БД. Backend основных тестов и локальная рабочая БД не затрагиваются. Из корня репозитория:

```powershell
docker compose -p armeniabus-auth-e2e --profile test build api-e2e test
docker compose -p armeniabus-auth-e2e --profile test run --rm test alembic upgrade head
docker compose -p armeniabus-auth-e2e --profile test up -d --wait api-e2e
cd frontend
$env:API_PROXY_TARGET = 'http://127.0.0.1:8001'
$env:RUN_AUTH_E2E = '1'
# Если Chromium уже установлен через npx playwright install chromium, следующий override не нужен.
$env:PLAYWRIGHT_CHANNEL = 'msedge'
npm run test:e2e
Remove-Item Env:API_PROXY_TARGET, Env:RUN_AUTH_E2E, Env:PLAYWRIGHT_CHANNEL
cd ..
docker compose -p armeniabus-auth-e2e --profile test down --volumes
```

Не подменять имя проекта на рабочий при очистке. Без RUN_AUTH_E2E live-тесты пропускаются. CI frontend запускает их с изолированным API; удалённый CI не запускался из этой рабочей среды. При запуске с уже работающим Vite на 5174 остановить именно тестовый сервер перед сменой API_PROXY_TARGET, чтобы не переиспользовать чужую конфигурацию.

Источники решений: [OWASP CSRF Prevention](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html), [MDN secure cookies](https://developer.mozilla.org/en-US/docs/Web/Security/Practical_implementation_guides/Cookies), [MDN Web Locks](https://developer.mozilla.org/en-US/docs/Web/API/Web_Locks_API). SameSite дополняет проверку Origin/заголовка; HttpOnly не заменяет защиту от XSS.

Проверка 2026-09-23: полный backend-прогон 141 passed; frontend 11 unit-тестов; 14 браузерных сценариев на desktop/mobile, из них 4 с настоящим API и PostgreSQL в изолированном окружении. Локально использован Microsoft Edge через Playwright. Проверены отсутствие refresh в JSON/document.cookie/storage, ротация при одновременном reload двух вкладок, межвкладочный выход и PENDING перевозчика. Скриншоты desktop/mobile формы входа просмотрены; axe-check главной и входа проходит. Публичный production, реальная почта/платежи и удалённый CI не запускались.
