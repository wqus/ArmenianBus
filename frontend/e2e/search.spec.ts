import { expect, test } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'

const date = '2030-06-01'
const params = new URLSearchParams({ origin: 'Ростов-на-Дону', destination: 'Գյումրի', date })
const item = (index = 0) => ({
  id: `route-${index}`,
  origin: 'Ростов-на-Дону',
  destination: 'Գյումրի',
  origin_country: 'RU',
  destination_country: 'AM',
  departure_at: '2030-06-02T01:00:00+03:00',
  price: '4500.50',
  currency: 'RUB',
  status: 'ACTIVE',
  company_name: `Перевозчик ${index + 1}`,
  bus_name: 'Комфорт',
  capacity: 40,
  free_seats: index === 0 ? 0 : 12,
})

test('nearby dates preserve direction, reset pagination and never imply availability', async ({
  page,
}) => {
  const datesRequested: string[] = []
  await page.route('**/api/v1/routes/search?*', (route) => {
    const url = new URL(route.request().url())
    datesRequested.push(url.searchParams.get('date')!)
    return route.fulfill({
      json: { items: [], limit: 21, offset: Number(url.searchParams.get('offset')) },
    })
  })
  await page.goto(`/search?${params}&offset=20`)
  await expect(page.getByText('На этой странице рейсов больше нет', { exact: true })).toBeVisible()
  const dates = page.getByRole('navigation', { name: 'Соседние даты отправления' })
  await expect(dates.locator('[aria-current="date"]')).toContainText('1 июн')
  expect(new Set(datesRequested)).toEqual(new Set([date]))
  await dates.getByRole('link').filter({ hasText: '31 мая' }).click()
  const expected = new URLSearchParams(params)
  expected.set('date', '2030-05-31')
  await expect(page).toHaveURL(`/search?${expected}`)
  await expect(page.getByLabel('Дата отправления (UTC)')).toHaveValue('2030-05-31')
  await expect(page.getByText('Рейсов не найдено', { exact: true })).toBeVisible()
  expect(new Set(datesRequested)).toEqual(new Set([date, '2030-05-31']))
  await page.goBack()
  await expect(page).toHaveURL(`/search?${params}&offset=20`)
  await expect(dates.locator('[aria-current="date"]')).toContainText('1 июн')
})

