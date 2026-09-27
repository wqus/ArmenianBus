import { expect, test } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { get } from 'node:http'

test.skip(process.env.RUN_DEPLOYMENT_SMOKE !== '1', 'use scripts/deployment_smoke.py')

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', () => {
      document.documentElement.dataset.cspViolation = 'true'
    })
  })
})

test('HTTP redirects to the public HTTPS origin', async () => {
  const response = await new Promise<{ status?: number; location?: string }>((resolve, reject) => {
    const request = get(
      { host: '127.0.0.1', port: 18080, path: '/help', headers: { Host: 'armeniabus.localhost' } },
      (result) => {
        result.resume()
        resolve({ status: result.statusCode, location: result.headers.location })
      },
    )
    request.on('error', reject)
    request.setTimeout(5000, () => request.destroy(new Error('HTTP redirect timed out')))
  })
  expect(response).toEqual({ status: 308, location: 'https://armeniabus.localhost/help' })
})

test('HTTPS serves SPA routes, immutable assets and private API boundaries', async ({ page }) => {
  const response = await page.goto('/help')
  expect(response?.status()).toBe(200)
  expect(response?.headers()['cache-control']).toBe('no-store')
  expect(response?.headers()['content-security-policy']).toContain("frame-ancestors 'none'")
  expect(response?.headers()['strict-transport-security']).toBe('max-age=31536000')
  await expect(page.getByRole('main')).toBeVisible()
  await page.reload()
  const script = await page.locator('script[src]').getAttribute('src')
  expect(script).toMatch(/^\/assets\/.*\.js$/)
  const results = await page.evaluate(async (asset) => {
    const paths = [
      asset!,
      '/assets/missing.js',
      '/api/v1/health/ready',
      '/api/v1/missing',
      '/api',
      '/docs',
      '/openapi.json',
      '/.env',
      '/src/main.tsx',
    ]
    return Promise.all(
      paths.map(async (path) => {
        const result = await fetch(path)
        return {
          path,
          status: result.status,
          type: result.headers.get('content-type'),
          cache: result.headers.get('cache-control'),
          body: await result.text(),
        }
      }),
    )
  }, script)
  expect(results[0].status).toBe(200)
  expect(results[0].cache).toContain('immutable')
  expect(results[1].status).toBe(404)
  expect(results[1].cache ?? '').not.toContain('immutable')
  expect(results[2].status).toBe(200)
  expect(results[2].cache).toBe('no-store')
  expect(JSON.parse(results[2].body)).toEqual({ status: 'ok' })
  for (const result of results.slice(3)) {
    expect(result.status, result.path).toBe(404)
    expect(result.body, result.path).not.toContain('<div id="root">')
  }
  expect(results[3].type).toContain('application/json')
  expect(await page.evaluate(() => document.documentElement.dataset.cspViolation)).toBeUndefined()
})

test('production Secure cookie login, refresh and logout work through Caddy', async ({
  page,
  context,
}) => {
  const email = `deployment-${randomUUID()}@example.com`
  const password = 'Deployment-Smoke-Password-42!'
  await page.goto('/register')
  await page.getByLabel('Электронная почта').fill(email)
  await page.getByLabel('Пароль', { exact: true }).fill(password)
  await page.getByRole('button', { name: 'Создать аккаунт' }).click()
  await expect(page.getByText('Аккаунт создан', { exact: true })).toBeVisible()
  await page.getByLabel('Пароль', { exact: true }).fill(password)
  await page.getByRole('button', { name: 'Войти', exact: true }).click()
  await expect(page.getByText(email, { exact: true })).toBeVisible()
  const cookie = (await context.cookies()).find((item) => item.name === '__Host-armeniabus_refresh')
  expect(cookie).toMatchObject({ secure: true, httpOnly: true, sameSite: 'Strict', path: '/' })
  expect(await page.evaluate(() => document.cookie)).not.toContain('armeniabus_refresh')
  await page.reload()
  await expect(page.getByText(email, { exact: true })).toBeVisible()
  const rejected = await page.evaluate(async () => {
    const response = await fetch('/api/v1/auth/web/refresh', { method: 'POST' })
    return { status: response.status, body: await response.json() }
  })
  expect(rejected).toMatchObject({ status: 403, body: { code: 'CSRF_REJECTED' } })
  await page.getByRole('button', { name: 'Выйти из аккаунта' }).click()
  await expect(page).toHaveURL(/\/login/)
  expect(
    (await context.cookies()).find((item) => item.name === '__Host-armeniabus_refresh'),
  ).toBeUndefined()
  expect(await page.evaluate(() => document.documentElement.dataset.cspViolation)).toBeUndefined()
})
