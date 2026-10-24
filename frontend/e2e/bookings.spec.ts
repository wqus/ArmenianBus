import { expect, test } from '@playwright/test'
import type { BrowserContext, Page } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'

const trip = '11111111-1111-4111-8111-111111111111'
const bus = '22222222-2222-4222-8222-222222222222'
const seat = '33333333-3333-4333-8333-333333333333'
const id = '44444444-4444-4444-8444-444444444444'
const routeData = {
  id: trip,
  bus_id: bus,
  origin: 'Ростов-на-Дону',
  destination: 'Գյումրի',
  origin_country: 'RU',
  destination_country: 'AM',
  departure_at: '2030-06-01T22:00:00Z',
  price: '4500.50',
  currency: 'RUB',
  status: 'ACTIVE',
  company_name: 'Перевозчик',
  bus_name: 'Комфорт',
  capacity: 1,
  free_seats: 1,
}
const passenger = {
  passenger_first_name: 'Արամ',
  passenger_last_name: 'Петросян',
  passenger_phone: '+37499123456',
}
async function fillPassenger(page: Page) {
  await page.getByLabel('Имя пассажира', { exact: true }).fill(passenger.passenger_first_name)
  await page.getByLabel('Фамилия пассажира', { exact: true }).fill(passenger.passenger_last_name)
  await page.getByLabel('Телефон пассажира', { exact: true }).fill(passenger.passenger_phone)
}

const checkout = `/trips/${trip}/book?seat=${seat}`

async function mock(context: BrowserContext, role = 'PASSENGER', signedIn = true) {
  const state = {
    signedIn,
    mode: 'ok',
    status: 'HELD',
    paymentStatusOverride: undefined as string | null | undefined,
    posts: 0,
    deletes: 0,
    exists: false,
    seconds: 600,
    createGate: Promise.resolve(),
  }
  const booking = () => ({
    ...passenger,
    id,
    route_id: trip,
    seat_id: seat,
    bus_id: bus,
    status: state.status,
    amount: '4500.50',
    currency: 'RUB',
    created_at: '2030-06-01T12:00:00Z',
    held_until: new Date(Date.UTC(2030, 5, 1, 12, 0, state.seconds)).toISOString(),
    server_time: '2030-06-01T12:00:00Z',
    origin: routeData.origin,
    destination: routeData.destination,
    departure_at: routeData.departure_at,
    seat_number: 1,
    company_name: 'Перевозчик',
    cancellation_allowed: state.status === 'HELD',
    route_status: 'ACTIVE',
    payment_status:
      state.paymentStatusOverride !== undefined
        ? state.paymentStatusOverride
        : state.status === 'PAID'
          ? 'SUCCEEDED'
          : null,
    refund_status: null,
    refund_required: false,
  })
  await context.route('**/api/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname
    const reply = (json: unknown, status = 200) => route.fulfill({ status, json })
    if (path.endsWith('/web/login')) state.signedIn = true
    if (path.endsWith('/web/refresh') || path.endsWith('/web/login'))
      return state.signedIn
        ? reply({ access_token: 'mock-access', token_type: 'Bearer', expires_in: 900 })
        : reply({ code: 'UNAUTHORIZED', message: 'Login required' }, 401)
    if (path === '/api/v1/me')
      return reply({
        id: 'passenger',
        email: 'passenger@example.com',
        role,
        status: 'ACTIVE',
        created_at: '2030-01-01T00:00:00Z',
      })
    if (path.endsWith(`/routes/${trip}`)) return reply(routeData)
    if (path.endsWith(`/routes/${trip}/seats`))
      return reply({
        route_id: trip,
        bus_id: bus,
        free_seats: 1,
        seats: [{ id: seat, seat_number: 1, status: 'FREE' }],
      })
    if (path === '/api/v1/bookings' && route.request().method() === 'POST') {
      state.posts++
      expect(route.request().headers().authorization).toBe('Bearer mock-access')
      expect(route.request().postDataJSON()).toEqual({
        route_id: trip,
        seat_id: seat,
        ...passenger,
      })
      if (state.mode === 'conflict')
        return reply({ code: 'BOOKING_CONFLICT', message: 'Taken' }, 409)
      state.exists = true
      await state.createGate
      if (state.mode === 'lost') return route.abort('failed')
      return reply(booking(), 201)
    }
    if (path === `/api/v1/bookings/${id}` && route.request().method() === 'DELETE') {
      state.deletes++
      expect(new URL(route.request().url()).searchParams.get('hold_only')).toBe('true')
      if (state.mode === 'cancel-race') {
        state.status = 'PAID'
        return reply({ code: 'BOOKING_NOT_HELD', message: 'Paid' }, 409)
      }
      state.status = 'CANCELLED'
      if (state.mode === 'cancel-lost') return route.abort('failed')
      return route.fulfill({ status: 204 })
    }
    if (path === '/api/v1/cabinet/bookings')
      return reply({ items: state.exists ? [booking()] : [], limit: 21, offset: 0 })
    if (path === `/api/v1/cabinet/bookings/${id}`) {
      if (state.mode === 'get-error')
        return reply({ code: 'UNAVAILABLE', message: 'internal' }, 503)
      if (state.mode === 'foreign')
        return reply({ code: 'BOOKING_NOT_FOUND', message: 'Not found' }, 404)
      return reply(booking())
    }
    return reply({ code: 'NOT_FOUND', message: 'Not found' }, 404)
  })
  return state
}

