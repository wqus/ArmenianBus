import { expect, test } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { readFileSync } from 'node:fs'
import type { VehicleLayout } from '../src/features/vehicles/catalog'

const layouts = (
  JSON.parse(
    readFileSync(new URL('../src/features/vehicles/layouts.json', import.meta.url), 'utf8'),
  ) as { layouts: VehicleLayout[] }
).layouts

const routeId = '11111111-1111-4111-8111-111111111111'
const busId = '22222222-2222-4222-8222-222222222222'

test('all cabin templates preserve seat identity, availability, keyboard selection and booking links', async ({
  page,
}, info) => {
  let current = layouts[0]
  let lost = false
  let mutations = 0
  page.on('request', (r) => {
    if (r.url().includes('/bookings') && r.method() !== 'GET') mutations++
  })
  await page.route('**/api/v1/routes/**', (r) => {
    const seats = Array.from({ length: current.capacity }, (_, n) => ({
      id: `33333333-3333-4333-8333-${String(n + 1).padStart(12, '0')}`,
      seat_number: n + 1,
      status: n === 1 || (n === 0 && lost) ? 'HELD' : n === 2 ? 'PAID' : 'FREE',
    }))
    const free_seats = seats.filter((s) => s.status === 'FREE').length
    return r.fulfill({
      json: r.request().url().endsWith('/seats')
        ? {
            route_id: routeId,
            bus_id: busId,
            layout_id: current.id,
            seats,
            free_seats,
          }
        : {
            id: routeId,
            bus_id: busId,
            origin: 'Москва',
            destination: 'Ереван',
            origin_country: 'RU',
            destination_country: 'AM',
            departure_at: '2030-11-12T12:30:00Z',
            price: '8500.00',
            currency: 'RUB',
            status: 'ACTIVE',
            company_name: 'Пример перевозчика',
            bus_name: 'Автобус со схемой',
            capacity: current.capacity,
            free_seats,
          },
    })
  })
  for (const layout of layouts) {
    current = layout
    lost = false
    await page.goto(`/trips/${routeId}`)
    await expect(page.locator('.cabin')).toBeVisible()
    await expect(page.locator('.cabin-seat')).toHaveCount(layout.capacity)
    await expect(
      page.getByRole('button', { name: 'Место 2, временно удерживается', exact: true }),
    ).toBeDisabled()
    await expect(page.getByRole('button', { name: 'Место 3, занято', exact: true })).toBeDisabled()
    const first = page.getByRole('button', { name: 'Место 1, свободно', exact: true })
    await first.focus()
    await first.press('ArrowDown')
    await expect(page.locator(`.cabin-seat[data-seat-number="${layout.rows[1][0]}"]`)).toBeFocused()
    await first.click()
    await expect(first).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByRole('link', { name: 'Перейти к бронированию' })).toHaveAttribute(
      'href',
      `/trips/${routeId}/book?seat=33333333-3333-4333-8333-000000000001`,
    )
    if (['minibus-19-v1', 'coach-49-v1'].includes(layout.id)) {
      await page.screenshot({ path: info.outputPath(`${layout.id}.png`), fullPage: true })
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false)
  }
  lost = true
  await page.getByRole('button', { name: 'Обновить места' }).click()
  await expect(page.getByText('Выбранное место стало недоступно', { exact: true })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Перейти к бронированию' })).toHaveCount(0)
  lost = false
  await page.getByRole('button', { name: 'Обновить места' }).click()
  await expect(
    page.getByRole('button', { name: 'Место 1, свободно', exact: true }),
  ).toHaveAttribute('aria-pressed', 'false')
  expect(mutations).toBe(0)
})
