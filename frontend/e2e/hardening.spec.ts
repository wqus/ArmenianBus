import { expect, test, type BrowserContext } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { records, health, id, other, at } from '../src/features/admin/fixtures.testdata'

const query = new URLSearchParams({ origin: 'Ростов', destination: 'Գյումրի', date: '2030-02-01' })
async function mock(context: BrowserContext, role = 'PASSENGER') {
  const state = {
    signedIn: false,
    mode: 'ok',
    refreshes: 0,
    writes: 0,
    gate: null as Promise<void> | null,
    role,
  }
  const trip = {
    ...records.routes,
    company_name: 'Компания',
    bus_name: 'Автобус',
    capacity: 2,
    free_seats: 1,
  }
  await context.route('**/api/v1/**', async (route) => {
    const req = route.request(),
      path = new URL(req.url()).pathname.replace('/api/v1', '')
    const reply = (json: unknown, status = 200) => route.fulfill({ json, status })
    if (path.endsWith('/web/login')) {
      state.signedIn = true
      state.writes++
    }
    if (path.endsWith('/web/refresh') || path.endsWith('/web/login')) {
      state.refreshes++
      return state.signedIn
        ? reply({ access_token: 'qa-token', token_type: 'Bearer', expires_in: 900 })
        : reply({ code: 'UNAUTHORIZED', message: 'Login required' }, 401)
    }
    if (path === '/me')
      return reply({
        id: other,
        email: 'qa@example.com',
        role: state.role,
        status: 'ACTIVE',
        created_at: at,
      })
    if (path === '/admin/operations/health') return reply(health)
    if (path === '/carriers/me') return reply({ ...records.carriers, status: 'ACTIVE' })
    if (path === '/buses') return reply({ items: [], limit: 21, offset: 0 })
    if (path === '/cabinet/bookings')
      return reply({ items: [records.bookings], limit: 21, offset: 0 })
    if (path === '/routes/search') {
      if (state.gate) await state.gate
      if (state.mode === 'error') return reply({ code: 'UNAVAILABLE', message: 'Unavailable' }, 503)
      return reply({ items: state.mode === 'empty' ? [] : [trip], limit: 21, offset: 0 })
    }
    if (path === `/routes/${id}`) return reply(trip)
    if (path === `/routes/${id}/seats`)
      return reply({
        route_id: id,
        bus_id: other,
        free_seats: 1,
        seats: [
          { id, seat_number: 1, status: 'FREE' },
          { id: other, seat_number: 2, status: 'PAID' },
        ],
      })
    return reply({ code: 'NOT_FOUND', message: 'Not found' }, 404)
  })
  return state
}

test('loading skeleton keeps the action name and respects reduced motion; errors and empty results recover', async ({
  page,
  context,
}, info) => {
  const state = await mock(context)
  let release!: () => void
  state.gate = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto(`/search?${query}`)
  const refresh = page.getByRole('button', { name: 'Обновить рейсы', exact: true })
  await expect(refresh).toBeDisabled()
  await expect(refresh).toHaveAttribute('aria-busy', 'true')
  await expect(page.getByText('Ищем рейсы…', { exact: true })).toBeVisible()
  expect(
    await page
      .locator('.skeleton')
      .first()
      .evaluate((el) => getComputedStyle(el).animationName),
  ).toBe('none')
  await expect(page.getByRole('article')).toHaveCount(0)
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
  await page.getByRole('main').focus()
  await page.evaluate(() => window.scrollTo(0, 0))
  await page.screenshot({ path: info.outputPath('loading.png'), fullPage: true })
  state.gate = null
  release()
  await expect(page.getByRole('article')).toHaveCount(1)
  await expect(refresh).toHaveAttribute('aria-busy', 'false')
  state.mode = 'error'
  await refresh.click()
  await expect(page.getByRole('alert')).toContainText('Не удалось загрузить рейсы')
  await expect(page.getByRole('article')).toHaveCount(0)
  state.mode = 'empty'
  await refresh.click()
  await expect(page.getByText('Рейсов не найдено', { exact: true })).toBeVisible()
  state.mode = 'ok'
  await refresh.click()
  await expect(page.getByRole('article')).toHaveCount(1)
})

