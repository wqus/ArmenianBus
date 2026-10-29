import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'

test.skip(process.env.RUN_PURCHASE_E2E !== '1', 'requires the disposable purchase harness')

test('complete purchase through real API, verified webhook, captured mail and printable confirmation', async ({
  page,
  request,
  context,
}, info) => {
  test.setTimeout(120_000)
  expect(process.env.API_PROXY_TARGET).toBe('http://127.0.0.1:8001')
  const api = 'http://127.0.0.1:8001/api/v1'
  const id = randomUUID()
  const password = 'Purchase-E2E-Password-42!'
  const adminEmail = `purchase-admin-${id}@example.com`
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
      "from sqlalchemy.engine import make_url; from armeniabus.core.config import Settings; assert make_url(Settings().database_url).database == 'armeniabus_test'; from armeniabus.cli import main; raise SystemExit(main())",
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
  const register = async (role: 'CARRIER' | 'PASSENGER') => {
    const email = `purchase-${role.toLowerCase()}-${id}@example.com`
    const response = await request.post(`${api}/auth/register`, {
      data: {
        email,
        password,
        role,
        ...(role === 'CARRIER' ? { company_name: `Purchase ${id}`, phone: '+37499123456' } : {}),
      },
    })
    expect(response.status()).toBe(201)
    return { email, headers: await login(email) }
  }
  const admin = await login(adminEmail)
  const carrier = await register('CARRIER')
  const profile = await (
    await request.get(`${api}/carriers/me`, { headers: carrier.headers })
  ).json()
  expect(
    (
      await request.patch(`${api}/admin/carriers/${profile.id}/status`, {
        headers: admin,
        data: { status: 'ACTIVE' },
      })
    ).status(),
  ).toBe(200)
  const busResponse = await request.post(`${api}/buses`, {
    headers: carrier.headers,
    data: { name: 'Purchase test bus', capacity: 1 },
  })
  expect(busResponse.status()).toBe(201)
  const bus = await busResponse.json()
  const departure = `${new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10)}T09:30:00Z`
  const origin = `Проверка ${id}`
  const created = await request.post(`${api}/routes`, {
    headers: carrier.headers,
    data: {
      bus_id: bus.id,
      origin_country: 'RU',
      destination_country: 'AM',
      origin,
      destination: 'Ереван',
      departure_at: departure,
      departure_timezone: 'Europe/Moscow',
      price: '4500.50',
      boarding_address: 'Тестовая автостанция, платформа 1',
      dropoff_address: 'Ереван, тестовая остановка',
    },
  })
  expect(created.status()).toBe(201)
  const route = await created.json()
  expect(
    (
      await request.patch(`${api}/routes/${route.id}`, {
        headers: carrier.headers,
        data: { status: 'ACTIVE' },
      })
    ).status(),
  ).toBe(200)
  const passenger = await register('PASSENGER')
  const search = new URLSearchParams({
    origin,
    destination: 'Ереван',
    date: departure.slice(0, 10),
  })
  await page.goto(`/search?${search}`)
  await page.getByRole('link', { name: 'Рейс и места' }).click()
  await page.getByRole('button', { name: 'Место 1, свободно', exact: true }).click()
  await page
    .getByRole('link', { name: /^(Бронировать|Перейти к бронированию)$/ })
    .filter({ visible: true })
    .first()
    .click()
  await page.getByLabel('Электронная почта').fill(passenger.email)
  await page.getByLabel('Пароль', { exact: true }).fill(password)
  await page.getByRole('button', { name: 'Войти', exact: true }).click()
  await page.getByLabel('Имя пассажира', { exact: true }).fill('Արամ')
  await page.getByLabel('Фамилия пассажира', { exact: true }).fill('Петросян')
  await page.getByLabel('Телефон пассажира', { exact: true }).fill('+37499123456')
  await page.getByRole('button', { name: 'Удержать место', exact: true }).click()
  await expect(page).toHaveURL(/\/bookings\/[a-f0-9-]+$/)
  const bookingId = new URL(page.url()).pathname.split('/').at(-1)!
  await page.getByRole('link', { name: 'Перейти к оплате', exact: true }).click()
  await page.getByRole('button', { name: 'Подготовить оплату', exact: true }).click()
  await context.route('https://yoomoney.ru/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<h1>Локальная платёжная страница</h1>' }),
  )
  await page.getByRole('link', { name: 'Перейти на страницу ЮKassa' }).click()
  await expect(page).toHaveURL('https://yoomoney.ru/test')
  await page.goto(`/payment/result?booking=${bookingId}&status=succeeded`)
  await expect(page.getByRole('heading', { name: 'Ожидаем результат оплаты' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Распечатать / сохранить PDF' })).toHaveCount(0)
  for (let i = 0; i < 2; i++) {
    const notified = await request.post(`http://127.0.0.1:8001/_test/purchase/${bookingId}`, {
      data: { status: 'succeeded' },
    })
    expect(notified.status()).toBe(200)
    const result = await notified.json()
    expect(result.provider_creates).toBe(1)
    expect(result.messages).toHaveLength(1)
    expect(result.messages[0].to).toBe(passenger.email)
    expect(result.messages[0].body).toContain('4500.50 RUB')
    expect(result.messages[0].body).toContain('Тестовая автостанция, платформа 1')
  }
  await page.getByRole('button', { name: 'Обновить результат' }).click()
  await expect(
    page.getByRole('heading', { name: 'Оплата подтверждена', exact: true }),
  ).toBeVisible()
  await page.getByRole('link', { name: 'Открыть бронь', exact: true }).click()
  const confirmation = page.getByRole('region', { name: 'Подтверждение оплаченной брони' })
  await expect(confirmation).toContainText('Արամ Петросян')
  await page.screenshot({ path: info.outputPath('purchase-confirmed.png'), fullPage: true })
  if (info.project.name === 'desktop') {
    const pdf = await page.pdf({ format: 'A4', path: info.outputPath('purchase-confirmation.pdf') })
    expect(pdf.toString('latin1').match(/\/Type \/Page\b/g)?.length).toBe(1)
  }
  // Reload must restore a real cookie session and retain the paid confirmation.
  await page.reload()
  await expect(confirmation).toBeVisible()
  const final = await request.get(`${api}/cabinet/bookings/${bookingId}`, {
    headers: passenger.headers,
  })
  expect((await final.json()).payment_review_reason).toBeNull()
})