test('search form, URL history, pagination, UTC, sold out and accessible details', async ({
  page,
}, testInfo) => {
  await page.route('**/api/v1/routes/search?*', (route) => {
    const url = new URL(route.request().url())
    expect(url.searchParams.get('limit')).toBe('21')
    expect(route.request().headers()).not.toHaveProperty('authorization')
    const offset = Number(url.searchParams.get('offset'))
    return route.fulfill({
      json: {
        items: offset ? [item(20)] : Array.from({ length: 21 }, (_, i) => item(i)),
        limit: 21,
        offset,
      },
    })
  })
  await page.goto('/')
  await page.getByLabel('Откуда', { exact: true }).fill('  Ростов-на-Дону  ')
  await page.getByLabel('Куда', { exact: true }).fill('Գյումրի')
  await page.getByRole('button', { name: 'Поменять города местами' }).click()
  await expect(page.getByLabel('Откуда', { exact: true })).toHaveValue('Գյումրի')
  await page.getByRole('button', { name: 'Поменять города местами' }).click()
  await page.getByLabel('Дата отправления (UTC)').fill(date)
  await page.getByRole('button', { name: 'Найти рейсы', exact: true }).click()
  await expect(page).toHaveURL(`/search?${params}`)
  await expect(page.getByRole('article')).toHaveCount(20)
  const first = page.getByRole('article').first()
  await expect(first).toContainText('22:00 UTC')
  await expect(first).toContainText('1 июня 2030')
  await expect(first).toContainText('4 500,50 ₽')
  await expect(first).toContainText('Свободных мест нет')
  await first.locator('summary').click()
  await expect(first.getByText('Комфорт', { exact: true })).toBeVisible()
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
  await page.screenshot({ path: testInfo.outputPath('search.png') })
  await page.getByRole('link', { name: 'Следующая страница' }).click()
  await expect(page.getByRole('article')).toHaveCount(1)
  await expect(page.getByRole('article')).toContainText('Перевозчик 21')
  await expect(page.getByRole('link', { name: 'Следующая страница' })).toHaveCount(0)
  await page.reload()
  await expect(page.getByLabel('Откуда', { exact: true })).toHaveValue('Ростов-на-Дону')
  await expect(page.getByText('Страница 2', { exact: true })).toBeVisible()
  await page.goBack()
  await expect(page.getByRole('article')).toHaveCount(20)
  await page.getByLabel('Куда', { exact: true }).fill('Ереван')
  await page.getByRole('button', { name: 'Найти рейсы', exact: true }).click()
  expect(new URL(page.url()).searchParams.has('offset')).toBe(false)
  for (const width of [320, 768, 1024]) {
    await page.setViewportSize({ width, height: 900 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false)
  }
})

test('loading, failure, retry, empty result and invalid response', async ({ page }) => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let mode = 'error'
  await page.route('**/api/v1/routes/search?*', async (route) => {
    await gate
    if (mode === 'error')
      return route.fulfill({
        status: 503,
        json: { code: 'UNAVAILABLE', message: 'internal diagnostic must not appear' },
      })
    return route.fulfill({
      json: {
        items: mode === 'empty' ? [] : [{ ...item(), price: 'broken' }],
        limit: 21,
        offset: 0,
      },
    })
  })
  await page.goto(`/search?${params}`)
  await expect(page.getByText('Ищем рейсы…', { exact: true })).toBeVisible()
  release()
  await expect(page.getByRole('alert')).toContainText('Поиск временно недоступен')
  await expect(page.getByText('internal diagnostic', { exact: false })).toHaveCount(0)
  mode = 'empty'
  await page.getByRole('button', { name: 'Обновить рейсы' }).click()
  await expect(page.getByText('Рейсов не найдено', { exact: true })).toBeVisible()
  mode = 'invalid'
  await page.getByRole('button', { name: 'Найти рейсы', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('Не удалось прочитать данные рейсов')
})

test('invalid shared URLs never reach the API and whitespace is rejected', async ({ page }) => {
  let requests = 0
  await page.route('**/api/v1/routes/search?*', (route) => {
    requests++
    return route.fulfill({ json: { items: [], limit: 21, offset: 0 } })
  })
  await page.goto(`/search?${params}&offset=-20`)
  await expect(page.getByText('Проверьте параметры поиска', { exact: true })).toBeVisible()
  expect(requests).toBe(0)
  await page.getByLabel('Откуда', { exact: true }).fill('   ')
  await page.getByRole('button', { name: 'Найти рейсы', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('Введите названия')
  expect(requests).toBe(0)
  await page.getByLabel('Откуда', { exact: true }).fill('Москва')
  await page.getByRole('button', { name: 'Найти рейсы', exact: true }).click()
  await expect(page.getByText('Рейсов не найдено', { exact: true })).toBeVisible()
  // StrictMode may cancel and restart the first valid query in development.
  expect(requests).toBeGreaterThan(0)
})

test('a late response from the previous direction cannot replace current results', async ({
  page,
}) => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let started!: () => void
  const requestStarted = new Promise<void>((resolve) => {
    started = resolve
  })
  await page.route('**/api/v1/routes/search?*', async (route) => {
    const old = new URL(route.request().url()).searchParams.get('destination') === 'Գյումրի'
    if (old) {
      started()
      await gate
    }
    await route
      .fulfill({
        json: {
          items: [{ ...item(), destination: old ? 'Գյումրի' : 'Ереван' }],
          limit: 21,
          offset: 0,
        },
      })
      .catch(() => {})
  })
  await page.goto(`/search?${params}`)
  await requestStarted
  await page.getByLabel('Куда', { exact: true }).fill('Ереван')
  await page.getByRole('button', { name: 'Найти рейсы', exact: true }).click()
  await expect(page.getByRole('article')).toContainText('Ереван')
  release()
  await expect(page.getByRole('article')).not.toContainText('Գյումրի')
})
