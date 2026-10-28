import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'

test.skip(
  process.env.RUN_AUTH_E2E !== '1',
  'requires isolated API and synthetic account-mail queue',
)

test('real email verification and password recovery revoke all old sessions and reject reused links', async ({
  page,
  context,
  request,
}) => {
  test.setTimeout(100_000)
  expect(process.env.API_PROXY_TARGET).toBe('http://127.0.0.1:8001')
  const api = 'http://127.0.0.1:8001/api/v1'
  const email = `recovery-${randomUUID()}@example.com`
  const oldPassword = 'Original-Recovery-Test-42!'
  const newPassword = 'Recovered-Recovery-Test-42!'
  const created = await request.post(`${api}/auth/register`, {
    data: { email, password: oldPassword, role: 'PASSENGER' },
  })
  expect(created.status()).toBe(201)
  const oldLogin = await request.post(`${api}/auth/login`, {
    data: { email, password: oldPassword },
  })
  const oldPair = await oldLogin.json()
  const oldHeaders = { Authorization: `Bearer ${oldPair.access_token}` }
  function syntheticLink(purpose: 'VERIFY' | 'RESET'): string {
    // Read only a synthetic email from the verified disposable test database.
    // There is no SMTP worker or external delivery in this Compose project.
    const code = [
      'import asyncio, json, re, sys',
      'from sqlalchemy import select',
      'from sqlalchemy.engine import make_url',
      'from armeniabus.core.config import Settings',
      'from armeniabus.infrastructure.db.session import create_session_factory',
      'from armeniabus.modules.users.models import AuthAction, User',
      'from armeniabus.modules.users.mail import account_message',
      'settings = Settings()',
      "assert make_url(settings.database_url).database == 'armeniabus_test'",
      "assert sys.argv[1].startswith('recovery-') and sys.argv[1].endswith('@example.com')",
      'async def run():',
      '    engine, sessions = create_session_factory(settings.database_url)',
      '    try:',
      '        async with sessions() as db:',
      '            action = await db.scalar(select(AuthAction).join(User).where(User.email == sys.argv[1], AuthAction.purpose == sys.argv[2]).order_by(AuthAction.created_at.desc()))',
      '            assert action is not None',
      '            body = account_message(action, settings).body',
      "            url = re.search(r'http://127.0.0.1:5174/\\S+', body)[0]",
      '            print(json.dumps({"url": url}))',
      '    finally:',
      '        await engine.dispose()',
      'asyncio.run(run())',
    ].join('\n')
    const result = execFileSync(
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
        code,
        email,
        purpose,
      ],
      {
        cwd: fileURLToPath(new URL('../../', import.meta.url)),
        timeout: 20_000,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    )
    return JSON.parse(result.toString()).url
  }
  await page.goto('/login')
  await page.getByLabel('Электронная почта').fill(email)
  await page.getByLabel('Пароль', { exact: true }).fill(oldPassword)
  await page.getByRole('button', { name: 'Войти', exact: true }).click()
  await expect(page).toHaveURL('/account')
  const linkPage = await context.newPage()
  await linkPage.goto(syntheticLink('VERIFY'))
  await expect(linkPage).toHaveURL('/verify-email')
  expect(
    (await (await request.get(`${api}/me`, { headers: oldHeaders })).json()).email_verified_at,
  ).toBeNull()
  await linkPage.getByRole('button', { name: 'Подтвердить почту', exact: true }).click()
  await expect(linkPage.getByRole('status')).toContainText('Почта подтверждена')
  await expect(page.getByText('Адрес подтверждён.', { exact: true })).toBeVisible()
  await linkPage.goto('/forgot-password')
  await linkPage.getByLabel('Электронная почта').fill(email)
  await linkPage.getByRole('button', { name: 'Получить ссылку' }).click()
  await expect(linkPage.getByRole('status')).toContainText('Проверьте почту')
  const resetUrl = syntheticLink('RESET')
  await linkPage.goto(resetUrl)
  await expect(linkPage).toHaveURL('/reset-password')
  await linkPage.getByLabel('Новый пароль', { exact: true }).fill(newPassword)
  await linkPage.getByLabel('Повторите новый пароль').fill(newPassword)
  await linkPage.getByRole('button', { name: 'Сохранить новый пароль' }).click()
  await expect(linkPage.getByRole('status')).toContainText('Пароль изменён')
  await expect(page).toHaveURL(/\/login\?next=/)
  expect((await request.get(`${api}/me`, { headers: oldHeaders })).status()).toBe(401)
  expect(
    (
      await request.post(`${api}/auth/refresh`, { data: { refresh_token: oldPair.refresh_token } })
    ).status(),
  ).toBe(401)
  expect(
    (await request.post(`${api}/auth/login`, { data: { email, password: oldPassword } })).status(),
  ).toBe(401)
  await linkPage.getByRole('link', { name: 'Войти в аккаунт', exact: true }).click()
  await linkPage.getByLabel('Электронная почта').fill(email)
  await linkPage.getByLabel('Пароль', { exact: true }).fill(newPassword)
  await linkPage.getByRole('button', { name: 'Войти', exact: true }).click()
  await expect(linkPage).toHaveURL('/account')
  await expect(linkPage.getByText('Адрес подтверждён.', { exact: true })).toBeVisible()
  await linkPage.goto(resetUrl)
  await linkPage.getByLabel('Новый пароль', { exact: true }).fill(newPassword)
  await linkPage.getByLabel('Повторите новый пароль').fill(newPassword)
  await linkPage.getByRole('button', { name: 'Сохранить новый пароль' }).click()
  await expect(linkPage.getByRole('alert')).toContainText('Ссылка недействительна')
})
