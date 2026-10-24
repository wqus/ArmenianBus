import { expect, test, type BrowserContext } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'

const id = '11111111-1111-4111-8111-111111111111'
const seat = '22222222-2222-4222-8222-222222222222'
async function mock(context: BrowserContext) {
  const state = {
    role: 'CARRIER',
    profile: 'ACTIVE',
    signedIn: true,
    mode: 'ok',
    writes: [] as { method: string; path: string; body: Record<string, unknown> | null }[],
    reads: [] as string[],
    gate: null as Promise<void> | null,
    bus: {
      id,
      carrier_id: id,
      name: 'Тестовый автобус',
      capacity: 1,
      created_at: '2030-01-01T00:00:00Z',
      seats: [{ id: seat, seat_number: 1 }],
    },
    route: {
      id,
      carrier_id: id,
      bus_id: id,
      origin_country: 'RU',
      destination_country: 'AM',
      origin: 'Ростов',
      destination: 'Գյումրի',
      departure_at: '2030-03-01T12:00:00Z',
      price: '4500.50',
      currency: 'RUB',
      status: 'DRAFT',
      created_at: '2030-01-01T00:00:00Z',
    },
    archived: false,
  }
  const booking = () => ({
    id,
    route_id: id,
    bus_id: id,
    seat_id: seat,
    status: 'PAID',
    amount: '4500.50',
    currency: 'RUB',
    created_at: '2030-01-01T00:00:00Z',
    server_time: '2030-01-01T00:00:00Z',
    held_until: '2030-01-01T00:10:00Z',
    origin: 'Ростов',
    destination: 'Գյումրի',
    departure_at: state.route.departure_at,
    seat_number: 1,
    company_name: 'Перевозчик',
    route_status: state.route.status,
    cancellation_allowed: true,
    payment_status: 'SUCCEEDED',
    refund_status: null,
    refund_required: false,
  })
  await context.route('**/api/v1/**', async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      path = url.pathname.replace('/api/v1', ''),
      method = request.method()
    const reply = (json: unknown, status = 200) => route.fulfill({ json, status })
    const fail = (code: string, status = 409) => reply({ code, message: code }, status)
    if (path.endsWith('/web/login')) state.signedIn = true
    if (path.endsWith('/web/login') || path.endsWith('/web/refresh'))
      return state.signedIn
        ? reply({ access_token: 'mock-access', token_type: 'Bearer', expires_in: 900 })
        : fail('UNAUTHORIZED', 401)
    if (path === '/me')
      return reply({
        id,
        email: 'carrier@example.com',
        role: state.role,
        status: 'ACTIVE',
        created_at: '2030-01-01T00:00:00Z',
      })
    if (path === '/carriers/me')
      return reply({ company_name: 'Перевозчик', phone: '+37499123456', status: state.profile })
    if (method === 'GET') {
      state.reads.push(path + url.search)
      if (state.mode === 'read-error') return fail('UNAVAILABLE', 503)
      const offset = Number(url.searchParams.get('offset'))
      if (path === '/buses') {
        const buses = Array.from({ length: 22 }, (_, n) => ({
          ...state.bus,
          id: n === 0 ? id : `${String(n + 1).padStart(8, '0')}-1111-4111-8111-111111111111`,
          name: n === 0 ? state.bus.name : `Автобус ${n + 1}`,
        }))
        return reply({
          items: state.archived ? [] : buses.slice(offset, offset + 21),
          offset,
          limit: 21,
        })
      }
      if (path.startsWith('/buses/'))
        return state.archived || state.mode === 'foreign'
          ? fail('NOT_FOUND', 404)
          : reply({ ...state.bus, id: path.split('/').at(-1) })
      if (path === '/routes/my')
        return reply({
          items:
            state.archived ||
            (url.searchParams.get('status') &&
              url.searchParams.get('status') !== state.route.status)
              ? []
              : [state.route],
          offset,
          limit: 21,
        })
      if (path === `/routes/my/${id}`)
        return state.mode === 'foreign'
          ? fail('NOT_FOUND', 404)
          : reply(state.mode === 'invalid' ? { ...state.route, price: 123.45 } : state.route)
      if (path === '/carriers/me/bookings')
        return reply({
          items: url.searchParams.get('status') === 'EXPIRED' ? [] : [booking()],
          offset,
          limit: 21,
        })
      if (path === `/carriers/me/bookings/${id}`)
        return state.mode === 'foreign' ? fail('NOT_FOUND', 404) : reply(booking())
    } else {
      const body = method === 'DELETE' ? null : request.postDataJSON()
      state.writes.push({ method, path, body })
      if (state.gate) await state.gate
      if (path.startsWith('/buses') && method === 'POST') {
        Object.assign(state.bus, body)
        state.bus.seats = Array.from({ length: state.bus.capacity }, (_, n) => ({
          id: `${String(n + 1).padStart(8, '0')}-2222-4222-8222-222222222222`,
          seat_number: n + 1,
        }))
        return state.mode === 'lost' ? route.abort('failed') : reply(state.bus, 201)
      }
      if (path.startsWith('/buses/') && method === 'PATCH') {
        Object.assign(state.bus, body)
        return reply(state.bus)
      }
      if (path.startsWith('/buses/') && method === 'DELETE') {
        if (state.mode === 'locked') return fail('BUS_HAS_ROUTES')
        state.archived = true
        return route.fulfill({ status: 204 })
      }
      if (path === '/routes' && method === 'POST') {
        Object.assign(state.route, body)
        return reply(state.route, 201)
      }
      if (path === `/routes/${id}` && method === 'PATCH') {
        if (state.mode === 'locked') return fail('ROUTE_HAS_BOOKINGS')
        if (state.mode === 'transition') return fail('INVALID_ROUTE_TRANSITION')
        Object.assign(state.route, body)
        return state.mode === 'lost' ? route.abort('failed') : reply(state.route)
      }
      if (path === `/routes/${id}` && method === 'DELETE') {
        state.archived = true
        return route.fulfill({ status: 204 })
      }
    }
    return fail('NOT_FOUND', 404)
  })
  return state
}

