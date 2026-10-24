import { expect, test } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'

test('public shell, responsive navigation, FAQ, and missing page', async ({ page }, testInfo) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto('/')
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Автобусные рейсы')
  await expect(page.getByRole('link', { name: 'Найти свою поездку' })).toHaveAttribute(
    'href',
    '#search',
  )
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  )
  expect(overflow).toBe(false)
  await page.screenshot({ path: testInfo.outputPath('home.png'), fullPage: true })
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
  if (testInfo.project.name === 'mobile') await page.getByRole('button', { name: 'Меню' }).click()
  await page.getByRole('navigation').getByRole('link', { name: 'Помощь' }).click()
  await expect(page).toHaveTitle('Давайте разберёмся — armatrans')
  await page
    .locator('summary')
    .filter({ hasText: 'Когда место считается забронированным?' })
    .click()
  await expect(page.getByText('После выбора места сервис создаёт', { exact: false })).toBeVisible()
  await page.reload()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Давайте разберёмся')
  await page.goto('/missing-page')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Кажется, мы свернули')
  await page.getByRole('link', { name: 'На главную', exact: true }).click()
  await expect(page).toHaveURL('/')
  expect(errors).toEqual([])
})

test('development API status handles failure and recovery', async ({ page }) => {
  await page.route('**/api/v1/health/ready', (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({
        code: 'DEPENDENCY_UNAVAILABLE',
        message: 'Service is not ready',
        request_id: 'probe',
      }),
    }),
  )
  await page.goto('/design-system')
  await expect(page.getByText('API недоступен', { exact: true })).toBeVisible()
  await page.route('**/api/v1/health/ready', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{"status":"ok"}' }),
  )
  await page.getByRole('button', { name: 'Проверить снова' }).click()
  await expect(page.getByText('API подключён', { exact: true })).toBeVisible()
  await expect(page.getByLabel('Электронная почта')).toHaveAttribute('aria-invalid', 'true')
})

test('narrow and tablet layouts stay within viewport', async ({ page }) => {
  for (const width of [320, 768, 1024]) {
    await page.setViewportSize({ width, height: 900 })
    await page.goto('/')
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),
    ).toBe(false)
  }
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('button', { name: 'Меню' }).click()
  await expect(page.getByRole('button', { name: 'Закрыть' })).toHaveAttribute(
    'aria-expanded',
    'true',
  )
  await page.keyboard.press('Escape')
  await expect(page.getByRole('button', { name: 'Меню' })).toBeFocused()
  await expect(page.getByRole('navigation')).toBeHidden()
})
