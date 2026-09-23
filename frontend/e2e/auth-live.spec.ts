import { expect, test } from '@playwright/test'
import { randomUUID } from 'node:crypto'

test.skip(process.env.RUN_AUTH_E2E !== '1', 'requires the isolated api-e2e Compose project')

for (const role of ['PASSENGER', 'CARRIER']) {
  test(`real ${role} cookie session survives concurrent tab restore and logout`, async ({
    page,
    context,
  }) => {
    const email = `f2-${randomUUID()}@example.com`
    const password = 'Live-Browser-Test-Password-42!'
    await page.goto('/register')
    if (role === 'CARRIER') {
      await page.getByRole('radio', { name: 'Перевозчик', exact: true }).check()
      await page.getByLabel('Название компании').fill('E2E Carrier')
      await page.getByLabel('Контактный телефон').fill('+37499123456')
    }
    await page.getByLabel('Электронная почта').fill(email)
    await page.getByLabel('Пароль', { exact: true }).fill(password)
    await page.getByRole('button', { name: 'Создать аккаунт' }).click()
    await expect(page.getByText('Аккаунт создан', { exact: true })).toBeVisible()
    await page.getByLabel('Пароль', { exact: true }).fill(password)
    const responsePromise = page.waitForResponse((response) =>
      response.url().endsWith('/auth/web/login'),
    )
    await page.getByRole('button', { name: 'Войти', exact: true }).click()
    const response = await responsePromise
    expect(response.status()).toBe(200)
    expect(await response.json()).not.toHaveProperty('refresh_token')
    await expect(page.getByText(email, { exact: true })).toBeVisible()
    const cookies = await context.cookies()
    const refresh = cookies.find((cookie) => cookie.name === 'armeniabus_refresh')
    expect(refresh?.httpOnly).toBe(true)
    expect(refresh?.sameSite).toBe('Strict')
    expect(await page.evaluate(() => document.cookie)).not.toContain('armeniabus_refresh')
    expect(await page.evaluate(() => [localStorage.length, sessionStorage.length])).toEqual([0, 0])
    const second = await context.newPage()
    await Promise.all([page.reload(), second.goto('/account')])
    await expect(page.getByText(email, { exact: true })).toBeVisible()
    await expect(second.getByText(email, { exact: true })).toBeVisible()
    if (role === 'CARRIER') {
      await page.getByRole('link', { name: 'Профиль перевозчика' }).click()
      await expect(page.getByText('Ожидает проверки', { exact: true })).toBeVisible()
      await page.getByRole('link', { name: 'Мой профиль', exact: true }).click()
    }
    await page.getByRole('button', { name: 'Выйти из аккаунта' }).click()
    await expect(page).toHaveURL(/\/login/)
    await expect(second).toHaveURL(/\/login/)
    expect(
      (await context.cookies()).find((cookie) => cookie.name === 'armeniabus_refresh'),
    ).toBeUndefined()
    await page.goto('/account')
    await expect(page).toHaveURL(/\/login\?next=/)
  })
}