test('carrier activation and role gates prevent operational requests', async ({
  page,
  context,
}) => {
  const state = await mock(context)
  for (const [status, text] of [
    ['PENDING', 'Ожидается активация'],
    ['BLOCKED', 'Операции приостановлены'],
  ]) {
    state.profile = status
    await page.goto('/carrier/buses/new')
    await expect(page.getByText(text, { exact: true })).toBeVisible()
    await expect(page.getByLabel('Название автобуса')).toHaveCount(0)
  }
  expect(state.reads).toEqual([])
  state.role = 'PASSENGER'
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Нет доступа', exact: true })).toBeVisible()
  expect(state.reads).toEqual([])
  state.role = 'CARRIER'
  state.profile = 'ACTIVE'
  state.signedIn = false
  await page.goto('/carrier/routes?status=DRAFT')
  await page.getByLabel('Электронная почта').fill('carrier@example.com')
  await page.getByLabel('Пароль', { exact: true }).fill('Carrier-Password-42!')
  await page.getByRole('button', { name: 'Войти', exact: true }).click()
  await expect(page).toHaveURL('/carrier/routes?status=DRAFT')
  await expect(page.getByRole('article')).toHaveCount(1)
})

test('bus capacity validation, single create, rename, archive conflict and confirmation', async ({
  page,
  context,
}) => {
  const state = await mock(context)
  await page.goto('/carrier/buses/new')
  await page.getByLabel('Название автобуса').fill('Новый автобус')
  await page.getByLabel('Количество мест').fill('101')
  await page.getByRole('button', { name: 'Создать автобус' }).click()
  await expect(page.getByRole('alert')).toContainText('от 1 до 100')
  expect(state.writes).toHaveLength(0)
  await page.getByLabel('Количество мест').fill('2')
  await page.getByRole('button', { name: 'Создать автобус' }).evaluate((el) => {
    ;(el as HTMLButtonElement).click()
    ;(el as HTMLButtonElement).click()
  })
  await expect(page).toHaveURL(`/carrier/buses/${id}`)
  expect(state.writes).toHaveLength(1)
  await expect(page.locator('.carrier-seat-list li')).toHaveCount(2)
  await expect(page.getByLabel('Количество мест')).toHaveCount(0)
  await page.getByLabel('Название автобуса').fill('Переименованный')
  await page.getByRole('button', { name: 'Сохранить название' }).click()
  await expect(page.getByRole('heading', { name: 'Переименованный' })).toBeVisible()
  expect(state.writes.at(-1)?.body).toEqual({ name: 'Переименованный' })
  state.mode = 'locked'
  await page.getByRole('button', { name: 'Архивировать автобус', exact: true }).click()
  await page.getByRole('button', { name: 'Оставить автобус' }).click()
  expect(state.writes).toHaveLength(2)
  await page.getByRole('button', { name: 'Архивировать автобус', exact: true }).click()
  await page.getByRole('button', { name: 'Да, архивировать автобус' }).click()
  await expect(page.getByRole('alert')).toContainText('незавершённых рейсах')
  state.mode = 'ok'
  await page.getByRole('button', { name: 'Архивировать автобус', exact: true }).click()
  await page.getByRole('button', { name: 'Да, архивировать автобус' }).click()
  await expect(page).toHaveURL('/carrier/buses')
  await expect(page.getByRole('article')).toHaveCount(0)
})

