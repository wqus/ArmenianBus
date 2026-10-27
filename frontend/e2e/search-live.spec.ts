import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'

test.skip(process.env.RUN_AUTH_E2E !== '1', 'requires the isolated api-e2e Compose project')

test('real search and trip selection reflect publishing, UTC day, held seats and cancellation', async ({
  page,
  request,
}) => {
  test.setTimeout(90_000)
  // Fixed isolated Compose project, verified database, fixed loopback API target.
  // Synthetic data is removed by `compose down --volumes`, including after CI failures.
  expect(process.env.API_PROXY_TARGET).toBe('http://127.0.0.1:8001')
  const api = 'http://127.0.0.1:8001/api/v1'
  const id = randomUUID()
  const password = 'Search-E2E-Password-42!'
  const adminEmail = `search-admin-${id}@example.com`
  execFileSync(
    'docker',
    [
      'compose',
      '-p',
      'armeniabus-auth-e2e',
      '--profile',
      'test',
      'exec',
      '-T',
      'api-e2e',
      'python',
      '-c',
      "from sqlalchemy.engine import make_url; from armeniabus.core.config import get_settings; assert make_url(get_settings().database_url).database == 'armeniabus_test'; from armeniabus.cli import main; raise SystemExit(main())",
      'create-admin',
      '--email',
      adminEmail,
      '--password-stdin',
    ],
    {
      cwd: fileURLToPath(new URL('../../', import.meta.url)),
      input: `${password}\n`,
      timeout: 20_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  )
  const login = async (email: string) => {
    const response = await request.post(`${api}/auth/login`, { data: { email, password } })
    expect(response.status()).toBe(200)
    return { Authorization: `Bearer ${(await response.json()).access_token}` }
  }
  const register = async (role: 'PASSENGER' | 'CARRIER') => {
    const email = `search-${role.toLowerCase()}-${id}@example.com`
    const response = await request.post(`${api}/auth/register`, {
      data: {
        email,
        password,
        role,
        ...(role === 'CARRIER' ? { company_name: `E2E ${id}`, phone: '+37499123456' } : {}),
      },
    })
    expect(response.status()).toBe(201)
    return login(email)
  }
  const admin = await login(adminEmail)
  const carrier = await register('CARRIER')
  const profile = await (await request.get(`${api}/carriers/me`, { headers: carrier })).json()
  expect(
    (
      await request.patch(`${api}/admin/carriers/${profile.id}/status`, {
        headers: admin,
        data: { status: 'ACTIVE' },
      })
    ).status(),
  ).toBe(200)
  const busResponse = await request.post(`${api}/buses`, {
    headers: carrier,
    data: { name: 'E2E single seat', capacity: 1 },
  })
  expect(busResponse.status()).toBe(201)
  const bus = await busResponse.json()
  const date = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10)
  const nextDay = new Date(Date.now() + 11 * 86_400_000).toISOString().slice(0, 10)
  const origin = `Тест ${id}`
  const response = await request.post(`${api}/routes`, {
    headers: carrier,
    data: {
      bus_id: bus.id,
      origin_country: 'RU',
      destination_country: 'AM',
      origin,
      destination: 'Գյումրի',
      departure_at: `${date}T01:00:00+03:00`,
      price: '4500.50',
      departure_timezone: 'Europe/Moscow',
      boarding_address: 'Тестовая автостанция, платформа 1',
      dropoff_address: 'Тестовая площадь, дом 2',
      currency: 'RUB',
    },
  })
  expect(response.status()).toBe(201)
  const route = await response.json()
  const search = new URLSearchParams({ origin: origin.toLowerCase(), destination: 'Գյումրի', date })
  await page.goto(`/search?${search}`)
  await expect(page.getByText('Рейсов не найдено', { exact: true })).toBeVisible()
  expect(
    (
      await request.patch(`${api}/routes/${route.id}`, {
        headers: carrier,
        data: { status: 'ACTIVE' },
      })
    ).status(),
  ).toBe(200)
  await page.getByRole('button', { name: 'Обновить рейсы' }).click()
  await expect(page.getByRole('article')).toContainText('Свободных мест: 1')
  await expect(page.getByRole('article')).toContainText('01:00 UTC+3')
  await expect(page.getByRole('article')).toContainText('4 500,50 ₽')
  // Anonymous search does not require or create a passenger session.
  expect((await page.context().cookies()).some((cookie) => cookie.name.includes('refresh'))).toBe(
    false,
  )
  await page.getByRole('link', { name: 'Рейс и места' }).click()
  const firstSeat = page.getByRole('button', { name: 'Место 1, свободно', exact: true })
  await firstSeat.click()
  await expect(firstSeat).toHaveAttribute('aria-pressed', 'true')
  await page.getByRole('button', { name: 'Обновить места' }).click()
  await expect(firstSeat).toBeEnabled()
  await expect(firstSeat).toHaveAttribute('aria-pressed', 'true')
  const passenger = await register('PASSENGER')
  const holdResponse = await request.post(`${api}/bookings`, {
    headers: passenger,
    data: {
      route_id: route.id,
      seat_id: bus.seats[0].id,
      passenger_first_name: 'Арам',
      passenger_last_name: 'Петросян',
      passenger_phone: '+37499123456',
    },
  })
  expect(holdResponse.status()).toBe(201)
  const booking = await holdResponse.json()
  await page.getByRole('button', { name: 'Обновить места' }).click()
  await expect(page.getByText('Выбранное место стало недоступно', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Место 1, временно удерживается' })).toBeDisabled()
  await page.getByRole('link', { name: 'К результатам поиска' }).click()
  await expect(page.getByRole('article')).toContainText('Свободных мест нет')
  expect(
    (await request.delete(`${api}/bookings/${booking.id}`, { headers: passenger })).status(),
  ).toBe(204)
  await page.getByRole('button', { name: 'Обновить рейсы' }).click()
  await expect(page.getByRole('article')).toContainText('Свободных мест: 1')
  await page.getByRole('link', { name: 'Рейс и места' }).click()
  await expect(firstSeat).toBeEnabled()
  await expect(firstSeat).toHaveAttribute('aria-pressed', 'false')
  await page.getByRole('link', { name: 'К результатам поиска' }).click()
  await page.getByLabel('Дата отправления').fill(nextDay)
  await page.getByRole('button', { name: 'Найти рейсы', exact: true }).click()
  await expect(page.getByText('Рейсов не найдено', { exact: true })).toBeVisible()
  // The passenger now creates and cancels their hold entirely through the browser.
  await page.goto(`/trips/${route.id}`)
  await firstSeat.click()
  await page.getByRole('link', { name: 'Перейти к бронированию' }).click()
  await expect(page).toHaveURL(/\/login\?next=/)
  await page.getByLabel('Электронная почта').fill(`search-passenger-${id}@example.com`)
  await page.getByLabel('Пароль', { exact: true }).fill(password)
  await page.getByRole('button', { name: 'Войти', exact: true }).click()
  const createResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/v1/bookings') && response.request().method() === 'POST',
  )
  await page.getByLabel('Имя пассажира', { exact: true }).fill('Арам')
  await page.getByLabel('Фамилия пассажира', { exact: true }).fill('Петросян')
  await page.getByLabel('Телефон пассажира', { exact: true }).fill('+37499123456')
  await page.getByRole('button', { name: 'Удержать место', exact: true }).click()
  const browserCreated = await createResponse
  expect(browserCreated.status()).toBe(201)
  const browserBooking = await browserCreated.json()
  await expect(page.getByRole('timer')).toBeVisible()
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Место удерживается', exact: true })).toBeVisible()
  expect((await (await request.get(`${api}/routes/${route.id}/seats`)).json()).free_seats).toBe(0)
  await page.getByRole('link', { name: 'Перейти к оплате', exact: true }).click()
  await page.getByRole('button', { name: 'Подготовить оплату', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('Оплата пока недоступна')
  const noPayment = await request.get(`${api}/bookings/${browserBooking.id}/payment`, {
    headers: passenger,
  })
  expect(noPayment.status()).toBe(404)
  expect((await noPayment.json()).code).toBe('PAYMENT_NOT_FOUND')
  await page.getByRole('link', { name: 'Открыть бронь', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Место удерживается', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Отменить удержание', exact: true }).click()
  await page.getByRole('button', { name: 'Да, освободить место' }).click()
  await expect(page.getByRole('heading', { name: 'Бронь отменена', exact: true })).toBeVisible()
  expect(
    (
      await (
        await request.get(`${api}/bookings/${browserBooking.id}`, { headers: passenger })
      ).json()
    ).status,
  ).toBe('CANCELLED')
  expect((await (await request.get(`${api}/routes/${route.id}/seats`)).json()).free_seats).toBe(1)
  await page.getByRole('link', { name: 'Мои бронирования', exact: true }).click()
  await page.getByRole('button', { name: 'История', exact: true }).click()
  await page.getByLabel('Статус брони', { exact: true }).selectOption('CANCELLED')
  await expect(page.locator(`a[href="/bookings/${browserBooking.id}"]`)).toBeVisible()
  await page.reload()
  await expect(page.getByLabel('Статус брони', { exact: true })).toHaveValue('CANCELLED')
  await page.getByLabel('Статус брони', { exact: true }).selectOption('HELD')
  await expect(page.getByText('Бронирований на этой странице нет', { exact: true })).toBeVisible()
  await page.getByLabel('Статус брони', { exact: true }).selectOption('CANCELLED')
  await page.locator(`a[href="/bookings/${browserBooking.id}"]`).click()
  await expect(page.getByRole('heading', { name: 'Бронь отменена', exact: true })).toBeVisible()
  await page.getByRole('link', { name: 'Открыть рейс' }).click()
  await firstSeat.click()
  await page.getByRole('link', { name: 'Перейти к бронированию' }).click()
  const expiringResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/v1/bookings') && response.request().method() === 'POST',
  )
  await page.getByLabel('Имя пассажира', { exact: true }).fill('Арам')
  await page.getByLabel('Фамилия пассажира', { exact: true }).fill('Петросян')
  await page.getByLabel('Телефон пассажира', { exact: true }).fill('+37499123456')
  await page.getByRole('button', { name: 'Удержать место', exact: true }).click()
  const expiring = await (await expiringResponse).json()
  await expect(page.getByRole('timer')).toBeVisible()
  // Simulate elapsed time only for this synthetic booking in the verified test database.
  execFileSync(
    'docker',
    [
      'compose',
      '-p',
      'armeniabus-auth-e2e',
      '--profile',
      'test',
      'exec',
      '-T',
      'api-e2e',
      'python',
      '-c',
      `import asyncio, sys, uuid
from datetime import timedelta
from sqlalchemy import update, func
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import create_async_engine
from armeniabus.core.config import get_settings
from armeniabus.modules.bookings.models import Booking
assert make_url(get_settings().database_url).database == 'armeniabus_test'
async def expire():
    engine = create_async_engine(get_settings().database_url)
    async with engine.begin() as connection:
        await connection.execute(update(Booking).where(Booking.id == uuid.UUID(sys.argv[1])).values(held_until=func.clock_timestamp()-timedelta(seconds=1)))
    await engine.dispose()
asyncio.run(expire())`,
      expiring.id,
    ],
    {
      cwd: fileURLToPath(new URL('../../', import.meta.url)),
      timeout: 20_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  )
  await page.getByRole('button', { name: 'Обновить статус' }).click()
  await expect(
    page.getByRole('heading', { name: 'Срок удержания истёк', exact: true }),
  ).toBeVisible()
  expect((await (await request.get(`${api}/routes/${route.id}/seats`)).json()).free_seats).toBe(1)
  expect(
    (
      await request.patch(`${api}/routes/${route.id}`, {
        headers: carrier,
        data: { status: 'CANCELLED' },
      })
    ).status(),
  ).toBe(200)
  await page.goto(`/trips/${route.id}`)
  await expect(page.getByRole('alert')).toContainText('Рейс недоступен')
  await expect(page.getByRole('button', { name: /Место 1,/ })).toHaveCount(0)
})
