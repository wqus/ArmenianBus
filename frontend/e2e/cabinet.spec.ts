import { expect, test } from '@playwright/test'
import type { BrowserContext } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'

const id = '44444444-4444-4444-8444-444444444444'
const paymentId = '55555555-5555-4555-8555-555555555555'
async function mock(context: BrowserContext, signedIn = true) {
  const state = {
    signedIn,
    status: 'PAID',
    allowed: true,
    refund: null as string | null,
    mode: 'ok',
    deletes: [] as string[],
    lists: [] as string[],
    listGate: null as Promise<void> | null,
  }
  const booking = (status = state.status, bookingId = id) => ({
    id: bookingId,
    route_id: id,
    bus_id: id,
    seat_id: id,
    status,
    amount: '4500.50',
    currency: 'RUB',
    created_at: '2030-06-01T12:00:00Z',
    server_time: '2030-06-01T12:00:00Z',
    held_until: '2030-06-01T12:10:00Z',
    origin: 'Ростов-на-Дону',
    destination: 'Գյումրի',
    departure_at: '2030-06-03T12:00:00Z',
    seat_number: 1,
    company_name: 'Перевозчик',
    route_status: 'ACTIVE',
    cancellation_allowed: state.allowed && ['HELD', 'PAID'].includes(status),
    payment_status: status === 'HELD' ? null : 'SUCCEEDED',
    refund_status: state.refund,
    refund_required: state.refund === 'OPEN',
  })
  await context.route('**/api/v1/**', async (route) => {
    const url = new URL(route.request().url())
    const path = url.pathname
    const reply = (json: unknown, status = 200) => route.fulfill({ json, status })
    if (path.endsWith('/web/login')) state.signedIn = true
    if (path.endsWith('/web/login') || path.endsWith('/web/refresh'))
      return state.signedIn
        ? reply({ access_token: 'mock-access', token_type: 'Bearer', expires_in: 900 })
        : reply({ code: 'UNAUTHORIZED', message: 'Login required' }, 401)
    if (path.endsWith('/me'))
      return reply({
        id: 'passenger',
        email: 'passenger@example.com',
        role: 'PASSENGER',
        status: 'ACTIVE',
        created_at: '2030-01-01T00:00:00Z',
      })
    if (path === '/api/v1/cabinet/bookings') {
      state.lists.push(url.search)
      if (state.mode === 'list-error')
        return reply({ code: 'UNAVAILABLE', message: 'Unavailable' }, 503)
      const offset = Number(url.searchParams.get('offset'))
      const segment = url.searchParams.get('segment')
      const status = url.searchParams.get('status')
      let items = Array.from({ length: 22 }, (_, n) =>
        booking(
          n === 0 ? 'PAID' : 'CANCELLED',
          `${String(n + 1).padStart(8, '0')}-4444-4444-8444-444444444444`,
        ),
      )
      if (segment === 'upcoming') items = items.filter((item) => item.status === 'PAID')
      if (segment === 'history') items = items.filter((item) => item.status !== 'PAID')
      if (status) items = items.filter((item) => item.status === status)
      if (segment === 'all' && state.listGate) await state.listGate
      return reply({ items: items.slice(offset, offset + 21), offset, limit: 21 })
    }
    if (path === `/api/v1/cabinet/bookings/${id}`) {
      if (state.mode === 'detail-error')
        return reply({ code: 'UNAVAILABLE', message: 'Unavailable' }, 503)
      return reply(
        state.mode === 'invalid' ? { ...booking(), refund_status: 'REFUNDED' } : booking(),
      )
    }
    if (path === `/api/v1/bookings/${id}` && route.request().method() === 'DELETE') {
      state.deletes.push(url.search)
      if (state.mode === 'cutoff') {
        state.allowed = false
        return reply({ code: 'CANCELLATION_CUTOFF', message: 'Too late' }, 409)
      }
      state.status = 'CANCELLED'
      state.allowed = false
      state.refund = 'OPEN'
      if (state.mode === 'lost') return route.abort('failed')
      return route.fulfill({ status: 204 })
    }
    if (path === `/api/v1/bookings/${id}/payment`)
      return reply({
        id: paymentId,
        booking_id: id,
        amount: '4500.50',
        currency: 'RUB',
        status: 'SUCCEEDED',
        confirmation_url: null,
        review_reason: 'REFUND_REQUIRED',
        created_at: '2030-06-01T12:00:00Z',
      })
    return reply({ code: 'NOT_FOUND', message: 'Not found' }, 404)
  })
  return state
}

