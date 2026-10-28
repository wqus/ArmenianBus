import { expect, test, type BrowserContext } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'

const token = '1'.repeat(32) + '.' + 'a'.repeat(64)
const password = 'Recovered-Browser-Password-42!'

async function mock(context: BrowserContext) {
  const state = {
    signedIn: false,
    verified: false,
    resets: 0,
    verifies: 0,
    requests: 0,
    mailRequests: 0,
    mode: 'ok',
    gate: Promise.resolve(),
  }
  await context.route('**/api/v1/**', async (route) => {
    const url = new URL(route.request().url())
    expect(url.href).not.toContain(token)
    const path = url.pathname.replace('/api/v1', '')
    const reply = (json: unknown, status = 200) => route.fulfill({ status, json })
    if (path === '/auth/web/refresh')
      return state.signedIn
        ? reply({ access_token: 'mock-access', token_type: 'Bearer', expires_in: 900 })
        : reply({ code: 'UNAUTHORIZED', message: 'Login required' }, 401)
    if (path === '/me')
      return reply({
        id: 'user',
        email: 'passenger@example.com',
        role: 'PASSENGER',
        status: 'ACTIVE',
        created_at: '2030-01-01T00:00:00Z',
        email_verified_at: state.verified ? '2030-01-01T01:00:00Z' : null,
      })
    if (path === '/auth/forgot-password') {
      state.requests++
      if (state.mode === 'disabled')
        return reply({ code: 'ACCOUNT_MAIL_UNAVAILABLE', message: 'Disabled' }, 503)
      return reply({ message: 'If account exists, mail will be sent' }, 202)
    }
    if (path === '/auth/verification/request') {
      state.mailRequests++
      return reply({ message: 'Queued if needed' }, 202)
    }
    if (path === '/auth/web/reset-password' || path === '/auth/verify-email') {
      const reset = path.endsWith('reset-password')
      if (reset) state.resets++
      else state.verifies++
      expect(route.request().method()).toBe('POST')
      expect(route.request().postDataJSON()).toEqual(reset ? { token, password } : { token })
      if (reset) expect(route.request().headers()['x-armeniabus-web']).toBe('1')
      await state.gate
      if (state.mode === 'invalid')
        return reply({ code: 'ACTION_LINK_INVALID', message: 'Invalid' }, 400)
      if (state.mode === 'lost') return route.abort('failed')
      if (reset) state.signedIn = false
      else state.verified = true
      return route.fulfill({ status: 204 })
    }
    return reply({ code: 'NOT_FOUND', message: 'Not found' }, 404)
  })
  return state
}

test('forgot password has a uniform result, never submits on load, and explains disabled mail', async ({
  page,
  context,
}, info) => {
  const state = await mock(context)
  await page.goto('/login')
  await page.getByRole('link', { name: 'Забыли пароль?' }).click()
  expect(state.requests).toBe(0)
  await page.getByLabel('Электронная почта').fill('missing@example.com')
  await page.getByRole('button', { name: 'Получить ссылку' }).click()
  await expect(page.getByRole('status')).toContainText('Если аккаунт с таким адресом доступен')
  expect(state.requests).toBe(1)
  await page.getByRole('button', { name: 'Указать другой адрес' }).click()
  state.mode = 'disabled'
  await page.getByLabel('Электронная почта').fill('passenger@example.com')
  await page.getByRole('button', { name: 'Получить ссылку' }).click()
  await expect(page.getByRole('alert')).toContainText('Отправка писем сейчас недоступна')
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
  const viewport = page.viewportSize()!
  for (const width of [320, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false)
  }
  await page.setViewportSize(viewport)
  await page.evaluate(() => window.scrollTo(0, 0))
  await page.screenshot({ path: info.outputPath('forgot-password.png'), fullPage: true })
})