test('login returns to the chosen seat, creates once, restores hold on reload and cancels', async ({
  page,
  context,
}, testInfo) => {
  const state = await mock(context, 'PASSENGER', false)
  await page.goto(checkout)
  await expect(page).toHaveURL(`/login?next=${encodeURIComponent(checkout)}`)
  await page.getByLabel('Электронная почта').fill('passenger@example.com')
  await page.getByLabel('Пароль', { exact: true }).fill('Browser-Password-42!')
  await page.getByRole('button', { name: 'Войти', exact: true }).click()
  await expect(page).toHaveURL(checkout)
  expect(state.posts).toBe(0)
  await fillPassenger(page)
  await page.getByRole('button', { name: 'Удержать место', exact: true }).click()
  await expect(page).toHaveURL(`/bookings/${id}`)
  await expect(page.getByRole('timer')).toContainText(/0[9]:[0-5]\d/)
  expect(state.posts).toBe(1)
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Место удерживается', exact: true })).toBeVisible()
  expect(state.posts).toBe(1)
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
  await page.evaluate(() => window.scrollTo(0, 0))
  await page.screenshot({ path: testInfo.outputPath('booking.png'), fullPage: true })
  await page.getByRole('button', { name: 'Отменить удержание', exact: true }).click()
  await page.getByRole('button', { name: 'Сохранить бронь' }).click()
  expect(state.deletes).toBe(0)
  await page.getByRole('button', { name: 'Отменить удержание', exact: true }).click()
  await page.getByRole('button', { name: 'Да, освободить место' }).click()
  await expect(page.getByRole('heading', { name: 'Бронь отменена', exact: true })).toBeVisible()
  expect(state.deletes).toBe(1)
  for (const width of [320, 768, 1024]) {
    await page.setViewportSize({ width, height: 900 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false)
  }
})

test('passenger validation keeps the seat free and focuses the field; contacts stay off browser storage', async ({
  page,
  context,
}, testInfo) => {
  const state = await mock(context)
  await page.goto(checkout)
  const submit = page.getByRole('button', { name: 'Удержать место', exact: true })
  await submit.click()
  await expect(page.getByLabel('Имя пассажира', { exact: true })).toBeFocused()
  expect(state.posts).toBe(0)
  await fillPassenger(page)
  await page.getByLabel('Телефон пассажира', { exact: true }).fill('89991234567')
  await submit.click()
  await expect(page.getByLabel('Телефон пассажира', { exact: true })).toBeFocused()
  expect(state.posts).toBe(0)
  await page.getByLabel('Телефон пассажира', { exact: true }).fill('+374 (99) 123-456')
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
  await page.evaluate(() => window.scrollTo(0, 0))
  await page.screenshot({ path: testInfo.outputPath('passenger-form.png'), fullPage: true })
  const storage = await page.evaluate(() =>
    JSON.stringify([localStorage, sessionStorage, location.href]),
  )
  expect(storage).not.toContain(passenger.passenger_first_name)
  expect(storage).not.toContain('123-456')
  await submit.click()
  await expect(page).toHaveURL(`/bookings/${id}`)
  await expect(page.getByText('Արամ Петросян', { exact: true })).toBeVisible()
  await expect(page.getByText('+37499123456', { exact: true })).toBeVisible()
})

test('paid confirmation refreshes before printing and disappears on cancellation or read failure', async ({
  page,
  context,
}, testInfo) => {
  const state = await mock(context)
  state.status = 'PAID'
  await page.addInitScript(() => {
    window.print = () => {
      document.documentElement.dataset.printCalls = String(
        Number(document.documentElement.dataset.printCalls ?? '0') + 1,
      )
    }
  })
  await page.goto(`/bookings/${id}`)
  const confirmation = page.getByRole('region', { name: 'Подтверждение оплаченной брони' })
  await expect(confirmation).toContainText('Արամ Петросян')
  const print = page.getByRole('button', { name: 'Распечатать / сохранить PDF' })
  await print.click()
  await expect(page.locator('html')).toHaveAttribute('data-print-calls', '1')
  await page.emulateMedia({ media: 'print' })
  await expect(confirmation).toBeVisible()
  await expect(page.getByRole('button', { name: 'Обновить статус' })).toBeHidden()
  await expect(page.getByRole('navigation', { name: 'Основная навигация' })).toBeHidden()
  await page.screenshot({
    path: testInfo.outputPath('paid-confirmation-print.png'),
    fullPage: true,
  })
  if (testInfo.project.name === 'desktop') {
    const pdf = await page.pdf({ format: 'A4', path: testInfo.outputPath('confirmation.pdf') })
    expect(pdf.toString('latin1').match(/\/Type \/Page\b/g)?.length).toBe(1)
  }
  await page.emulateMedia({ media: 'screen' })
  state.status = 'CANCELLED'
  await print.click()
  await expect(confirmation).toHaveCount(0)
  await expect(page.getByRole('alert')).toContainText('Не удалось подтвердить')
  await expect(page.locator('html')).toHaveAttribute('data-print-calls', '1')
  state.status = 'PAID'
  await page.getByRole('button', { name: 'Обновить статус' }).click()
  await expect(confirmation).toBeVisible()
  state.mode = 'get-error'
  await print.click()
  await expect(confirmation).toHaveCount(0)
  await expect(page.locator('html')).toHaveAttribute('data-print-calls', '1')
  expect(state.posts).toBe(0)
  expect(state.deletes).toBe(0)
})

test('expired countdown removes checkout action without inventing a server status or sending a mutation', async ({
  page,
  context,
}) => {
  const state = await mock(context)
  state.seconds = 10
  await page.clock.install()
  await page.goto(`/bookings/${id}`)
  await expect(page.getByRole('link', { name: 'Перейти к оплате', exact: true })).toBeVisible()
  await page.clock.runFor(11_000)
  await expect(page.getByRole('link', { name: 'Перейти к оплате', exact: true })).toHaveCount(0)
  await expect(page.getByRole('link', { name: 'Проверить оплату', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Место удерживается', exact: true })).toBeVisible()
  await expect(page.getByRole('timer')).toHaveText('00:00')
  expect(state.posts).toBe(0)
  expect(state.deletes).toBe(0)
})

test('confirmed or terminated payment attempts never offer a new checkout action on a held booking', async ({
  page,
  context,
}) => {
  const state = await mock(context)
  for (const paymentStatus of ['SUCCEEDED', 'CANCELED', 'FAILED']) {
    state.paymentStatusOverride = paymentStatus
    await page.goto(`/bookings/${id}`)
    await expect(
      page.getByRole('heading', { name: 'Место удерживается', exact: true }),
    ).toBeVisible()
    await expect(page.getByRole('link', { name: 'Перейти к оплате', exact: true })).toHaveCount(0)
    await expect(page.getByRole('link', { name: 'Проверить оплату', exact: true })).toBeVisible()
    await expect(
      page.getByText(
        paymentStatus === 'SUCCEEDED'
          ? 'Не оплачивайте повторно:'
          : 'Платёж завершён без подтверждённой оплаты.',
        { exact: false },
      ),
    ).toBeVisible()
  }
  expect(state.posts).toBe(0)
  expect(state.deletes).toBe(0)
})

test('a lost create response is recovered from own bookings without replaying POST', async ({
  page,
  context,
}) => {
  const state = await mock(context)
  state.mode = 'lost'
  await page.goto(checkout)
  await fillPassenger(page)
  await page.getByRole('button', { name: 'Удержать место', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('бронь могла сохраниться')
  await expect(page.getByRole('button', { name: 'Удержать место', exact: true })).toHaveCount(0)
  await page.getByRole('link', { name: 'Мои бронирования', exact: true }).click()
  await page.getByRole('link', { name: 'Открыть бронь', exact: true }).click()
  await expect(page.getByRole('timer')).toBeVisible()
  expect(state.posts).toBe(1)
})

test('conflict offers a new selection and carrier cannot create a passenger booking', async ({
  page,
  context,
}) => {
  const state = await mock(context)
  state.mode = 'conflict'
  await page.goto(checkout)
  await fillPassenger(page)
  await page.getByRole('button', { name: 'Удержать место', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('место уже удерживается')
  expect(state.posts).toBe(1)
  await expect(page.getByRole('link', { name: 'Вернуться к рейсу' })).toHaveAttribute(
    'href',
    `/trips/${trip}`,
  )
  await context.unrouteAll()
  const carrier = await mock(context, 'CARRIER')
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Нет доступа' })).toBeVisible()
  expect(carrier.posts).toBe(0)
})

test('server expiration, read failures and paid cancellation race never invent a status', async ({
  page,
  context,
}) => {
  const state = await mock(context)
  state.seconds = 1
  await page.goto(`/bookings/${id}`)
  await expect(page.getByRole('timer')).toHaveText('00:00', { timeout: 5000 })
  await expect(page.getByRole('heading', { name: 'Место удерживается', exact: true })).toBeVisible()
  state.status = 'EXPIRED'
  await page.getByRole('button', { name: 'Обновить статус' }).click()
  await expect(
    page.getByRole('heading', { name: 'Срок удержания истёк', exact: true }),
  ).toBeVisible()
  await expect(page.getByRole('timer')).toHaveCount(0)
  state.mode = 'get-error'
  await page.getByRole('button', { name: 'Обновить статус' }).click()
  await expect(page.getByRole('alert')).toContainText('Не удалось проверить бронь')
  state.mode = 'ok'
  state.status = 'HELD'
  state.seconds = 600
  await page.getByRole('button', { name: 'Обновить статус' }).click()
  await page.getByRole('button', { name: 'Отменить удержание', exact: true }).click()
  state.mode = 'cancel-race'
  await page.getByRole('button', { name: 'Да, освободить место' }).click()
  await expect(page.getByRole('heading', { name: 'Оплачено', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Отменить удержание', exact: true })).toHaveCount(0)
  state.mode = 'foreign'
  await page.getByRole('button', { name: 'Обновить статус' }).click()
  await expect(page.getByRole('alert')).toContainText('недоступна этому аккаунту')
  await expect(page.getByRole('heading', { name: 'Оплачено', exact: true })).toHaveCount(0)
})
test('double submit is guarded; a late response respects navigation and lost cancellation is reconciled', async ({
  page,
  context,
}) => {
  const state = await mock(context)
  let release!: () => void
  state.createGate = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.goto(checkout)
  await fillPassenger(page)
  const button = page.getByRole('button', { name: 'Удержать место', exact: true })
  await expect(button).toBeEnabled()
  await button.evaluate((button) => {
    ;(button as HTMLButtonElement).click()
    ;(button as HTMLButtonElement).click()
  })
  await expect.poll(() => state.posts).toBe(1)
  await page.getByRole('link', { name: 'Мои бронирования', exact: true }).click()
  await expect(page.getByRole('link', { name: 'Открыть бронь', exact: true })).toBeVisible()
  const response = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/v1/bookings') && response.request().method() === 'POST',
  )
  release()
  await response
  await expect(page).toHaveURL('/bookings')
  await page.getByRole('link', { name: 'Открыть бронь', exact: true }).click()
  state.mode = 'cancel-lost'
  await page.getByRole('button', { name: 'Отменить удержание', exact: true }).click()
  await page.getByRole('button', { name: 'Да, освободить место' }).click()
  await expect(page.getByRole('heading', { name: 'Бронь отменена', exact: true })).toBeVisible()
  expect(state.posts).toBe(1)
  expect(state.deletes).toBe(1)
})
