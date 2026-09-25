import { expect, test } from '@playwright/test'
import type { BrowserContext } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'

const id = '44444444-4444-4444-8444-444444444444'
const paymentId = '55555555-5555-4555-8555-555555555555'
const path = `/bookings/${id}/payment`
const result = `/payment/result?booking=${id}`
const providerUrl = 'https://yoomoney.ru/checkout/test-only'

async function mock(context: BrowserContext, signedIn = true, role = 'PASSENGER') {
  const state = {
    signedIn,
    exists: false,
    status: 'PENDING',
    booking: 'HELD',
    reason: null as string | null,
    url: providerUrl as string | null,
    mode: 'ok',
    keys: [] as string[],
    gets: 0,
    seconds: 600,
  }
  const payment = () => ({
    id: paymentId,
    booking_id: id,
    amount: '4500.50',
    currency: 'RUB',
    status: state.status,
    review_reason: state.reason,
    confirmation_url: state.url,
    created_at: '2030-06-01T12:00:00Z',
  })
  await context.route('**/api/v1/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname
    const reply = (json: unknown, status = 200) => route.fulfill({ json, status })
    if (pathname.endsWith('/web/login')) state.signedIn = true
    if (pathname.endsWith('/web/refresh') || pathname.endsWith('/web/login'))
      return state.signedIn
        ? reply({ access_token: 'mock-access', token_type: 'Bearer', expires_in: 900 })
        : reply({ code: 'UNAUTHORIZED', message: 'Login' }, 401)
    if (pathname.endsWith('/me'))
      return reply({
        id: 'passenger',
        email: 'passenger@example.com',
        role,
        status: 'ACTIVE',
        created_at: '2030-01-01T00:00:00Z',
      })
    if (pathname === `/api/v1/bookings/${id}/pay`) {
      expect(route.request().method()).toBe('POST')
      expect(route.request().headers().authorization).toBe('Bearer mock-access')
      state.keys.push(route.request().headers()['idempotency-key'])
      expect(state.keys.at(-1)).toMatch(/^[a-f0-9-]{36}$/)
      expect(route.request().postData()).toBeNull()
      if (state.mode === 'disabled')
        return reply({ code: 'PAYMENTS_DISABLED', message: 'Disabled' }, 503)
      state.exists = true
      if (state.mode === 'lost') {
        state.url = null
        return route.abort('failed')
      }
      state.url = providerUrl
      return reply(payment())
    }
    if (pathname === `/api/v1/bookings/${id}/payment`) {
      state.gets++
      if (state.mode === 'get-error')
        return reply({ code: 'UNAVAILABLE', message: 'Unavailable' }, 503)
      return state.exists
        ? reply(payment())
        : reply({ code: 'PAYMENT_NOT_FOUND', message: 'Missing' }, 404)
    }
    if (pathname === `/api/v1/cabinet/bookings/${id}`) {
      if (state.mode === 'foreign')
        return reply({ code: 'BOOKING_NOT_FOUND', message: 'Missing' }, 404)
      return reply({
        id,
        route_id: id,
        bus_id: id,
        seat_id: id,
        status: state.booking,
        amount: '4500.50',
        currency: 'RUB',
        created_at: '2030-06-01T12:00:00Z',
        server_time: '2030-06-01T12:00:00Z',
        held_until: new Date(Date.UTC(2030, 5, 1, 12, 0, state.seconds)).toISOString(),
        origin: 'Ростов-на-Дону',
        destination: 'Գյումրի',
        departure_at: '2030-06-02T12:00:00Z',
        seat_number: 1,
        company_name: 'Перевозчик',
        cancellation_allowed: state.booking === 'HELD',
      })
    }
    return reply({ code: 'NOT_FOUND', message: 'Missing' }, 404)
  })
  // All external checkout traffic is intercepted. No provider requests or payments are made.
  await context.route('https://yoomoney.ru/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<h1>Test checkout</h1>' }),
  )
  return state
}

