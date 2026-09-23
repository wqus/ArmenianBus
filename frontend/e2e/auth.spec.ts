import { expect, test } from '@playwright/test'
import type { BrowserContext } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'

const user = {
  id: 'ui-user',
  email: 'passenger@example.com',
  role: 'PASSENGER',
  status: 'ACTIVE',
  created_at: '2026-09-01T00:00:00Z',
}
const password = 'Browser-Test-Password-42!'

async function mockAuth(context: BrowserContext, role = 'PASSENGER') {
  let signedIn = false
  let email = user.email
  await context.route('**/api/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname
    const respond = (value: unknown, status = 200) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) })
    if (path.endsWith('/auth/register')) {
      const data = route.request().postDataJSON()
      email = data.email
      role = data.role
      return respond({ ...user, email, role }, 201)
    }
    if (path.endsWith('/web/login')) {
      const data = route.request().postDataJSON()
      if (data.password !== password)
        return respond({ code: 'INVALID_CREDENTIALS', message: 'Invalid credentials' }, 401)
      signedIn = true
      email = data.email
    }
    if (path.endsWith('/web/logout')) {
      signedIn = false
      return route.fulfill({ status: 204 })
    }
    if (path.endsWith('/web/login') || path.endsWith('/web/refresh'))
      return signedIn
        ? respond({ access_token: 'ui-access', token_type: 'Bearer', expires_in: 900 })
        : respond({ code: 'UNAUTHORIZED', message: 'Authentication required' }, 401)
    if (path.endsWith('/me') && !path.includes('/carriers'))
      return respond({ ...user, email, role })
    if (path.endsWith('/carriers/me'))
      return respond({
        company_name: 'Тестовый перевозчик',
        phone: '+37499123456',
        status: 'PENDING',
      })
    return respond({ code: 'NOT_FOUND', message: 'Not found' }, 404)
  })
}

test('registration, login errors, reload, role guard, and logout across tabs', async ({
  page,
  context,
}, testInfo) => {
  await mockAuth(context)
  await page.goto('/account')
  await expect(page).toHaveURL(/\/login\?next=/)
  await page.getByRole('link', { name: 'Зарегистрироваться', exact: true }).click()
  await page.getByLabel('Электронная почта').fill(user.email)
  await page.getByLabel('Пароль', { exact: true }).fill(password)
  await page.getByRole('button', { name: 'Создать аккаунт' }).click()
  await expect(page.getByText('Аккаунт создан', { exact: true })).toBeVisible()
  await page.getByLabel('Пароль', { exact: true }).fill('incorrect-password')
  await page.getByRole('button', { name: 'Войти', exact: true }).click()
  await expect(page.getByText('Неверная почта или пароль.', { exact: true })).toBeVisible()
  await page.getByLabel('Пароль', { exact: true }).fill(password)
  await page.screenshot({ path: testInfo.outputPath('login.png'), fullPage: true })
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
  await page.getByRole('button', { name: 'Войти', exact: true }).click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Мой профиль')
  expect(await page.evaluate(() => [localStorage.length, sessionStorage.length])).toEqual([0, 0])
  await page.reload()
  await expect(page.getByText(user.email, { exact: true })).toBeVisible()
  await page.goto('/carrier')
  await expect(page.getByRole('heading', { name: 'Нет доступа' })).toBeVisible()
  await page.getByRole('link', { name: 'Мой профиль', exact: true }).click()
  const second = await context.newPage()
  await second.goto('/account')
  await expect(second.getByText(user.email, { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Выйти из аккаунта' }).click()
  await expect(second).toHaveURL(/\/login\?next=/)
  await expect(page).toHaveURL(/\/login/)
})

test('carrier registration creates pending company and preserves role restrictions', async ({
  page,
  context,
}) => {
  await mockAuth(context)
  await page.goto('/carriers')
  await page.getByRole('link', { name: 'Зарегистрировать компанию' }).click()
  await expect(page.getByRole('radio', { name: 'Перевозчик', exact: true })).toBeChecked()
  await page.getByLabel('Название компании').fill('Тестовый перевозчик')
  await page.getByLabel('Контактный телефон').fill('+37499123456')
  await page.getByLabel('Электронная почта').fill('carrier@example.com')
  await page.getByLabel('Пароль', { exact: true }).fill(password)
  await page.getByRole('button', { name: 'Создать аккаунт' }).click()
  await expect(page.getByText('Аккаунт создан', { exact: true })).toBeVisible()
  await page.getByLabel('Пароль', { exact: true }).fill(password)
  await page.getByRole('button', { name: 'Войти', exact: true }).click()
  await page.getByRole('link', { name: 'Профиль перевозчика' }).click()
  await expect(page.getByText('Ожидает проверки', { exact: true })).toBeVisible()
  await expect(page.getByText('Тестовый перевозчик', { exact: true })).toBeVisible()
  await page.goto('/admin')
  await expect(page.getByRole('heading', { name: 'Нет доступа' })).toBeVisible()
})
