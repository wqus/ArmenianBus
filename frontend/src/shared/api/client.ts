export type ApiProblem = {
  code: string
  message: string
  request_id?: string
  details?: unknown
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public problem: ApiProblem,
  ) {
    super(problem.message)
    this.name = 'ApiError'
  }
}

function isProblem(value: unknown): value is ApiProblem {
  return (
    typeof value === 'object' &&
    value !== null &&
    'code' in value &&
    typeof value.code === 'string' &&
    'message' in value &&
    typeof value.message === 'string'
  )
}

// Same-origin /api: Vite proxies it locally; the deployment proxy must do the same.
// No credentials or session tokens are persisted by this foundation layer.
export async function apiRequest<T>(path: string, options: RequestInit = {}): Promise<T> {
  if (!path.startsWith('/') || path.startsWith('//')) throw new Error('API path must be relative')
  const headers = new Headers(options.headers)
  headers.set('Accept', 'application/json')
  if (typeof options.body === 'string' && !headers.has('Content-Type'))
    headers.set('Content-Type', 'application/json')
  const timeout = AbortSignal.timeout(10_000)
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
  let response: Response
  try {
    response = await fetch(`/api/v1${path}`, {
      ...options,
      headers,
      signal,
      credentials: 'omit',
      redirect: 'error',
    })
  } catch (error) {
    if (options.signal?.aborted) throw error
    throw new ApiError(0, {
      code: timeout.aborted ? 'REQUEST_TIMEOUT' : 'NETWORK_ERROR',
      message: timeout.aborted
        ? 'Сервис отвечает дольше обычного. Попробуйте ещё раз.'
        : 'Не удалось связаться с сервисом. Проверьте соединение.',
    })
  }
  if (response.status === 204) return undefined as T
  const data: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    throw new ApiError(
      response.status,
      isProblem(data)
        ? data
        : {
            code: 'HTTP_ERROR',
            message: 'Не удалось выполнить запрос. Попробуйте ещё раз.',
            request_id: response.headers.get('X-Request-ID') ?? undefined,
          },
    )
  }
  if (data === null)
    throw new ApiError(response.status, {
      code: 'INVALID_RESPONSE',
      message: 'Сервис вернул неожиданный ответ.',
    })
  return data as T
}