test('lost creation is not replayed and late completion cannot navigate away from a new page', async ({
  page,
  context,
}) => {
  const state = await mock(context)
  state.mode = 'lost'
  await page.goto('/carrier/buses/new')
  await page.getByLabel('Название автобуса').fill('Сохранённый')
  await page.getByLabel('Количество мест').fill('1')
  await page.getByRole('button', { name: 'Создать автобус' }).click()
  await expect(
    page.getByText('Проверьте список перед новой попыткой', { exact: true }),
  ).toBeVisible()
  await expect(page.getByRole('button', { name: 'Создать автобус' })).toHaveCount(0)
  expect(state.writes).toHaveLength(1)
  await page.getByRole('link', { name: 'К автобусам', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Сохранённый' })).toBeVisible()
  state.mode = 'ok'
  let release!: () => void
  state.gate = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.goto('/carrier/buses/new')
  await page.getByLabel('Название автобуса').fill('Поздний ответ')
  await page.getByLabel('Количество мест').fill('1')
  await page.getByRole('button', { name: 'Создать автобус' }).click()
  await expect.poll(() => state.writes.length).toBe(2)
  let releaseModule!: () => void
  const moduleGate = new Promise<void>((resolve) => {
    releaseModule = resolve
  })
  await page.route('**/src/pages/CarrierRoutePages.tsx', async (route) => {
    await moduleGate
    await route.continue()
  })
  await page
    .getByRole('navigation', { name: 'Кабинет перевозчика' })
    .getByRole('link', { name: 'Рейсы', exact: true })
    .click()
  await expect(page.getByText('Открываем страницу…', { exact: true })).toBeVisible()
  release()
  await expect(page).toHaveURL('/carrier/routes')
  releaseModule()
  await expect(page.getByRole('heading', { name: 'Мои рейсы', exact: true })).toBeVisible()
  await expect(page).toHaveURL('/carrier/routes')
})

test('route form pages buses without submitting, saves exact UTC and price, and publishes only on confirmation', async ({
  page,
  context,
}, info) => {
  const state = await mock(context)
  await page.goto('/carrier/routes/new')
  await page.getByRole('button', { name: 'Следующая страница' }).click()
  expect(state.writes).toHaveLength(0)
  await page.getByLabel('Автобус', { exact: true }).selectOption({ index: 1 })
  await page.getByLabel('Направление', { exact: true }).selectOption('AM')
  await page.getByRole('combobox', { name: 'Город отправления', exact: true }).fill('Գյումրի')
  await page.getByRole('option', { name: /Гюмри/ }).click()
  await page.getByRole('combobox', { name: 'Город прибытия', exact: true }).fill('Armavir')
  await expect(page.getByRole('listbox').getByRole('option')).toHaveCount(1)
  await expect(page.getByRole('listbox').getByRole('option', { name: /Россия/ })).toBeVisible()
  await page.getByRole('listbox').getByRole('option', { name: /Россия/ }).click()
  await page.getByLabel('Отправление (UTC)').fill('2030-03-01T12:30')
  await page.getByLabel('Цена билета, ₽').fill('4500,55')
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
  await page.getByRole('main').focus()
  await page.evaluate(() => window.scrollTo(0, 0))
  await page.screenshot({ path: info.outputPath('carrier-route-form.png'), fullPage: true })
  for (const width of [320, 768, 1024]) {
    await page.setViewportSize({ width, height: 1000 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false)
  }
  await page.getByRole('button', { name: 'Создать черновик' }).click()
  await expect(page).toHaveURL(`/carrier/routes/${id}`)
  expect(state.writes[0].body).toMatchObject({
    price: '4500.55',
    departure_at: '2030-03-01T12:30:00.000Z',
    origin_country: 'AM',
    destination_country: 'RU',
    origin: 'am-gyumri',
    destination: 'ru-armavir',
    bus_id: '00000021-1111-4111-8111-111111111111',
  })
  await page.getByRole('button', { name: 'Опубликовать рейс' }).click()
  expect(state.writes).toHaveLength(1)
  await page.getByRole('button', { name: 'Подтвердить действие' }).click()
  await expect(page.getByText('Опубликован ·', { exact: false })).toBeVisible()
  expect(state.writes.at(-1)?.body).toEqual({ status: 'ACTIVE' })
  await page.getByRole('link', { name: 'Изменить данные' }).click()
  await page.getByLabel('Цена билета, ₽').fill('4600.00')
  await page.getByRole('button', { name: 'Сохранить изменения рейса' }).click()
  await expect(page).toHaveURL(`/carrier/routes/${id}`)
  expect(state.writes.at(-1)?.body).toEqual({ price: '4600.00' })
})

test('booking lock and transition failures are visible; lost cancellation reconciles and draft archives', async ({
  page,
  context,
}) => {
  const state = await mock(context)
  state.route.status = 'ACTIVE'
  state.mode = 'locked'
  await page.goto(`/carrier/routes/${id}/edit`)
  await page.getByLabel('Цена билета, ₽').fill('4600')
  await page.getByRole('button', { name: 'Сохранить изменения рейса' }).click()
  await expect(page.getByRole('alert')).toContainText('уже были бронирования')
  expect(state.route.price).toBe('4500.50')
  state.mode = 'transition'
  await page.goto(`/carrier/routes/${id}`)
  await page.getByRole('button', { name: 'Отметить отправление' }).click()
  await page.getByRole('button', { name: 'Подтвердить действие' }).click()
  await expect(page.getByRole('alert')).toContainText('переход сейчас недоступен')
  state.mode = 'lost'
  await page.getByRole('button', { name: 'Отменить рейс', exact: true }).click()
  await expect(
    page.getByText('Для оплаченных билетов создаются заявки на ручной возврат.', { exact: false }),
  ).toBeVisible()
  await page.getByRole('button', { name: 'Вернуться без изменений' }).click()
  expect(state.writes).toHaveLength(2)
  await page.getByRole('button', { name: 'Отменить рейс', exact: true }).click()
  await page.getByRole('button', { name: 'Подтвердить действие' }).click()
  await expect(page.getByText('Отменён ·', { exact: false })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Отменить рейс', exact: true })).toHaveCount(0)
  expect(state.writes).toHaveLength(3)
  state.mode = 'ok'
  state.route.status = 'DRAFT'
  await page.reload()
  await page.getByRole('button', { name: 'Архивировать черновик' }).click()
  await page.getByRole('button', { name: 'Подтвердить действие' }).click()
  await expect(page).toHaveURL('/carrier/routes')
})

test('carrier bookings are read-only, filterable and hide inaccessible or malformed data', async ({
  page,
  context,
}, info) => {
  const state = await mock(context)
  state.route.status = 'ACTIVE'
  await page.goto(`/carrier/bookings?route_id=${id}`)
  await expect(page.getByRole('article')).toHaveCount(1)
  await page.getByRole('button', { name: 'История', exact: true }).click()
  await page.getByLabel('Статус брони', { exact: true }).selectOption('EXPIRED')
  await expect(page.getByText('Бронирований на этой странице нет', { exact: true })).toBeVisible()
  expect(state.reads.at(-1)).toContain(`route_id=${id}`)
  await page.getByLabel('Статус брони', { exact: true }).selectOption('')
  await page.getByRole('link', { name: 'Открыть бронь' }).click()
  await expect(page.getByRole('heading', { name: 'Бронь на ваш рейс', exact: true })).toBeVisible()
  await expect(page.getByText('Оплачено', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: /Отменить|Оплатить/ })).toHaveCount(0)
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
  await page.getByRole('main').focus()
  await page.evaluate(() => window.scrollTo(0, 0))
  await page.screenshot({ path: info.outputPath('carrier-booking.png'), fullPage: true })
  for (const width of [320, 768, 1024]) {
    await page.setViewportSize({ width, height: 900 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false)
  }
  state.mode = 'foreign'
  await page.getByRole('button', { name: 'Обновить бронь' }).click()
  await expect(page.getByRole('alert')).toContainText('не найдена')
  await expect(page.getByText('Оплачено', { exact: true })).toHaveCount(0)
  state.mode = 'invalid'
  await page.goto(`/carrier/routes/${id}`)
  await expect(page.getByRole('alert')).toContainText('Рейс недоступен')
  await expect(page.getByRole('button', { name: 'Отменить рейс' })).toHaveCount(0)
  const reads = state.reads.length
  await page.goto('/carrier/bookings?route_id=bad')
  await expect(page.getByText('Проверьте фильтры', { exact: true })).toBeVisible()
  expect(state.reads).toHaveLength(reads)
  expect(state.writes).toEqual([])
})

test('carrier lists preserve pagination and status filters through reload and reject stale errors', async ({
  page,
  context,
}) => {
  const state = await mock(context)
  await page.goto('/carrier/buses')
  await expect(page.getByRole('article')).toHaveCount(20)
  await page.getByRole('button', { name: 'Следующая страница' }).click()
  await expect(page).toHaveURL('/carrier/buses?offset=20')
  await expect(page.getByRole('article')).toHaveCount(2)
  await page.reload()
  await expect(page.getByRole('article')).toHaveCount(2)
  state.mode = 'read-error'
  await page.getByRole('button', { name: 'Обновить автобусы' }).click()
  await expect(page.getByRole('alert')).toContainText('Не удалось загрузить автобусы')
  await expect(page.getByRole('article')).toHaveCount(0)
  state.mode = 'ok'
  await page.getByRole('button', { name: 'Обновить автобусы' }).click()
  await expect(page.getByRole('article')).toHaveCount(2)
  await page.goto('/carrier/routes')
  await page.getByLabel('Статус рейса', { exact: true }).selectOption('ACTIVE')
  await expect(page).toHaveURL('/carrier/routes?status=ACTIVE')
  await expect(page.getByText('Рейсов на этой странице нет', { exact: true })).toBeVisible()
  await page.goBack()
  await expect(page.getByRole('article')).toHaveCount(1)
  const reads = state.reads.length
  await page.goto('/carrier/buses?offset=1')
  await expect(page.getByText('Некорректная страница списка', { exact: true })).toBeVisible()
  expect(state.reads).toHaveLength(reads)
})

test('departure and completion require distinct confirmations; stale intent cannot cancel a departed route', async ({
  page,
  context,
}) => {
  const state = await mock(context)
  state.route.status = 'ACTIVE'
  await page.goto(`/carrier/routes/${id}`)
  await page.getByRole('button', { name: 'Отменить рейс', exact: true }).click()
  state.route.status = 'DEPARTED'
  await page.getByRole('button', { name: 'Обновить рейс', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Подтвердить действие' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Отменить рейс', exact: true })).toHaveCount(0)
  expect(state.writes).toHaveLength(0)
  state.route.status = 'ACTIVE'
  await page.getByRole('button', { name: 'Обновить рейс', exact: true }).click()
  await page.getByRole('button', { name: 'Отметить отправление' }).click()
  await page.getByRole('button', { name: 'Подтвердить действие' }).click()
  await expect(page.getByText('В пути ·', { exact: false })).toBeVisible()
  await page.getByRole('button', { name: 'Завершить рейс' }).click()
  expect(state.writes).toHaveLength(1)
  await page.getByRole('button', { name: 'Подтвердить действие' }).click()
  await expect(page.getByText('Завершён ·', { exact: false })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Изменить данные' })).toHaveCount(0)
  expect(state.writes.map((w) => w.body)).toEqual([{ status: 'DEPARTED' }, { status: 'COMPLETED' }])
})
