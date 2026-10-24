import { expect, test } from '@playwright/test'

test('city suggestions share one identity across languages and support the keyboard', async ({
  page,
}) => {
  await page.goto('/')
  const origin = page.getByRole('combobox', { name: 'Откуда', exact: true })
  const destination = page.getByRole('combobox', { name: 'Куда', exact: true })
  await origin.fill('Mosc')
  await expect(page.getByRole('option', { name: /Москва/ })).toBeVisible()
  await origin.press('ArrowDown')
  await origin.press('Enter')
  await expect(origin).toHaveValue('Москва')
  for (const value of ['Yere', 'Ерев', 'Երև']) {
    await destination.fill(value)
    await expect(page.getByRole('option', { name: /Ереван/ })).toBeVisible()
  }
  await page.getByRole('option', { name: /Ереван/ }).click()
  await expect(destination).toHaveValue('Ереван')
  await page.getByLabel('Дата отправления (UTC)').fill('2026-11-12')
  await page.getByRole('button', { name: 'Найти рейсы', exact: true }).click()
  await expect(page).toHaveURL(/origin=ru-moscow&destination=am-yerevan/)
})

test('same-named Armavir cities remain separate options and Escape closes the list', async ({
  page,
}) => {
  await page.goto('/')
  const origin = page.getByRole('combobox', { name: 'Откуда', exact: true })
  await origin.fill('Armavir')
  await expect(page.getByRole('option')).toHaveCount(2)
  await expect(page.getByRole('option', { name: /Россия/ })).toBeVisible()
  await expect(page.getByRole('option', { name: /Армения/ })).toBeVisible()
  await origin.press('Escape')
  await expect(origin).toHaveAttribute('aria-expanded', 'false')
})
