import { expect, test } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'

const id = '11111111-1111-4111-8111-111111111111'
const bus = '22222222-2222-4222-8222-222222222222'
const routeData = {
  id,
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
  capacity: 6,
  free_seats: 4,
}
const seatsData = () =>
  Array.from({ length: 6 }, (_, index) => ({
    id: `33333333-3333-4333-8333-${String(index + 1).padStart(12, '0')}`,
    seat_number: index + 1,
    status: index === 1 ? 'HELD' : index === 2 ? 'PAID' : 'FREE',
  }))
const params = new URLSearchParams({
  origin: routeData.origin,
  destination: routeData.destination,
  date: '2030-06-01',
  offset: '20',
})

test('search opens a public trip with accessible numbered selection and preserved search context', async ({
  page,
}, testInfo) => {
  let mutations = 0
  page.on('request', (request) => {
    if (request.url().includes('/bookings') && request.method() !== 'GET') mutations++
  })
  await page.route('**/api/v1/routes/**', (route) => {
    const path = new URL(route.request().url()).pathname
    expect(route.request().headers()).not.toHaveProperty('authorization')
    return route.fulfill({
      json: path.endsWith('/search')
        ? { items: [routeData], limit: 21, offset: 20 }
        : path.endsWith('/seats')
          ? { route_id: id, bus_id: bus, free_seats: 4, seats: seatsData() }
          : routeData,
    })
  })
  await page.goto(`/search?${params}`)
  await page.getByRole('link', { name: 'Рейс и места' }).click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Ростов-на-Дону → Գյումրի')
  const first = page.getByRole('button', { name: 'Место 1, свободно', exact: true })
  await expect(page.getByRole('button', { name: 'Место 2, временно удерживается' })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Место 3, занято' })).toBeDisabled()
  await first.focus()
  await page.keyboard.press('Space')
  await expect(first).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByRole('complementary')).toContainText('Место 1')
  await expect(page.getByRole('complementary')).toContainText('4 500,50 ₽')
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
  await page.evaluate(() => window.scrollTo(0, 0))
  await page.screenshot({ path: testInfo.outputPath('trip.png'), fullPage: true })
  await page.getByRole('button', { name: 'Обновить места' }).click()
  await expect(first).toBeEnabled()
  await expect(first).toHaveAttribute('aria-pressed', 'true')
  await page.getByRole('button', { name: 'Место 4, свободно', exact: true }).click()
  await expect(first).toHaveAttribute('aria-pressed', 'false')
  await page.getByRole('button', { name: 'Снять выбор' }).click()
  await expect(page.getByRole('button', { name: 'Снять выбор' })).toHaveCount(0)
  await first.click()
  await page.reload()
  await expect(first).toHaveAttribute('aria-pressed', 'false')
  for (const width of [320, 768, 1024]) {
    await page.setViewportSize({ width, height: 900 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false)
  }
  await page.getByRole('link', { name: 'К результатам поиска' }).click()
  await expect(page).toHaveURL(`/search?${params}`)
  expect(mutations).toBe(0)
})

test('automatic availability refresh clears a lost choice and never restores it silently', async ({
  page,
}) => {
  let seats = seatsData()
  await page.route('**/api/v1/routes/**', (route) =>
    route.fulfill({
      json: route.request().url().endsWith('/seats')
        ? {
            route_id: id,
            bus_id: bus,
            free_seats: seats.filter((seat) => seat.status === 'FREE').length,
            seats,
          }
        : routeData,
    }),
  )
  await page.goto(`/trips/${id}`)
  await page.getByRole('button', { name: 'Место 1, свободно', exact: true }).click()
  seats = seats.map((seat) => ({ ...seat, status: 'HELD' }))
  await expect(page.getByText('Выбранное место стало недоступно', { exact: true })).toBeVisible({
    timeout: 20_000,
  })
  await expect(page.getByText('Свободных мест нет', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Место 1, временно удерживается' })).toBeDisabled()
  seats = seatsData()
  await page.getByRole('button', { name: 'Обновить места' }).click()
  const first = page.getByRole('button', { name: 'Место 1, свободно', exact: true })
  await expect(first).toBeEnabled()
  await expect(first).toHaveAttribute('aria-pressed', 'false')
  await first.click()
  await expect(page.getByText('Выбранное место стало недоступно', { exact: true })).toHaveCount(0)
})

test('failed refresh hides stale choices; retry recovers, malformed and hidden trips stay unavailable', async ({
  page,
}) => {
  let mode = 'ok'
  await page.route('**/api/v1/routes/**', (route) => {
    if (mode === 'error' || mode === 'hidden')
      return route.fulfill({
        status: mode === 'error' ? 503 : 404,
        json: {
          code: mode === 'error' ? 'UNAVAILABLE' : 'ROUTE_NOT_FOUND',
          message: 'private diagnostic',
        },
      })
    return route.fulfill({
      json: route.request().url().endsWith('/seats')
        ? { route_id: id, bus_id: mode === 'invalid' ? id : bus, free_seats: 4, seats: seatsData() }
        : routeData,
    })
  })
  await page.goto(`/trips/${id}`)
  await page.getByRole('button', { name: 'Место 1, свободно', exact: true }).click()
  mode = 'error'
  await page.getByRole('button', { name: 'Обновить места' }).click()
  await expect(page.getByRole('alert')).toContainText('Не удалось проверить рейс')
  await expect(page.getByRole('button', { name: /Место 1,/ })).toHaveCount(0)
  await expect(page.getByText('private diagnostic')).toHaveCount(0)
  mode = 'ok'
  await page.getByRole('button', { name: 'Обновить места' }).click()
  await expect(
    page.getByRole('button', { name: 'Место 1, свободно', exact: true }),
  ).toHaveAttribute('aria-pressed', 'false')
  mode = 'invalid'
  await page.getByRole('button', { name: 'Обновить места' }).click()
  await expect(page.getByRole('alert')).toContainText('Данные рейса изменились')
  mode = 'hidden'
  await page.getByRole('button', { name: 'Обновить места' }).click()
  await expect(page.getByRole('alert')).toContainText('Рейс недоступен')
})

test('invalid trip URL does not issue API requests or follow an arbitrary return target', async ({
  page,
}) => {
  let requests = 0
  await page.route('**/api/v1/routes/**', (route) => {
    requests++
    return route.abort()
  })
  await page.goto('/trips/not-a-uuid?next=https://example.com')
  await expect(page.getByRole('alert')).toContainText('Некорректная ссылка')
  await expect(page.getByRole('link', { name: 'К результатам поиска' })).toHaveAttribute(
    'href',
    '/search',
  )
  expect(requests).toBe(0)
})
