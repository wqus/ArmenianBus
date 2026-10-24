import { expect, test, type BrowserContext } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { records, health, id, other, at } from '../src/features/admin/fixtures.testdata'

async function mock(context: BrowserContext) {
  const state = {
    role: 'ADMIN',
    signedIn: true,
    mode: 'ok',
    records: structuredClone(records),
    health: structuredClone(health),
    reads: [] as string[],
    writes: [] as { path: string; method: string; body: Record<string, unknown> }[],
    gate: null as Promise<void> | null,
  }
  await context.route('**/api/v1/**', async (route) => {
    const req = route.request(),
      url = new URL(req.url()),
      path = url.pathname.replace('/api/v1', '')
    const reply = (json: unknown, status = 200) => route.fulfill({ json, status })
    const fail = (code: string, status = 409) => reply({ code, message: code }, status)
    if (path.endsWith('/web/login')) state.signedIn = true
    if (path.endsWith('/web/refresh') || path.endsWith('/web/login'))
      return state.signedIn
        ? reply({ access_token: 'mock-admin', token_type: 'Bearer', expires_in: 900 })
        : fail('UNAUTHORIZED', 401)
    if (path === '/me')
      return reply({
        id: other,
        email: 'admin@example.com',
        role: state.role,
        status: 'ACTIVE',
        created_at: at,
      })
    if (!path.startsWith('/admin/')) return fail('NOT_FOUND', 404)
    const [, , kind, recordId, action] = path.split('/')
    if (req.method() === 'GET') {
      state.reads.push(path + url.search)
      if (state.mode === 'read-error') return fail('UNAVAILABLE', 503)
      if (path === '/admin/operations/health') return reply(state.health)
      if (!Object.hasOwn(state.records, kind)) return fail('NOT_FOUND', 404)
      if (recordId)
        return state.mode === 'foreign'
          ? fail('NOT_FOUND', 404)
          : reply({
              ...state.records[kind],
              id: recordId,
              ...(state.mode === 'invalid' ? { status: 'UNKNOWN' } : {}),
            })
      const offset = Number(url.searchParams.get('offset'))
      let items =
        kind === 'users'
          ? Array.from({ length: 22 }, (_, n) => ({
              ...state.records.users,
              id: n ? `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111` : id,
              email: `user${n}@example.com`,
              role: n === 0 ? 'PASSENGER' : 'CARRIER',
            }))
          : [state.records[kind]]
      for (const key of ['status', 'role'])
        if (url.searchParams.get(key))
          items = items.filter((item) => item[key] === url.searchParams.get(key))
      if (state.gate) await state.gate
      return reply({ items: items.slice(offset, offset + 21), limit: 21, offset })
    }
    const body = req.postDataJSON()
    state.writes.push({ path, method: req.method(), body })
    if (state.gate) await state.gate
    const record = state.records[kind]
    if (state.mode === 'conflict') {
      if (kind === 'notifications') record.retry_generation = 3
      return fail(kind === 'notifications' ? 'NOTIFICATION_NOT_RETRYABLE' : 'REFUND_REFERENCE_USED')
    }
    if (action === 'verify') {
      if (state.mode === 'disabled') return fail('PAYMENTS_DISABLED', 503)
      record.external_id = body.external_id ?? record.external_id
      record.status = 'SUCCEEDED'
      record.review_reason = null
      record.last_error = null
    } else if (action === 'record') {
      record.status = 'REFUND_RECORDED'
      record.resolution_reference = body.reference
      record.resolved_at = at
      record.resolved_by_user_id = other
    } else if (action === 'retry') {
      record.status = 'PENDING'
      record.retry_generation = Number(record.retry_generation) + 1
      record.attempts = 0
      record.last_error = null
    } else if (action === 'cancel') record.status = 'CANCELLED'
    else if (action === 'status') record.status = body.status
    else return fail('NOT_FOUND', 404)
    return state.mode === 'lost' ? route.abort('failed') : reply(record)
  })
  return state
}
const confirm = async (page: import('@playwright/test').Page) =>
  page.getByRole('button', { name: 'Подтвердить действие', exact: true }).click()