test('explicit preparation, double click guard, provider link and server-confirmed return', async ({
  page,
  context,
}, info) => {
  const state = await mock(context)
  await page.goto(path)
  const prepare = page.getByRole('button', { name: 'Подготовить оплату', exact: true })
  await expect(prepare).toBeVisible()
  expect(state.keys).toHaveLength(0)
  await prepare.evaluate((el) => {
    ;(el as HTMLButtonElement).click()
    ;(el as HTMLButtonElement).click()
  })
  const link = page.getByRole('link', { name: 'Перейти на страницу ЮKassa' })
  await expect(link).toHaveAttribute('href', providerUrl)
  expect(state.keys).toHaveLength(1)
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
  await page.screenshot({ path: info.outputPath('payment.png'), fullPage: true })
  await link.click()
  await expect(page).toHaveURL(providerUrl)
  await page.goto(`${result}&status=succeeded`)
  await expect(page.getByRole('heading', { name: 'Ожидаем результат оплаты' })).toBeVisible()
  expect(state.keys).toHaveLength(1)
  state.status = 'SUCCEEDED'
  state.booking = 'PAID'
  state.url = null
  await page.getByRole('button', { name: 'Обновить результат' }).click()
  await expect(page.getByRole('heading', { name: 'Оплата подтверждена' })).toBeVisible()
  await expect(link).toHaveCount(0)
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Оплата подтверждена' })).toBeVisible()
  expect(state.keys).toHaveLength(1)
  for (const width of [320, 768]) {
    await page.setViewportSize({ width, height: 900 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false)
  }
})

test('lost response, reload and another tab reuse the original key without automatic POST', async ({
  page,
  context,
}) => {
  const state = await mock(context)
  state.mode = 'lost'
  await page.goto(path)
  await page.getByRole('button', { name: 'Подготовить оплату', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('Платёж мог сохраниться')
  expect(state.keys).toHaveLength(1)
  await page.reload()
  await expect(page.getByRole('button', { name: 'Повторить подготовку оплаты' })).toBeVisible()
  expect(state.keys).toHaveLength(1)
  const second = await context.newPage()
  await second.goto(result)
  state.mode = 'ok'
  await second.getByRole('button', { name: 'Повторить подготовку оплаты' }).click()
  await expect(second.getByRole('link', { name: 'Перейти на страницу ЮKassa' })).toBeVisible()
  expect(state.keys).toHaveLength(2)
  expect(new Set(state.keys).size).toBe(1)
})

test('return survives login, foreign booking and carrier access remain blocked', async ({
  page,
  context,
}) => {
  const state = await mock(context, false)
  await page.goto(`${result}&status=succeeded`)
  await expect(page).toHaveURL(`/login?next=${encodeURIComponent(`${result}&status=succeeded`)}`)
  await page.getByLabel('Электронная почта').fill('passenger@example.com')
  await page.getByLabel('Пароль', { exact: true }).fill('Browser-Password-42!')
  await page.getByRole('button', { name: 'Войти', exact: true }).click()
  await expect(page).toHaveURL(result)
  await expect(page.getByRole('button', { name: 'Подготовить оплату', exact: true })).toBeVisible()
  expect(state.keys).toHaveLength(0)
  state.mode = 'foreign'
  await page.reload()
  await expect(page.getByRole('alert')).toContainText('Не удалось проверить оплату')
  await expect(page.getByRole('button', { name: 'Подготовить оплату', exact: true })).toHaveCount(0)
  await context.unrouteAll({ behavior: 'wait' })
  const carrier = await mock(context, true, 'CARRIER')
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Нет доступа' })).toBeVisible()
  expect(carrier.gets).toBe(0)
})

test('disabled payments, expired hold and read failures never offer stale checkout', async ({
  page,
  context,
}) => {
  const state = await mock(context)
  state.mode = 'disabled'
  await page.goto(path)
  await page.getByRole('button', { name: 'Подготовить оплату', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('Оплата пока недоступна')
  state.mode = 'ok'
  state.exists = true
  await page.getByRole('button', { name: 'Обновить результат' }).click()
  await expect(page.getByRole('link', { name: 'Перейти на страницу ЮKassa' })).toBeVisible()
  state.mode = 'get-error'
  await page.getByRole('button', { name: 'Обновить результат' }).click()
  await expect(page.getByRole('alert')).toContainText('Не удалось проверить оплату')
  await expect(page.getByRole('link', { name: 'Перейти на страницу ЮKassa' })).toHaveCount(0)
  state.mode = 'ok'
  state.seconds = 0
  await page.getByRole('button', { name: 'Обновить результат' }).click()
  await expect(page.getByRole('heading', { name: 'Ожидаем результат оплаты' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Перейти на страницу ЮKassa' })).toHaveCount(0)
  expect(state.keys).toHaveLength(1)
})

test('late success, review, provider rejection and unsafe URL are distinct outcomes', async ({
  page,
  context,
}) => {
  const state = await mock(context)
  state.exists = true
  state.status = 'SUCCEEDED'
  state.booking = 'EXPIRED'
  state.reason = 'REFUND_REQUIRED'
  state.url = null
  await page.goto(result)
  await expect(page.getByRole('heading', { name: 'Платёж требует проверки' })).toBeVisible()
  await expect(page.getByText('Статус возврата уточните', { exact: false })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Оплата подтверждена' })).toHaveCount(0)
  state.reason = null
  state.booking = 'HELD'
  state.status = 'CANCELED'
  await page.getByRole('button', { name: 'Обновить результат' }).click()
  await expect(page.getByRole('heading', { name: 'Платёж не завершён' })).toBeVisible()
  state.status = 'PENDING'
  state.url = 'https://yoomoney.ru.evil.test/steal'
  await page.getByRole('button', { name: 'Обновить результат' }).click()
  await expect(page.getByRole('alert')).toContainText('Ссылка оплаты недоступна')
  await expect(page.getByRole('link', { name: 'Перейти на страницу ЮKassa' })).toHaveCount(0)
  state.url = null
  await page.getByRole('button', { name: 'Обновить результат' }).click()
  await expect(page.getByText('Платёж уже создан', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Повторить подготовку оплаты' })).toHaveCount(0)
  expect(state.keys).toHaveLength(0)
})

test('unavailable persistent storage prevents POST and invalid return IDs never select a booking', async ({
  page,
  context,
}) => {
  const state = await mock(context)
  await page.addInitScript(() => {
    Storage.prototype.setItem = () => {
      throw new Error('Storage disabled')
    }
  })
  await page.goto(path)
  await page.getByRole('button', { name: 'Подготовить оплату', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('Не удалось восстановить или сохранить')
  expect(state.keys).toHaveLength(0)
  await page.goto(`/payment/result?booking=${id}&booking=${paymentId}`)
  await expect(page.getByRole('heading', { name: 'Выберите бронирование' })).toBeVisible()
  await page.goto('/payment/result?status=succeeded')
  await expect(page.getByRole('heading', { name: 'Выберите бронирование' })).toBeVisible()
})
