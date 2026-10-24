import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'

test.skip(process.env.RUN_AUTH_E2E !== '1', 'requires the isolated api-e2e Compose project')

test('real carrier creates and publishes a trip, views its hold, cancels it and archives the bus', async ({
  page,
  request,
}) => {
  test.setTimeout(90_000)
  expect(process.env.API_PROXY_TARGET).toBe('http://127.0.0.1:8001')
  const api = 'http://127.0.0.1:8001/api/v1'
  const suffix = randomUUID()
  const password = 'Carrier-E2E-Password-42!'
  const adminEmail = `carrier-admin-${suffix}@example.com`
  const email = `carrier-${suffix}@example.com`
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
  expect(
    (
      await request.post(`${api}/auth/register`, {
        data: {
          email,
          password,
          role: 'CARRIER',
          company_name: `E2E ${suffix}`,
          phone: '+37499123456',
        },
      })
    ).status(),
  ).toBe(201)
  const carrier = await login(email),
    admin = await login(adminEmail)
  const profile = await (await request.get(`${api}/carriers/me`, { headers: carrier })).json()
  await page.goto('/carrier/buses/new')
  await page.getByLabel('Электронная почта').fill(email)
  await page.getByLabel('Пароль', { exact: true }).fill(password)
  await page.getByRole('button', { name: 'Войти', exact: true }).click()
  await expect(page.getByText('Ожидается активация', { exact: true })).toBeVisible()
  expect(
    (
      await request.patch(`${api}/admin/carriers/${profile.id}/status`, {
        headers: admin,
        data: { status: 'ACTIVE' },
      })
    ).status(),
  ).toBe(200)
  await page.getByRole('button', { name: 'Проверить активацию' }).click()
  await page.getByLabel('Название автобуса').fill('Автобус F8')
  await page.getByLabel('Модель транспорта').selectOption('other')
  await page.getByLabel('Схема салона', { exact: true }).selectOption('van-8-v1')
  await page.getByRole('checkbox', { name: /Подтверждаю/ }).check()
  await page.getByRole('button', { name: 'Создать автобус' }).click()
  await expect(page.getByRole('heading', { name: 'Автобус F8' })).toBeVisible()
  const busId = new URL(page.url()).pathname.split('/').at(-1)!
  await page.getByLabel('Название автобуса').fill('Автобус F8 обновлён')
  await page.getByRole('button', { name: 'Сохранить название' }).click()
  await expect(page.getByRole('heading', { name: 'Автобус F8 обновлён' })).toBeVisible()
  await page.getByRole('link', { name: 'Создать рейс на этом автобусе' }).click()
  const departure = new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10) + 'T12:30'
  const origin = `F8 ${suffix}`
  await page.getByLabel('Город отправления', { exact: true }).fill(origin)
  await page.getByLabel('Город прибытия', { exact: true }).fill('Գյումրի')
  await page.getByLabel('Отправление (UTC)').fill(departure)
  await page.getByLabel('Цена билета, ₽').fill('4500,55')
  await page.getByRole('button', { name: 'Создать черновик' }).click()
  await expect(page.getByRole('heading', { name: 'Управление рейсом', exact: true })).toBeVisible()
  const routeId = new URL(page.url()).pathname.split('/').at(-1)!
  await page.getByRole('link', { name: 'Изменить данные' }).click()
  await page.getByLabel('Цена билета, ₽').fill('4600.01')
  await page.getByRole('button', { name: 'Сохранить изменения рейса' }).click()
  await expect(page.getByText('Черновик', { exact: true })).toBeVisible()
  await expect(page.getByText('4 600,01 ₽', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Опубликовать рейс' }).click()
  await page.getByRole('button', { name: 'Подтвердить действие' }).click()
  await expect(page.getByText('Опубликован', { exact: true })).toBeVisible()
  await expect(page.getByText('4 600,01 ₽', { exact: true })).toBeVisible()
  const saved = await (
    await request.get(`${api}/routes/my/${routeId}`, { headers: carrier })
  ).json()
  expect(saved.price).toBe('4600.01')
  expect(Date.parse(saved.departure_at)).toBe(Date.parse(departure + ':00Z'))
  const passengerEmail = `passenger-${suffix}@example.com`
  expect(
    (
      await request.post(`${api}/auth/register`, {
        data: { email: passengerEmail, password, role: 'PASSENGER' },
      })
    ).status(),
  ).toBe(201)
  const passenger = await login(passengerEmail)
  const bus = await (await request.get(`${api}/buses/${busId}`, { headers: carrier })).json()
  expect(bus.layout_id).toBe('van-8-v1')
  expect(bus.capacity).toBe(8)
  const availability = await (await request.get(`${api}/routes/${routeId}/seats`)).json()
  expect(availability.layout_id).toBe(bus.layout_id)
  await page.goto(`/trips/${routeId}`)
  await expect(page.locator('.cabin-seat')).toHaveCount(8)
  await page.getByRole('button', { name: 'Место 1, свободно', exact: true }).click()
  await expect(page.getByRole('link', { name: 'Перейти к бронированию' })).toHaveAttribute(
    'href',
    `/trips/${routeId}/book?seat=${bus.seats[0].id}`,
  )
  await page.goto(`/carrier/routes/${routeId}`)
  await expect(page.getByRole('heading', { name: 'Управление рейсом', exact: true })).toBeVisible()
  const held = await request.post(`${api}/bookings`, {
    headers: passenger,
    data: {
      route_id: routeId,
      seat_id: bus.seats[0].id,
      passenger_first_name: 'Арам',
      passenger_last_name: 'Петросян',
      passenger_phone: '+37499123456',
    },
  })
  expect(held.status()).toBe(201)
  const booking = await held.json()
  await page.getByRole('link', { name: 'Бронирования рейса' }).click()
  await expect(page.getByRole('article')).toHaveCount(1)
  await page.getByRole('link', { name: 'Открыть бронь' }).click()
  await expect(page.getByRole('heading', { name: 'Бронь на ваш рейс', exact: true })).toBeVisible()
  await expect(page.getByText('Место удерживается', { exact: true })).toBeVisible()
  await page.getByRole('link', { name: 'Открыть рейс' }).click()
  await page.getByRole('link', { name: 'Изменить данные' }).click()
  await page.getByLabel('Цена билета, ₽').fill('4700.00')
  await page.getByRole('button', { name: 'Сохранить изменения рейса' }).click()
  await expect(page.getByRole('alert')).toContainText('уже были бронирования')
  await page.goto(`/carrier/routes/${routeId}`)
  await page.getByRole('button', { name: 'Отменить рейс', exact: true }).click()
  await page.getByRole('button', { name: 'Подтвердить действие' }).click()
  await expect(page.getByText('Отменён', { exact: true })).toBeVisible()
  await expect(page.getByText('4 600,01 ₽', { exact: true })).toBeVisible()
  const cancelled = await (
    await request.get(`${api}/carriers/me/bookings/${booking.id}`, { headers: carrier })
  ).json()
  expect(cancelled.status).toBe('CANCELLED')
  // A second active carrier cannot inspect either the route or its booking.
  const otherEmail = `other-carrier-${suffix}@example.com`
  expect(
    (
      await request.post(`${api}/auth/register`, {
        data: {
          email: otherEmail,
          password,
          role: 'CARRIER',
          company_name: 'Other E2E',
          phone: '+37499123457',
        },
      })
    ).status(),
  ).toBe(201)
  const other = await login(otherEmail)
  const otherProfile = await (await request.get(`${api}/carriers/me`, { headers: other })).json()
  expect(
    (
      await request.patch(`${api}/admin/carriers/${otherProfile.id}/status`, {
        headers: admin,
        data: { status: 'ACTIVE' },
      })
    ).status(),
  ).toBe(200)
  for (const path of [
    `/routes/my/${routeId}`,
    `/buses/${busId}`,
    `/carriers/me/bookings/${booking.id}`,
  ])
    expect((await request.get(api + path, { headers: other })).status()).toBe(404)
  await page.getByRole('link', { name: 'Автобус рейса' }).click()
  await page.getByRole('button', { name: 'Архивировать автобус', exact: true }).click()
  await page.getByRole('button', { name: 'Да, архивировать автобус' }).click()
  await expect(page).toHaveURL('/carrier/buses')
  await expect(page.getByText('Автобусов на этой странице нет', { exact: true })).toBeVisible()
  expect((await request.get(`${api}/buses/${busId}`, { headers: carrier })).status()).toBe(404)
})