test('admin role gate, login return, all inspection resources and audit escaping', async ({
  page,
  context,
}) => {
  const state = await mock(context)
  state.role = 'CARRIER'
  await page.goto('/admin/carriers')
  await expect(page.getByRole('heading', { name: 'Нет доступа' })).toBeVisible()
  expect(state.reads).toEqual([])
  state.role = 'ADMIN'
  state.signedIn = false
  await page.goto('/admin/payments?review_required=true')
  await page.getByLabel('Электронная почта').fill('admin@example.com')
  await page.getByLabel('Пароль', { exact: true }).fill('Admin-Password-42!')
  await page.getByRole('button', { name: 'Войти', exact: true }).click()
  await expect(page).toHaveURL('/admin/payments?review_required=true')
  await expect(page.getByRole('article')).toHaveCount(1)
  for (const kind of [
    'carriers',
    'routes',
    'bookings',
    'payments',
    'refund-cases',
    'notifications',
  ]) {
    await page.goto(`/admin/${kind}`)
    await page.getByRole('link', { name: 'Открыть запись', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Данные записи' })).toBeVisible()
  }
  await page.goto('/admin/audit')
  await expect(page.getByText('<script>alert(1)</script>', { exact: false })).toBeVisible()
  expect(await page.locator('.admin-event script').count()).toBe(0)
  await expect(page.getByRole('button', { name: 'Подтвердить действие' })).toHaveCount(0)
  expect(state.writes).toEqual([])
})

test('carrier activation and user blocking require confirmation and reason; admins remain protected', async ({
  page,
  context,
}) => {
  const state = await mock(context)
  await page.goto(`/admin/carriers/${id}`)
  await page.getByRole('button', { name: 'Активировать перевозчика' }).click()
  await page.getByRole('button', { name: 'Вернуться без изменений' }).click()
  expect(state.writes).toHaveLength(0)
  await page.getByRole('button', { name: 'Активировать перевозчика' }).click()
  await page.getByRole('button', { name: 'Подтвердить действие' }).evaluate((el) => {
    ;(el as HTMLButtonElement).click()
    ;(el as HTMLButtonElement).click()
  })
  await expect(page.getByRole('button', { name: 'Заблокировать перевозчика' })).toBeVisible()
  expect(state.writes).toHaveLength(1)
  expect(state.writes[0].body).toEqual({ status: 'ACTIVE' })
  await page.goto(`/admin/users/${id}`)
  await page.getByLabel('Причина действия').fill('  Проверка обращения  ')
  await page.getByRole('button', { name: 'Заблокировать аккаунт' }).click()
  await expect(page.getByText('Введённое значение: Проверка обращения')).toBeVisible()
  await confirm(page)
  await expect(page.getByRole('button', { name: 'Разблокировать аккаунт' })).toBeVisible()
  expect(state.writes.at(-1)?.body).toEqual({ status: 'BLOCKED', reason: 'Проверка обращения' })
  state.records.users.role = 'ADMIN'
  await page.getByRole('button', { name: 'Обновить запись' }).click()
  await expect(page.getByText('Административный аккаунт защищён', { exact: true })).toBeVisible()
  await expect(page.getByLabel('Причина действия')).toHaveCount(0)
})

test('route cancellation reconciles a lost response and refresh invalidates old intent', async ({
  page,
  context,
}) => {
  const state = await mock(context)
  await page.goto(`/admin/routes/${id}`)
  await page.getByLabel('Причина действия').fill('Рейс отменён перевозчиком')
  await page.getByRole('button', { name: 'Отменить рейс', exact: true }).click()
  state.records.routes.status = 'DEPARTED'
  await page.getByRole('button', { name: 'Обновить запись' }).click()
  await expect(page.getByRole('button', { name: 'Подтвердить действие' })).toHaveCount(0)
  expect(state.writes).toHaveLength(0)
  state.records.routes.status = 'ACTIVE'
  state.mode = 'lost'
  await page.getByRole('button', { name: 'Обновить запись' }).click()
  await page.getByLabel('Причина действия').fill('Отмена по обращению')
  await page.getByRole('button', { name: 'Отменить рейс', exact: true }).click()
  await expect(
    page.getByText('Деньги автоматически не перечисляются.', { exact: false }),
  ).toBeVisible()
  await confirm(page)
  await expect(page.getByText('Отменён', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Отменить рейс', exact: true })).toHaveCount(0)
  expect(state.writes).toHaveLength(1)
  await page.reload()
  expect(state.writes).toHaveLength(1)
})

test('payment verification never invents success when disabled; refund records an external action only', async ({
  page,
  context,
}) => {
  const state = await mock(context)
  state.mode = 'disabled'
  await page.goto(`/admin/payments/${id}`)
  await page.getByLabel('Идентификатор платежа у провайдера').fill('bad')
  await page.getByRole('button', { name: 'Проверить у провайдера' }).click()
  await expect(page.getByText('Укажите полный UUID из кабинета провайдера.')).toBeVisible()
  expect(state.writes).toHaveLength(0)
  await page.getByLabel('Идентификатор платежа у провайдера').fill(other)
  await page.getByRole('button', { name: 'Проверить у провайдера' }).click()
  await confirm(page)
  await expect(page.getByRole('alert')).toContainText('платежи выключены')
  await expect(page.getByText('Платёж подтверждён', { exact: true })).toHaveCount(0)
  expect(state.writes[0].body).toEqual({ external_id: other })
  state.mode = 'ok'
  state.records.payments.external_id = other
  await page.getByRole('button', { name: 'Обновить запись' }).click()
  await page.getByRole('button', { name: 'Проверить у провайдера' }).click()
  await confirm(page)
  await expect(page.getByText('Платёж подтверждён', { exact: true })).toBeVisible()
  expect(state.writes.at(-1)?.body).toEqual({})
  await page.goto(`/admin/refund-cases/${id}`)
  await page.getByLabel('Номер выполненного возврата').fill('invalid ref')
  await page.getByRole('button', { name: 'Записать ручной возврат' }).click()
  await expect(page.getByText('Нужен номер до 100 символов:', { exact: false })).toBeVisible()
  await page.getByLabel('Номер выполненного возврата').fill('REFUND-42')
  await page.getByRole('button', { name: 'Записать ручной возврат' }).click()
  await expect(
    page.getByText('полный возврат уже выполнен вне armatrans', { exact: false }),
  ).toBeVisible()
  state.mode = 'conflict'
  await confirm(page)
  await expect(page.getByRole('alert')).toContainText('уже использован')
  state.mode = 'lost'
  await page.getByLabel('Номер выполненного возврата').fill('REFUND-43')
  await page.getByRole('button', { name: 'Записать ручной возврат' }).click()
  await confirm(page)
  await expect(page.getByText('Возврат отмечен оператором', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Записать ручной возврат' })).toHaveCount(0)
  expect(state.writes.at(-1)?.body).toEqual({ reference: 'REFUND-43' })
})

test('notification retry uses current generation and late writes do not replace navigation', async ({
  page,
  context,
}) => {
  const state = await mock(context)
  await page.goto(`/admin/notifications/${id}`)
  state.mode = 'conflict'
  await page.getByLabel('Причина действия').fill('SMTP исправлен')
  await page.getByRole('button', { name: 'Повторить доставку' }).click()
  await confirm(page)
  await expect(page.getByRole('alert')).toContainText('Уведомление уже изменилось')
  expect(state.writes[0].body.expected_generation).toBe(2)
  state.mode = 'ok'
  let release!: () => void
  state.gate = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.getByLabel('Причина действия').fill('Повтор после проверки')
  await page.getByRole('button', { name: 'Повторить доставку' }).click()
  await confirm(page)
  await expect.poll(() => state.writes.length).toBe(2)
  expect(state.writes[1].body.expected_generation).toBe(3)
  await page
    .getByRole('navigation', { name: 'Кабинет администратора' })
    .getByRole('link', { name: 'Обзор', exact: true })
    .click()
  release()
  state.gate = null
  await expect(page.getByRole('heading', { name: 'Состояние операций' })).toBeVisible()
  await expect(page).toHaveURL('/admin')
  await page.goto(`/admin/notifications/${id}`)
  await expect(page.getByRole('heading', { name: 'Данные записи' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Повторить доставку' })).toHaveCount(0)
})

test('filters, paging, reload, invalid URLs and failed reads keep lists trustworthy', async ({
  page,
  context,
}) => {
  const state = await mock(context)
  await page.goto('/admin/users')
  await expect(page.getByRole('article')).toHaveCount(20)
  await page.getByRole('button', { name: 'Следующая страница' }).click()
  await expect(page).toHaveURL('/admin/users?offset=20')
  await page.reload()
  await expect(page.getByRole('article')).toHaveCount(2)
  await page.getByLabel('Роль', { exact: true }).selectOption('PASSENGER')
  await page.getByRole('button', { name: 'Применить фильтры' }).click()
  await expect(page).toHaveURL('/admin/users?role=PASSENGER')
  await expect(page.getByRole('article')).toHaveCount(1)
  state.mode = 'read-error'
  await page.getByRole('button', { name: 'Обновить список' }).click()
  await expect(page.getByRole('alert')).toContainText('Список недоступен')
  await expect(page.getByRole('article')).toHaveCount(0)
  const count = state.reads.length
  await page.goto('/admin/routes?carrier_id=bad')
  await expect(page.getByText('Некорректные фильтры в ссылке')).toBeVisible()
  expect(state.reads).toHaveLength(count)
  state.mode = 'invalid'
  await page.goto(`/admin/payments/${id}`)
  await expect(page.getByRole('alert')).toContainText('Запись недоступна')
  await expect(page.getByRole('button', { name: 'Проверить у провайдера' })).toHaveCount(0)
  state.mode = 'foreign'
  await page.getByRole('button', { name: 'Обновить запись' }).click()
  await expect(page.getByRole('alert')).toContainText('не найдена')
})

test('operations health and admin forms are accessible on desktop and narrow screens', async ({
  page,
  context,
}, info) => {
  const state = await mock(context)
  await page.goto('/admin')
  await expect(page.getByText('Выключен', { exact: true })).toBeVisible()
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
  await page.getByRole('main').focus()
  await page.screenshot({ path: info.outputPath('admin-overview.png'), fullPage: true })
  await page.goto(`/admin/refund-cases/${id}`)
  await page.getByLabel('Номер выполненного возврата').fill('REFUND-42')
  await page.getByRole('button', { name: 'Записать ручной возврат' }).click()
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
  await page.getByRole('main').focus()
  await page.evaluate(() => window.scrollTo(0, 0))
  await page.screenshot({ path: info.outputPath('admin-refund-confirm.png'), fullPage: true })
  for (const width of [320, 768, 1024]) {
    await page.setViewportSize({ width, height: 900 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false)
  }
  state.health.workers.pop()
  await page.goto('/admin')
  await expect(page.getByRole('alert')).toContainText('Не удалось проверить операции')
  await expect(page.getByText('Работает', { exact: true })).toHaveCount(0)
})
