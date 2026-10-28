import { apiRequest, ApiError } from '../../shared/api/client'
import { authMessage, readAccess, readUser } from './types'
import type { SessionState } from './types'

type Login = { email: string; password: string }
const LOCK = 'armeniabus-browser-session'
const unsupported = () =>
  new ApiError(0, { code: 'BROWSER_UNSUPPORTED', message: 'Browser session unavailable' })
const supportsSession = () =>
  typeof navigator !== 'undefined' && !!navigator.locks && typeof BroadcastChannel === 'function'

async function sessionLock<T>(action: () => Promise<T>): Promise<T> {
  // HTTPS (and localhost) Web Locks serializes cookie rotation/login/logout across tabs.
  if (!supportsSession()) throw unsupported()
  return navigator.locks.request(LOCK, action)
}

function webRequest(path: string, body?: Login) {
  return apiRequest<unknown>(`/auth/web/${path}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'X-ArmeniaBus-Web': '1' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
}

export class Session {
  private state: SessionState = { status: 'loading', user: null }
  private token: string | null = null
  private expiresAt = 0
  private revision = 0
  private refreshJob: Promise<void> | null = null
  private listeners = new Set<() => void>()
  private channel: BroadcastChannel | null = null
  private transportError: ApiError | null = null

  constructor(private clearPrivateData: () => void) {}
  snapshot = () => this.state
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  private publish(state: SessionState) {
    this.state = state
    this.listeners.forEach((listener) => listener())
  }
  private reset() {
    if (this.token || this.state.user) this.clearPrivateData()
    this.token = null
    this.expiresAt = 0
  }

  connect() {
    let channel: BroadcastChannel
    try {
      if (!supportsSession()) throw unsupported()
      channel = new BroadcastChannel(LOCK)
      this.transportError = null
    } catch {
      this.transportError = unsupported()
      return () => {}
    }
    this.channel = channel
    channel.onmessage = (event: MessageEvent<unknown>) => {
      if (event.data === 'profile') {
        void this.reloadUser(false).catch(() => {})
        return
      }
      if (event.data !== 'login' && event.data !== 'logout') return
      this.revision++
      this.reset()
      this.refreshJob = null
      this.publish({ status: event.data === 'logout' ? 'anonymous' : 'loading', user: null })
      if (event.data === 'login') void this.restore()
    }
    return () => {
      channel.close()
      if (this.channel === channel) this.channel = null
    }
  }

  private async accept(value: unknown, revision: number) {
    const access = readAccess(value)
    const user = readUser(
      await apiRequest('/me', { headers: { Authorization: `Bearer ${access.access_token}` } }),
    )
    if (revision !== this.revision) return
    if (user.status !== 'ACTIVE')
      throw new ApiError(403, { code: 'USER_BLOCKED', message: 'Blocked' })
    if (this.state.user && this.state.user.id !== user.id) {
      this.revision++
      this.clearPrivateData()
    }
    this.token = access.access_token
    this.expiresAt = Date.now() + access.expires_in * 1000
    this.publish({ status: 'authenticated', user })
  }

  restore = (): Promise<void> => {
    if (this.transportError) {
      this.reset()
      this.publish({ status: 'unavailable', user: null, message: authMessage(this.transportError) })
      return Promise.resolve()
    }
    if (this.refreshJob) return this.refreshJob
    const revision = this.revision
    const job = sessionLock(async () => {
      if (revision !== this.revision) return
      try {
        await this.accept(await webRequest('refresh'), revision)
      } catch (error) {
        if (revision !== this.revision) return
        this.revision++
        this.reset()
        const anonymous =
          error instanceof ApiError &&
          (error.status === 401 || error.problem.code === 'USER_BLOCKED')
        this.publish({
          status: anonymous ? 'anonymous' : 'unavailable',
          user: null,
          message:
            anonymous && error instanceof ApiError && error.status === 401
              ? undefined
              : authMessage(error),
        })
      }
    }).catch((error) => {
      if (revision === this.revision) {
        this.reset()
        this.publish({ status: 'unavailable', user: null, message: authMessage(error) })
      }
    })
    this.refreshJob = job
    void job.finally(() => {
      if (this.refreshJob === job) this.refreshJob = null
    })
    return job
  }

  async login(data: Login) {
    if (this.transportError) throw this.transportError
    const revision = ++this.revision
    this.reset()
    this.publish({ status: 'loading', user: null })
    try {
      await sessionLock(async () => {
        if (revision !== this.revision) return
        const value = await webRequest('login', data)
        await this.accept(value, revision)
        this.channel?.postMessage('login')
      })
    } catch (error) {
      if (revision === this.revision) this.publish({ status: 'anonymous', user: null })
      throw error
    }
  }

  async logout() {
    ++this.revision
    await sessionLock(async () => {
      await webRequest('logout')
      this.reset()
      this.publish({ status: 'anonymous', user: null })
      this.channel?.postMessage('logout')
    })
  }

  forget() {
    this.revision++
    this.reset()
    this.refreshJob = null
    this.publish({ status: 'anonymous', user: null })
    this.channel?.postMessage('logout')
  }

  async reloadUser(broadcast = true) {
    if (!this.state.user) return
    const revision = this.revision
    const user = readUser(await this.request('/me'))
    if (revision === this.revision && user.id === this.state.user?.id) {
      this.publish({ status: 'authenticated', user })
      if (broadcast) this.channel?.postMessage('profile')
    }
  }

  async request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const startedRevision = this.revision
    if (!this.token || Date.now() >= this.expiresAt - 30_000) await this.restore()
    const token = this.token
    if (!token)
      throw new ApiError(401, { code: 'UNAUTHORIZED', message: 'Authentication required' })
    // A refresh may discover another signed-in account. Never send the old intent as that user.
    if (startedRevision !== this.revision) throw new DOMException('Session changed', 'AbortError')
    const revision = this.revision
    const perform = (access: string) => {
      const headers = new Headers(options.headers)
      headers.set('Authorization', `Bearer ${access}`)
      return apiRequest<T>(path, { ...options, headers })
    }
    let result: T
    try {
      result = await perform(token)
    } catch (error) {
      if (error instanceof ApiError && error.problem.code === 'USER_BLOCKED') {
        this.revision++
        this.reset()
        this.publish({ status: 'anonymous', user: null, message: authMessage(error) })
        this.channel?.postMessage('logout')
        throw error
      }
      if (!(error instanceof ApiError) || error.status !== 401 || revision !== this.revision)
        throw error
      if (this.token === token) await this.restore()
      // Reads may retry once after refresh. Never replay a state-changing request.
      if (!this.token || (options.method ?? 'GET').toUpperCase() !== 'GET') throw error
      if (revision !== this.revision) throw new DOMException('Session changed', 'AbortError')
      try {
        result = await perform(this.token)
      } catch (retryError) {
        if (
          revision === this.revision &&
          retryError instanceof ApiError &&
          (retryError.status === 401 || retryError.problem.code === 'USER_BLOCKED')
        ) {
          this.revision++
          this.reset()
          this.publish({ status: 'anonymous', user: null, message: authMessage(retryError) })
          this.channel?.postMessage('logout')
        }
        throw retryError
      }
    }
    if (revision !== this.revision) throw new DOMException('Session changed', 'AbortError')
    return result
  }
}
