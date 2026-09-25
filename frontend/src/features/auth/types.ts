import { ApiError } from '../../shared/api/client'

export type Role = 'PASSENGER' | 'CARRIER' | 'ADMIN'
export type User = {
  id: string
  email: string
  role: Role
  status: 'ACTIVE' | 'BLOCKED'
  created_at: string
}
export type Access = { access_token: string; expires_in: number; token_type: 'Bearer' }
export type SessionState = {
  status: 'loading' | 'authenticated' | 'anonymous' | 'unavailable'
  user: User | null
  message?: string
}

export function readUser(value: unknown): User {
  const user = value as Partial<User> | null
  if (
    !user ||
    typeof user.id !== 'string' ||
    typeof user.email !== 'string' ||
    !['PASSENGER', 'CARRIER', 'ADMIN'].includes(user.role ?? '') ||
    !['ACTIVE', 'BLOCKED'].includes(user.status ?? '') ||
    typeof user.created_at !== 'string'
  ) {
    throw new Error('Invalid user response')
  }
  return user as User
}

export function readAccess(value: unknown): Access {
  const access = value as Partial<Access> | null
  if (
    !access ||
    typeof access.access_token !== 'string' ||
    !access.access_token ||
    access.token_type !== 'Bearer' ||
    typeof access.expires_in !== 'number' ||
    !Number.isFinite(access.expires_in) ||
    access.expires_in <= 0
  )
    throw new Error('Invalid access response')
  return access as Access
}

export function authMessage(error: unknown): string {
  if (!(error instanceof ApiError)) return 'Не удалось выполнить действие. Попробуйте ещё раз.'
  const messages: Record<string, string> = {
    INVALID_CREDENTIALS: 'Неверная почта или пароль.',
    EMAIL_EXISTS: 'Эта почта уже зарегистрирована. Войдите в аккаунт.',
    USER_BLOCKED: 'Аккаунт заблокирован. Обратитесь к администратору сервиса.',
    RATE_LIMITED: 'Слишком много попыток. Подождите минуту и попробуйте снова.',
    DEPENDENCY_UNAVAILABLE: 'Сервис временно недоступен. Попробуйте позже.',
    CSRF_REJECTED: 'Не удалось проверить запрос. Обновите страницу и попробуйте снова.',
    VALIDATION_ERROR: 'Проверьте заполнение полей.',
    FORBIDDEN: 'У вас нет доступа к этому разделу.',
    UNAUTHORIZED: 'Войдите, чтобы продолжить.',
    INVALID_REFRESH_TOKEN: 'Сессия завершилась. Войдите снова.',
    INVALID_ACCESS_TOKEN: 'Сессия завершилась. Войдите снова.',
  }
  if (['NETWORK_ERROR', 'REQUEST_TIMEOUT'].includes(error.problem.code)) return error.message
  return messages[error.problem.code] ?? 'Не удалось выполнить действие. Попробуйте ещё раз.'
}

export function safeReturnTo(value: string | null): string {
  if (!value || value !== value.trim()) return '/account'
  if (value && ['/account', '/carrier', '/admin', '/bookings'].includes(value)) return value
  const uuid = '[a-fA-F0-9]{8}-(?:[a-fA-F0-9]{4}-){3}[a-fA-F0-9]{12}'
  if (
    value &&
    (new RegExp(`^/bookings/${uuid}$`).test(value) ||
      new RegExp(`^/trips/${uuid}/book\\?seat=${uuid}$`).test(value))
  )
    return value
  return '/account'
}

export const roleLabels: Record<Role, string> = {
  PASSENGER: 'Пассажир',
  CARRIER: 'Перевозчик',
  ADMIN: 'Администратор',
}
