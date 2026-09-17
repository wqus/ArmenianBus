# ArmeniaBus web — F1

Основа интерфейса по утверждённой концепции: светлый фон, lavender/blue accents, Manrope, мягкие карточки, иллюстрация дороги/гор и адаптивная вёрстка. Иллюстрация — собственный SVG, шрифт поставляется локально через npm; внешние font/image CDN при просмотре не нужны.

F1 содержит app shell, публичные информационные страницы, навигацию, UI-компоненты и основу API-клиента. Вход, регистрация, поиск реальных рейсов, бронирование и оплата в этом интерфейсе ещё не реализованы. Backend этих операций уже существует. Данные рейсов/статусы оплаты в F1 не имитируются.

## Запуск

Node.js 24 и работающий backend на `127.0.0.1:8000`:

```powershell
cd frontend
npm ci
npm run dev
```

Открыть [localhost:5173](http://localhost:5173/). Сервер слушает только loopback. `strictPort` предотвращает незаметный переход на другой порт.

Маршруты: `/` — главная, `/carriers` — информация для перевозчиков, `/help` — вопросы о бронировании, остальные — страница 404. `/design-system` доступен только в development: состояния кнопок/полей/уведомлений, загрузка и проверка настоящего `/api/v1/health/ready`. Он не входит в production bundle.

Vite проксирует `/api` к backend, поэтому клиент работает с same-origin адресами `/api/v1`. API должен быть запущен отдельно через корневой Docker Compose. При будущей публикации frontend сервер должен отдавать `index.html` для клиентских маршрутов и отдельно проксировать `/api`; такой публичный frontend deployment ещё не настроен. `vite preview` — просмотр сборки, не production-сервер.

## Структура и границы

- `src/app` — routing, shell, QueryClient, error boundary, CSS tokens/layout.
- `src/pages` — публичные страницы и development-only showcase.
- `src/shared/ui` — кнопки/ссылки, label/input с hint/error, сообщения состояний, заголовки и SVG.
- `src/shared/api` — fetch-клиент и тип ошибки. Сохраняет HTTP status, code, request_id и details; HTML ошибок proxy и низкоуровневые сетевые сообщения не выдаёт пользователю.

CSS использует слои и переменные; компоненты не привязаны к конкретным сущностям бронирования. QueryClient создаётся на экземпляр приложения. Данные сервера не объявляются финальными на основании локального состояния. Повтор запросов отключён по умолчанию, особенно для мутаций; retry следует задавать для конкретного безопасного чтения.

Клиент поддерживает отмену запроса и timeout 10 секунд, не отправляет cookie и не сохраняет токены. F2 должен добавить согласованный с backend session flow и protected routes. Для защищённого cookie-based refresh потребуется изменение текущего backend-контракта; хранение refresh token в localStorage не добавлено. Generic TypeScript return type не заменяет runtime-валидацию новых ответов — её необходимо задавать в соответствующей feature.

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

Playwright использует отдельный порт 5174 и изолированные browser contexts. Проверки: desktop/mobile переходы, FAQ, прямой reload маршрута, 404, widths 320/768/1024, Escape в меню, axe на главной, управляемый отказ/восстановление API в showcase. Бизнесовые API-запросы не выполняются. Снимки/trace находятся в игнорируемом `test-results`.

Если CDN браузеров недоступен и установлен Microsoft Edge, локально можно использовать поддерживаемый Playwright channel:

```powershell
$env:PLAYWRIGHT_CHANNEL = 'msedge'
npm run test:e2e
Remove-Item Env:PLAYWRIGHT_CHANNEL
```

CI устанавливает Chromium и выполняет lint, форматирование, unit, production build и браузерные тесты. Версии зависимостей закреплены в package.json/package-lock.json; установка — `npm ci`. Перед обновлением проверять advisories и прогонять тесты. `npm audit` на момент первичной установки не обнаружил известных уязвимостей; это не гарантия их отсутствия.

Локальная проверка F1: 4 unit-теста API-клиента и 6 браузерных тестов прошли; TypeScript/build, ESLint и Prettier проходят. Браузер — установленный Microsoft Edge (Chromium download с CDN завершился timeout), desktop и mobile emulation. Скриншоты обоих размеров просмотрены. Главная проходит автоматический axe-check. Настоящий readiness через Vite proxy возвращает `ok`; отказ и восстановление отдельно проверены управляемыми ответами в E2E. CI-конфигурация добавлена, удалённый GitHub Actions запуск не выполнялся.

Выбор стека: [Vite](https://vite.dev/guide/), [React Router declarative mode](https://reactrouter.com/start/declarative/installation), [TanStack Query](https://tanstack.com/query/latest/docs/framework/react/installation). SSR в F1 не реализован; отдельного Node API/BFF и дублирования бизнес-правил FastAPI нет.