test('cabinet filters preserve URL history and pagination, reset offset and reject invalid URLs', async ({
  page,
  context,
}, info) => {
  const state = await mock(context)
  await page.goto('/bookings')
  await expect(page.getByRole('article')).toHaveCount(20)
  await page.getByRole('button', { name: 'Следующая страница' }).click()
  await expect(page).toHaveURL('/bookings?offset=20')
  await expect(page.getByRole('article')).toHaveCount(2)
  await page.getByRole('button', { name: 'История', exact: true }).click()
  await expect(page).toHaveURL('/bookings?segment=history')
  await page.getByLabel('Статус брони', { exact: true }).selectOption('CANCELLED')
  await expect(page).toHaveURL('/bookings?segment=history&status=CANCELLED')
  await expect(page.getByRole('article')).toHaveCount(20)
  await page.getByRole('button', { name: 'Следующая страница' }).click()
  await expect(page).toHaveURL('/bookings?segment=history&status=CANCELLED&offset=20')
  await page.reload()
  await expect(page.getByRole('article')).toHaveCount(1)
  await page.getByRole('button', { name: 'Предыдущая страница' }).click()
  await expect(page.getByRole('article')).toHaveCount(20)
  await page.getByLabel('Статус брони', { exact: true }).selectOption('EXPIRED')
  await expect(page.getByText('Бронирований на этой странице нет', { exact: true })).toBeVisible()
  await page.goBack()
  await expect(page.getByLabel('Статус брони', { exact: true })).toHaveValue('CANCELLED')
  await page.getByRole('button', { name: 'Предстоящие', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Предстоящие', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await page.getByLabel('Статус брони', { exact: true }).selectOption('')
  await expect(page.getByRole('article')).toHaveCount(1)
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
  await page.getByRole('main').focus()
  await page.evaluate(() => window.scrollTo(0, 0))
  await page.screenshot({ path: info.outputPath('cabinet.png'), fullPage: true })
  expect(state.lists.at(-1)).toContain('segment=upcoming')
  const count = state.lists.length
  await page.goto('/bookings?offset=10020')
  await expect(page.getByRole('heading', { name: 'Проверьте фильтры' })).toBeVisible()
  expect(state.lists).toHaveLength(count)
})

test('login restores cabinet filters; failed and late reads cannot replace the selected list', async ({
  page,
  context,
}) => {
  const state = await mock(context, false)
  const target = '/bookings?segment=history&status=CANCELLED&offset=20'
  await page.goto(target)
  await page.getByLabel('Электронная почта').fill('passenger@example.com')
  await page.getByLabel('Пароль', { exact: true }).fill('Browser-Password-42!')
  await page.getByRole('button', { name: 'Войти', exact: true }).click()
  await expect(page).toHaveURL(target)
  await expect(page.getByRole('article')).toHaveCount(1)
  state.mode = 'list-error'
  await page.getByRole('button', { name: 'Обновить бронирования' }).click()
  await expect(page.getByRole('alert')).toContainText('Не удалось загрузить бронирования')
  await expect(page.getByRole('article')).toHaveCount(0)
  state.mode = 'ok'
  let release!: () => void
  state.listGate = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.getByRole('button', { name: 'Все', exact: true }).click()
  await expect.poll(() => state.lists.at(-1)).toContain('segment=all')
  await page.getByRole('button', { name: 'Предстоящие', exact: true }).click()
  await page.getByLabel('Статус брони', { exact: true }).selectOption('')
  await expect(page.getByRole('article')).toHaveCount(1)
  release()
  await expect(page.getByRole('article')).toHaveCount(1)
  await expect(page.getByRole('button', { name: 'Предстоящие', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
})

test('paid cancellation requires explicit confirmation and creates a refund without claiming completion', async ({
  page,
  context,
}, info) => {
  const state = await mock(context)
  await page.goto(`/bookings/${id}`)
  const cancel = page.getByRole('button', { name: 'Отменить оплаченную бронь', exact: true })
  await cancel.click()
  await expect(
    page.getByText('Отмена не означает, что деньги уже возвращены.', { exact: false }),
  ).toBeVisible()
  await page.getByRole('button', { name: 'Сохранить бронь' }).click()
  expect(state.deletes).toHaveLength(0)
  await cancel.click()
  await page.getByRole('button', { name: 'Да, отменить оплаченную бронь' }).evaluate((el) => {
    ;(el as HTMLButtonElement).click()
    ;(el as HTMLButtonElement).click()
  })
  await expect(page.getByRole('heading', { name: 'Бронь отменена', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Заявка на возврат открыта' })).toBeVisible()
  expect(state.deletes).toEqual([''])
  await expect(page.getByText('Платёж подтверждён', { exact: false })).toBeVisible()
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
  await page.getByRole('main').focus()
  await page.evaluate(() => window.scrollTo(0, 0))
  await page.screenshot({ path: info.outputPath('refund.png'), fullPage: true })
  for (const width of [320, 768, 1024]) {
    await page.setViewportSize({ width, height: 900 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false)
  }
})

test('lost cancellation reconciles on GET and operator refund status is shared with payment result', async ({
  page,
  context,
}) => {
  const state = await mock(context)
  state.mode = 'lost'
  await page.goto(`/bookings/${id}`)
  await page.getByRole('button', { name: 'Отменить оплаченную бронь', exact: true }).click()
  await page.getByRole('button', { name: 'Да, отменить оплаченную бронь' }).click()
  await expect(page.getByRole('heading', { name: 'Заявка на возврат открыта' })).toBeVisible()
  expect(state.deletes).toHaveLength(1)
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Бронь отменена', exact: true })).toBeVisible()
  expect(state.deletes).toHaveLength(1)
  state.refund = 'REFUND_RECORDED'
  await page.getByRole('button', { name: 'Обновить статус' }).click()
  await expect(page.getByRole('heading', { name: 'Возврат отмечен оператором' })).toBeVisible()
  await page.getByRole('link', { name: 'Проверить оплату' }).click()
  await expect(page.getByRole('heading', { name: 'Возврат отмечен оператором' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Оплата подтверждена' })).toHaveCount(0)
})

test('cutoff, malformed data and changed hold intent cannot cancel a paid booking silently', async ({
  page,
  context,
}) => {
  const state = await mock(context)
  state.mode = 'cutoff'
  await page.goto(`/bookings/${id}`)
  await page.getByRole('button', { name: 'Отменить оплаченную бронь', exact: true }).click()
  await page.getByRole('button', { name: 'Да, отменить оплаченную бронь' }).click()
  await expect(page.getByRole('alert')).toContainText('Срок отмены оплаченной брони истёк')
  await expect(page.getByText('Отмена оплаченной брони недоступна', { exact: true })).toBeVisible()
  expect(state.status).toBe('PAID')
  state.mode = 'invalid'
  await page.getByRole('button', { name: 'Обновить статус' }).click()
  await expect(page.getByRole('alert')).toContainText('Не удалось проверить бронь')
  await expect(
    page.getByRole('button', { name: 'Отменить оплаченную бронь', exact: true }),
  ).toHaveCount(0)
  state.mode = 'ok'
  state.status = 'HELD'
  state.allowed = true
  await page.getByRole('button', { name: 'Обновить статус' }).click()
  await page.getByRole('button', { name: 'Отменить удержание', exact: true }).click()
  state.status = 'PAID'
  await page.getByRole('button', { name: 'Обновить статус' }).click()
  await expect(page.getByRole('button', { name: 'Да, освободить место' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Да, отменить оплаченную бронь' })).toHaveCount(0)
  await expect(
    page.getByRole('button', { name: 'Отменить оплаченную бронь', exact: true }),
  ).toBeVisible()
  expect(state.deletes).toHaveLength(1)
})