test('unsupported session APIs leave public search usable and explain private access', async ({
  page,
  context,
}) => {
  const state = await mock(context)
  await context.addInitScript(() =>
    Object.defineProperty(window, 'BroadcastChannel', { value: undefined, configurable: true }),
  )
  await page.goto('/account')
  await expect(page.getByText('Вход недоступен в этом браузере.', { exact: false })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Не удалось открыть страницу' })).toHaveCount(0)
  expect(state.refreshes).toBe(0)
  await page.goto(`/search?${query}`)
  await expect(page.getByRole('article')).toHaveCount(1)
  expect(state.refreshes).toBe(0)
})

test('keyboard skip link, route focus, numbered seats and reload remain usable', async ({
  page,
  context,
}) => {
  await mock(context)
  await page.goto('/')
  await page.keyboard.press('Tab')
  await expect(page.getByRole('link', { name: 'Перейти к содержимому' })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('main')).toBeFocused()
  await page.getByRole('link', { name: 'О бронировании', exact: true }).click()
  await expect(page.getByRole('main')).toBeFocused()
  await page.goto(`/trips/${id}`)
  const free = page.getByRole('button', { name: 'Место 1, свободно', exact: true })
  await free.focus()
  await page.keyboard.press('Space')
  await expect(free).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByRole('button', { name: 'Место 2, занято', exact: true })).toBeDisabled()
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
  await page.reload()
  await expect(free).toHaveAttribute('aria-pressed', 'false')
})

test('connection changes are announced without replaying user operations', async ({
  page,
  context,
}) => {
  const state = await mock(context)
  state.signedIn = true
  await page.goto('/account')
  await expect(page.getByText('qa@example.com')).toBeVisible()
  await context.setOffline(true)
  await expect(page.getByRole('status').filter({ hasText: 'Нет соединения с сетью' })).toBeVisible()
  expect(state.writes).toBe(0)
  await context.setOffline(false)
  await expect(page.getByText('Нет соединения с сетью', { exact: false })).toHaveCount(0)
  expect(state.writes).toBe(0)
})

test('private navigation and forms fit narrow screens and enlarged text', async ({
  page,
  context,
}, info) => {
  const state = await mock(context, 'CARRIER')
  state.signedIn = true
  await page.goto('/carrier/routes/new')
  await expect(page.getByRole('heading', { name: 'Новый рейс' })).toBeVisible()
  await page.getByLabel('Город отправления').fill('Շատ երկար քաղաքի անուն '.repeat(6))
  await page.getByLabel('Город прибытия').fill('Длинное название города '.repeat(6))
  for (const width of [320, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 1000 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false)
  }
  await page.setViewportSize({ width: 768, height: 1000 })
  // Text-only enlargement complements the 320px reflow check (not an OS zoom claim).
  await page.addStyleTag({
    content:
      'body { font-size: 30px !important } input, select, button { font-size: 1em !important }',
  })
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false)
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
  await page.getByRole('main').focus()
  await page.evaluate(() => window.scrollTo(0, 0))
  await page.screenshot({ path: info.outputPath('large-text.png'), fullPage: true })
})

test('lazy page failure offers manual reload and restores the intended route', async ({
  page,
  context,
}) => {
  const state = await mock(context, 'ADMIN')
  state.signedIn = true
  const moduleUrl = (url: URL) =>
    url.pathname.includes('AdminPages') && /\.(?:tsx|js)$/.test(url.pathname)
  await page.route(moduleUrl, (route) => route.abort('failed'))
  await page.goto('/admin')
  await expect(page.getByRole('heading', { name: 'Не удалось открыть страницу' })).toBeVisible()
  await page.unroute(moduleUrl)
  await Promise.all([
    page.waitForEvent('domcontentloaded'),
    page.getByRole('button', { name: 'Обновить страницу' }).click(),
  ])
  await expect(page).toHaveURL('/admin')
  await expect(page.getByRole('heading', { name: 'Состояние операций' })).toBeVisible()
  expect(state.writes).toBe(0)
})

test('JavaScript-disabled visitors see an explanation', async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false })
  const page = await context.newPage()
  await page.goto('http://127.0.0.1:5174/')
  await expect(page.locator('noscript')).toBeVisible()
  // Playwright's text matcher deliberately excludes noscript contents.
  await expect
    .poll(() => page.locator('noscript').textContent())
    .toBe('Для работы ArmeniaBus включите JavaScript в настройках браузера.')
  await context.close()
})