test('reset keeps the link out of history and storage, requires matching passwords, and submits once', async ({
  page,
  context,
}, info) => {
  const state = await mock(context)
  await page.goto(`/reset-password#token=${token}`)
  await expect(page).toHaveURL('/reset-password')
  expect(state.resets).toBe(0)
  await page.getByLabel('Новый пароль', { exact: true }).fill(password)
  await page.getByLabel('Повторите новый пароль').fill('A-Different-Password-42!')
  await page.getByRole('button', { name: 'Сохранить новый пароль' }).click()
  await expect(page.getByRole('alert')).toContainText('одинаковые пароли')
  expect(state.resets).toBe(0)
  await page.getByLabel('Повторите новый пароль').fill(password)
  expect(
    await page.evaluate(() =>
      JSON.stringify([
        location.href,
        localStorage,
        sessionStorage,
        document.documentElement.outerHTML,
      ]),
    ),
  ).not.toContain(token)
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
  await page.evaluate(() => window.scrollTo(0, 0))
  await page.screenshot({ path: info.outputPath('reset-password.png'), fullPage: true })
  let release!: () => void
  state.gate = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.getByRole('button', { name: 'Сохранить новый пароль' }).evaluate((button) => {
    ;(button as HTMLButtonElement).click()
    ;(button as HTMLButtonElement).click()
  })
  await expect.poll(() => state.resets).toBe(1)
  release()
  await expect(page.getByRole('status')).toContainText('Пароль изменён')
  await expect(page.getByLabel('Новый пароль', { exact: true })).toHaveCount(0)
  expect(state.resets).toBe(1)
})

test('expired links and uncertain resets cannot replay a mutation', async ({ page, context }) => {
  const state = await mock(context)
  for (const mode of ['invalid', 'lost']) {
    state.mode = mode
    await page.goto(`/reset-password#token=${token}`)
    await page.getByLabel('Новый пароль', { exact: true }).fill(password)
    await page.getByLabel('Повторите новый пароль').fill(password)
    await page.getByRole('button', { name: 'Сохранить новый пароль' }).click()
    await expect(page.getByRole('alert')).toContainText(
      mode === 'invalid' ? 'Ссылка недействительна' : 'пароль мог измениться',
    )
    await expect(page.getByRole('button', { name: 'Сохранить новый пароль' })).toHaveCount(0)
    await page.reload()
    await expect(page.getByText('Ссылка недоступна', { exact: true })).toBeVisible()
  }
  expect(state.resets).toBe(2)
})

test('verification requires an explicit click and updates the profile in another tab', async ({
  page,
  context,
}, info) => {
  const state = await mock(context)
  state.signedIn = true
  await page.goto('/account')
  await expect(page.getByText('Адрес ещё не подтверждён.', { exact: false })).toBeVisible()
  await page.getByRole('button', { name: 'Подтвердить электронную почту' }).click()
  await expect(page.getByText('Проверьте почту', { exact: true })).toBeVisible()
  expect(state.mailRequests).toBe(1)
  const linkPage = await context.newPage()
  await linkPage.goto(`/verify-email#token=${token}`)
  await expect(linkPage).toHaveURL('/verify-email')
  expect(state.verifies).toBe(0)
  expect((await new AxeBuilder({ page: linkPage }).analyze()).violations).toEqual([])
  await linkPage.screenshot({ path: info.outputPath('verify-email.png'), fullPage: true })
  await linkPage.getByRole('button', { name: 'Подтвердить почту', exact: true }).click()
  await expect(linkPage.getByRole('status')).toContainText('Почта подтверждена')
  await expect(page.getByText('Адрес подтверждён.', { exact: true })).toBeVisible()
  expect(state.verifies).toBe(1)
})

test('malformed link fragments never make a request and late completion respects navigation', async ({
  page,
  context,
}) => {
  const state = await mock(context)
  for (const hash of [
    '#token=bad',
    `#token=${token}&token=${token}`,
    `#token=${token}&next=//evil.test`,
  ]) {
    await page.goto('/reset-password' + hash)
    await expect(page).toHaveURL('/reset-password')
    await expect(page.getByText('Ссылка недоступна', { exact: true })).toBeVisible()
  }
  expect(state.resets).toBe(0)
  await page.goto(`/reset-password#token=${token}`)
  await page.getByLabel('Новый пароль', { exact: true }).fill(password)
  await page.getByLabel('Повторите новый пароль').fill(password)
  let release!: () => void
  state.gate = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.getByRole('button', { name: 'Сохранить новый пароль' }).click()
  await expect.poll(() => state.resets).toBe(1)
  await page.getByRole('link', { name: 'О бронировании', exact: true }).click()
  release()
  await expect(page).toHaveURL('/help')
  expect(state.resets).toBe(1)
})
