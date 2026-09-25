# ArmeniaBus web — F1–F6

Основа интерфейса по утверждённой концепции: светлый фон, lavender/blue accents, Manrope, мягкие карточки, иллюстрация дороги/гор и адаптивная вёрстка. Иллюстрация — собственный SVG, шрифт поставляется локально через npm; внешние font/image CDN при просмотре не нужны.

F1 содержит app shell, публичные страницы, навигацию и UI-компоненты. F2 добавляет регистрацию PASSENGER/CARRIER, вход, профили, защищённые маршруты и cookie session flow. F3 добавляет поиск реальных рейсов, цену, доступность и пагинацию. F4 добавляет страницу рейса, выбор свободного места и обновление доступности. F5 добавляет удержание, таймер, отмену и список своих броней для восстановления после потери ответа. F6 добавляет подготовку оплаты, переход к ЮKassa и проверку результата, включая неопределённый ответ и возврат после входа. Backend этих операций существует; данные рейсов и статусы оплаты не имитируются.

## Запуск

Node.js 24 и работающий backend на `127.0.0.1:8000`:

```powershell
cd frontend
npm ci
npm run dev
```

Открыть [localhost:5173](http://localhost:5173/). Сервер слушает только loopback. `strictPort` предотвращает незаметный переход на другой порт.

Маршруты: `/`, `/search`, `/trips/:id`, `/carriers`, `/help`, `/register`, `/login`; приватные `/bookings`, `/bookings/:id`, `/bookings/:id/payment`, `/payment/result?booking=UUID`, `/trips/:id/book?seat=UUID` (PASSENGER), `/account`, `/carrier` (CARRIER), `/admin` (ADMIN, только подтверждение роли до F9). Остальные — 404. `/design-system` доступен только в development: компоненты и настоящий `/api/v1/health/ready`. Он не входит в production bundle.

Vite проксирует `/api` к backend, поэтому клиент работает с same-origin адресами `/api/v1`. API должен быть запущен отдельно через корневой Docker Compose. При будущей публикации frontend сервер должен отдавать `index.html` для клиентских маршрутов и отдельно проксировать `/api`; такой публичный frontend deployment ещё не настроен. `vite preview` — просмотр сборки, не production-сервер.

## Структура и границы

- `src/app` — routing, shell, QueryClient, error boundary, CSS tokens/layout.
- `src/pages` — публичные страницы и development-only showcase.
- `src/features/payments` — контракт платежа, проверка ссылки, ключ попытки и состояния результата; экран в `src/pages/PaymentPage.tsx`.
- `src/features/bookings` — контракт брони и серверный таймер; страницы подтверждения/деталей/списка в `src/pages/BookingPages.tsx`.
- `src/features/trips` — проверка деталей/мест, предварительный выбор и сверка его доступности.
- `src/features/search` — форма, параметры URL, проверка ответа поиска, UTC и точное форматирование цен.
- `src/features/auth` — Session, provider, role guards и проверка контрактов user/access.
- `src/shared/ui` — кнопки/ссылки, label/input с hint/error, сообщения состояний, заголовки и SVG.
- `src/shared/api` — fetch-клиент и тип ошибки. Сохраняет HTTP status, code, request_id и details; HTML ошибок proxy и низкоуровневые сетевые сообщения не выдаёт пользователю.

CSS использует слои и переменные; компоненты не привязаны к конкретным сущностям бронирования. QueryClient создаётся на экземпляр приложения. Данные сервера не объявляются финальными на основании локального состояния. Повтор запросов отключён по умолчанию, особенно для мутаций; retry следует задавать для конкретного безопасного чтения.

Клиент поддерживает отмену и timeout 10 секунд. Cookie отправляется только при явном `credentials: same-origin` в browser-auth transport. Access хранится в памяти, refresh — в HttpOnly-cookie; токены не сохраняются в localStorage/sessionStorage. F6 хранит в localStorage только ключ идемпотентности оплаты, привязанный к пользователю/брони. `Session.request` передаёт Bearer, объединяет refresh и повторяет GET после 401 максимум один раз. Logout/смена аккаунта очищают приватные данные. Обычный refresh одного пользователя не очищает QueryClient. Generic TypeScript type не заменяет runtime-валидацию; auth/carrier/search/trips/bookings/payments её выполняют. Подробный контракт и ограничения: [browser-auth.md](../docs/browser-auth.md).

Доступность: semantic landmarks/headings, skip-link, focus после перехода страницы, клавиатурное меню с Escape, видимые focus states, связанный label/hint/error, reduced-motion. Реализована responsive-база для desktop/tablet/mobile, но полный cross-browser и screen-reader аудит относится к F10.

## Проверки

```powershell
npm run lint
npm run format:check
npm test
npm run build
npx playwright install chromium
npm run test:e2e
```

Playwright использует отдельный порт 5174 и изолированные browser contexts. Базовые shell-проверки: desktop/mobile переходы, FAQ, прямой reload маршрута, 404, widths 320/768/1024, Escape в меню, axe на главной, управляемый отказ/восстановление API в showcase. Эти базовые проверки не изменяют данные. Снимки/trace находятся в игнорируемом `test-results`.

Добавлены UI-проверки регистрации обеих ролей, ошибок входа, прав и выхода между вкладками. По умолчанию они используют управляемые ответы. Live E2E с `RUN_AUTH_E2E=1` выполняет настоящие register/login/refresh/logout, публикацию рейса и изменение доступности через hold/отмену в отдельном Compose project; запуск и очистка описаны в [browser-auth.md](../docs/browser-auth.md). `API_PROXY_TARGET` задаёт только серверную цель Vite proxy, не попадает в browser bundle. Локальные API и test API не следует смешивать.

Если CDN браузеров недоступен и установлен Microsoft Edge, локально можно использовать поддерживаемый Playwright channel:

```powershell
$env:PLAYWRIGHT_CHANNEL = 'msedge'
npm run test:e2e
Remove-Item Env:PLAYWRIGHT_CHANNEL
```

CI устанавливает Chromium и выполняет lint, форматирование, unit, production build и браузерные тесты. Версии зависимостей закреплены в package.json/package-lock.json; установка — `npm ci`. Перед обновлением проверять advisories и прогонять тесты. `npm audit` на момент первичной установки не обнаружил известных уязвимостей; это не гарантия их отсутствия.

Локальная проверка F1: 4 unit-теста API-клиента и 6 браузерных тестов прошли; TypeScript/build, ESLint и Prettier проходят. Браузер — установленный Microsoft Edge (Chromium download с CDN завершился timeout), desktop и mobile emulation. Скриншоты обоих размеров просмотрены. Главная проходит автоматический axe-check. Настоящий readiness через Vite proxy возвращает `ok`; отказ и восстановление отдельно проверены управляемыми ответами в E2E. CI-конфигурация добавлена, удалённый GitHub Actions запуск не выполнялся.

Выбор стека: [Vite](https://vite.dev/guide/), [React Router declarative mode](https://reactrouter.com/start/declarative/installation), [TanStack Query](https://tanstack.com/query/latest/docs/framework/react/installation). SSR в F1 не реализован; отдельного Node API/BFF и дублирования бизнес-правил FastAPI нет.

Поиск F3 и его ограничения описаны в [frontend-search.md](../docs/frontend-search.md). Локально проверены 16 unit-тестов и 24 браузерных сценария (desktop/mobile Edge), включая 6 сценариев с настоящим API. TypeScript/build, ESLint и Prettier проходят. Удалённый CI не запускался.

Страница рейса и выбор места F4 описаны в [frontend-trips.md](../docs/frontend-trips.md). Проверены 22 unit-теста и 32 браузерных сценария desktop/mobile Edge, включая 6 с настоящим API. Три desktop live-сценария первого прогона превысили таймауты при нагрузке на Docker; отдельный последовательный повтор прошёл. Скриншоты и axe проверены, TypeScript/build, ESLint и Prettier проходят.

F5: подтверждение удержания, серверный таймер, отмена и восстановление потерянного ответа описаны в [frontend-bookings.md](../docs/frontend-bookings.md). Проверены 143 backend-теста, 26 unit-тестов frontend и 42 браузерных сценария desktop/mobile Edge, включая 6 с настоящим API. Найденная ошибка семантики заголовка статуса исправлена; повтор затронутых проверок прошёл. В полном backend-прогоне остаются два предупреждения о deprecated API Starlette/AnyIO. Схема БД остаётся 0010; для `server_time` и `hold_only` нужен обновлённый API.

F6: [подготовка оплаты и проверка результата](../docs/frontend-payments.md). Проверены 144 backend-теста, 31 unit-тест frontend и 54 браузерных сценария desktop/mobile Edge: 36 прежних сценариев, 12 новых платёжных и 6 live-сценариев в отдельном Compose project. Live-проверка включает выключенную оплату без создания Payment и без потери удержания. Backend-прогон сохраняет два предупреждения Starlette/AnyIO; TypeScript/build, ESLint, Ruff и Prettier проходят. Скриншоты desktop/mobile и axe проверены. Настоящий магазин не подключён, внешние списания не выполнялись, PAYMENTS_ENABLED остаётся false. Backend обновлён без миграции; схема 0010.
