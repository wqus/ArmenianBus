import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Session } from './session'
import { safeReturnTo } from './types'

const user = {
  id: 'u-1',
  email: 'passenger@example.com',
  role: 'PASSENGER',
  status: 'ACTIVE',
  created_at: '2026-09-01T00:00:00Z',
}
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status })
const access = (token = 'token-1') => ({
  access_token: token,
  token_type: 'Bearer',
  expires_in: 900,
})

beforeEach(() => {
  let tail: Promise<unknown> = Promise.resolve()
  vi.stubGlobal('navigator', {
    locks: {
      request: (_name: string, action: () => Promise<unknown>) => {
        const next = tail.then(action)
        tail = next.catch(() => undefined)
        return next
      },
    },
  })
})
afterEach(() => vi.unstubAllGlobals())

it('coalesces parallel refresh and does not clear the cache for the same user', async () => {
  let refreshes = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, options: RequestInit) => {
      if (url.endsWith('/refresh')) return json(access(`token-${++refreshes}`))
      if (url.endsWith('/me')) return json(user)
      const token = new Headers(options.headers).get('Authorization')
      return token === 'Bearer token-1'
        ? json({ code: 'INVALID_ACCESS_TOKEN', message: 'Expired' }, 401)
        : json({ value: 'private' })
    }),
  )
  const clear = vi.fn()
  const session = new Session(clear)
  await Promise.all([session.restore(), session.restore()])
  expect(refreshes).toBe(1)
  expect(clear).not.toHaveBeenCalled()
  const results = await Promise.all([session.request('/private'), session.request('/private')])
  expect(results).toEqual([{ value: 'private' }, { value: 'private' }])
  expect(refreshes).toBe(2)
  expect(clear).not.toHaveBeenCalled()
})

it('a late restore cannot sign the user back in after logout starts', async () => {
  let release!: () => void
  let entered!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const fetchingUser = new Promise<void>((resolve) => {
    entered = resolve
  })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url.endsWith('/refresh')) return json(access())
      if (url.endsWith('/me')) {
        entered()
        await gate
        return json(user)
      }
      return new Response(null, { status: 204 })
    }),
  )
  const session = new Session(vi.fn())
  const states: string[] = []
  session.subscribe(() => states.push(session.snapshot().status))
  const restoring = session.restore()
  await fetchingUser
  const loggingOut = session.logout()
  release()
  await Promise.all([restoring, loggingOut])
  expect(states).toEqual(['anonymous'])
})

it('temporary refresh failure stays recoverable instead of claiming logout', async () => {
  let failed = true
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url.endsWith('/refresh'))
        return failed
          ? json({ code: 'DEPENDENCY_UNAVAILABLE', message: 'Unavailable' }, 503)
          : json(access())
      return json(user)
    }),
  )
  const session = new Session(vi.fn())
  await session.restore()
  expect(session.snapshot().status).toBe('unavailable')
  failed = false
  await session.restore()
  expect(session.snapshot().user).toEqual(user)
})

it('never automatically replays a mutation after a 401', async () => {
  let writes = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url.endsWith('/refresh')) return json(access())
      if (url.endsWith('/me')) return json(user)
      writes++
      return json({ code: 'INVALID_ACCESS_TOKEN', message: 'Expired' }, 401)
    }),
  )
  const session = new Session(vi.fn())
  await session.restore()
  await expect(session.request('/write', { method: 'POST', body: '{}' })).rejects.toMatchObject({
    status: 401,
  })
  expect(writes).toBe(1)
})

it('limits the return destination to known private routes', () => {
  for (const path of ['//evil.example', 'https://evil.example', '/\\evil', '/%2f%2fevil', null])
    expect(safeReturnTo(path)).toBe('/account')
  expect(safeReturnTo('/carrier')).toBe('/carrier')
})

it('discards private data arriving after logout and clears the old cache', async () => {
  let release!: () => void
  let entered!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const fetching = new Promise<void>((resolve) => {
    entered = resolve
  })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url.endsWith('/refresh')) return json(access())
      if (url.endsWith('/me')) return json(user)
      if (url.endsWith('/logout')) return new Response(null, { status: 204 })
      entered()
      await gate
      return json({ private: 'old account data' })
    }),
  )
  const clear = vi.fn()
  const session = new Session(clear)
  await session.restore()
  const pending = session.request('/private')
  const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  await fetching
  await session.logout()
  release()
  await rejected
  expect(clear).toHaveBeenCalledTimes(1)
  expect(session.snapshot().status).toBe('anonymous')
})

it('ends a rejected session after one read retry without an infinite refresh loop', async () => {
  let reads = 0
  let refreshes = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url.endsWith('/refresh')) {
        refreshes++
        return json(access())
      }
      if (url.endsWith('/me')) return json(user)
      reads++
      return json({ code: 'INVALID_ACCESS_TOKEN', message: 'Expired' }, 401)
    }),
  )
  const session = new Session(vi.fn())
  await session.restore()
  await expect(session.request('/private')).rejects.toMatchObject({ status: 401 })
  expect(reads).toBe(2)
  expect(refreshes).toBe(2)
  expect(session.snapshot().status).toBe('anonymous')
})
