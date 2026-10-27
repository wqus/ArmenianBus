import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'

test.skip(process.env.RUN_AUTH_E2E !== '1', 'requires the isolated api-e2e Compose project')
test('real admin activates a carrier, blocks its account, cancels its route and inspects audit', async ({
  page,
  request,
}) => {
  test.setTimeout(90_000)
  expect(process.env.API_PROXY_TARGET).toBe('http://127.0.0.1:8001')
  const api = 'http://127.0.0.1:8001/api/v1',
    suffix = randomUUID(),
    password = 'Admin-E2E-Password-42!',
    adminEmail = `admin-f9-${suffix}@example.com`,
    carrierEmail = `carrier-f9-${suffix}@example.com`
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
  const registered = await request.post(`${api}/auth/register`, {
    data: {
      email: carrierEmail,
      password,
      role: 'CARRIER',
      company_name: `Admin E2E ${suffix}`,
      phone: '+37499123456',
    },
  })
  expect(registered.status()).toBe(201)
  const carrierUser = await registered.json(),
    carrier = await login(carrierEmail)
  const profile = await (await request.get(`${api}/carriers/me`, { headers: carrier })).json()
  await page.goto(`/admin/carriers/${profile.id}`)
  await page.getByLabel('Электронная почта').fill(adminEmail)
  await page.getByLabel('Пароль', { exact: true }).fill(password)
  await page.getByRole('button', { name: 'Войти', exact: true }).click()
  await page.getByRole('button', { name: 'Активировать перевозчика' }).click()
  await page.getByRole('button', { name: 'Подтвердить действие' }).click()
  await expect(page.getByRole('button', { name: 'Заблокировать перевозчика' })).toBeVisible()
  const busResponse = await request.post(`${api}/buses`, {
    headers: carrier,
    data: { name: 'Admin E2E bus', capacity: 1 },
  })
  expect(busResponse.status()).toBe(201)
  const bus = await busResponse.json()
  const routeResponse = await request.post(`${api}/routes`, {
    headers: carrier,
    data: {
      bus_id: bus.id,
      origin_country: 'RU',
      destination_country: 'AM',
      origin: `Admin ${suffix}`,
      boarding_address: 'Тестовая автостанция, платформа 1',
      dropoff_address: 'Тестовая площадь, дом 2',
      destination: 'Գյումրի',
      departure_at: new Date(Date.now() + 14 * 86_400_000).toISOString(),
      price: '4500.50',
      currency: 'RUB',
    },
  })
  expect(routeResponse.status()).toBe(201)
  const route = await routeResponse.json()
  expect(
    (
      await request.patch(`${api}/routes/${route.id}`, {
        headers: carrier,
        data: { status: 'ACTIVE' },
      })
    ).status(),
  ).toBe(200)
  const passengerEmail = `passenger-f9-${suffix}@example.com`
  expect(
    (
      await request.post(`${api}/auth/register`, {
        data: { email: passengerEmail, password, role: 'PASSENGER' },
      })
    ).status(),
  ).toBe(201)
  const passenger = await login(passengerEmail)
  const held = await request.post(`${api}/bookings`, {
    headers: passenger,
    data: {
      route_id: route.id,
      seat_id: bus.seats[0].id,
      passenger_first_name: 'Арам',
      passenger_last_name: 'Петросян',
      passenger_phone: '+37499123456',
    },
  })
  expect(held.status()).toBe(201)
  const booking = await held.json()
  await page.goto(`/admin/users/${carrierUser.id}`)
  await page.getByLabel('Причина действия').fill('Проверка обращения F9')
  await page.getByRole('button', { name: 'Заблокировать аккаунт' }).click()
  await page.getByRole('button', { name: 'Подтвердить действие' }).click()
  await expect(page.getByRole('button', { name: 'Разблокировать аккаунт' })).toBeVisible()
  expect((await request.get(`${api}/buses`, { headers: carrier })).status()).toBe(403)
  await page.goto(`/admin/routes/${route.id}`)
  await page.getByLabel('Причина действия').fill('Операционная отмена F9')
  await page.getByRole('button', { name: 'Отменить рейс', exact: true }).click()
  await page.getByRole('button', { name: 'Подтвердить действие' }).click()
  await expect(page.getByText('Отменён', { exact: true })).toBeVisible()
  await page.getByRole('link', { name: 'Брони рейса' }).click()
  await expect(page.getByRole('article')).toHaveCount(1)
  await page.getByRole('link', { name: 'Открыть запись' }).click()
  await expect(page.getByRole('heading', { name: 'Данные записи' })).toBeVisible()
  const cabinetBooking = await (
    await request.get(`${api}/cabinet/bookings/${booking.id}`, { headers: passenger })
  ).json()
  expect(cabinetBooking.status).toBe('CANCELLED')
  await page.getByRole('link', { name: 'Уведомления брони' }).click()
  await expect(page.getByRole('article').first()).toBeVisible()
  await page.goto(`/admin/routes/${route.id}`)
  await page.getByRole('link', { name: 'Аудит записи' }).click()
  await expect(
    page
      .getByRole('article')
      .filter({ has: page.getByRole('heading', { name: 'route.admin_cancelled', exact: true }) }),
  ).toContainText('Операционная отмена F9')
  await page.goto('/admin')
  await expect(page.getByRole('heading', { name: 'Очереди', exact: true })).toBeVisible()
  await page.goto(`/admin/users/${carrierUser.id}`)
  await page.getByLabel('Причина действия').fill('Проверка завершена F9')
  await page.getByRole('button', { name: 'Разблокировать аккаунт' }).click()
  await page.getByRole('button', { name: 'Подтвердить действие' }).click()
  await expect(page.getByRole('button', { name: 'Заблокировать аккаунт' })).toBeVisible()
  const restored = await login(carrierEmail)
  expect((await request.get(`${api}/buses`, { headers: restored })).status()).toBe(200)
  expect((await request.get(`${api}/admin/users`, { headers: restored })).status()).toBe(403)
})
