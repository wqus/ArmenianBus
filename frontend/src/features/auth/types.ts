import { ApiError } from '../../shared/api/client'
import { bookingListUrl, readBookingFilters } from '../bookings/filters'
import { carrierReturnTo } from '../carrier/paths'
import { adminReturnTo } from '../admin/paths'

export type Role = 'PASSENGER' | 'CARRIER' | 'ADMIN'
export type User = {
  id: string
  email: string
  role: Role
  status: 'ACTIVE' | 'BLOCKED'
  created_at: string
  email_verified_at?: string | null
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
    typeof user.created_at !== 'string' ||
    (user.email_verified_at != null &&
      (typeof user.email_verified_at !== 'string' ||
        !/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(user.email_verified_at) ||
        !Number.isFinite(Date.parse(user.email_verified_at))))
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
    BROWSER_UNSUPPORTED:
      'Вход недоступен в этом браузере. Откройте сайт в обновлённом браузере через HTTPS (или localhost). Поиск рейсов доступен без входа.',
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
    ACTION_LINK_INVALID:
      'Ссылка недействительна, уже использована или срок её действия истёк. Запросите новое письмо.',
    ACCOUNT_MAIL_UNAVAILABLE:
      'Отправка писем сейчас недоступна. Попробуйте позже или напишите в поддержку.',
  }
  if (['NETWORK_ERROR', 'REQUEST_TIMEOUT'].includes(error.problem.code)) return error.message
  return messages[error.problem.code] ?? 'Не удалось выполнить действие. Попробуйте ещё раз.'
}

export function safeReturnTo(value: string | null): string {
  if (!value || value !== value.trim()) return '/account'
  if (value && ['/account', '/carrier', '/admin', '/bookings'].includes(value)) return value
  if (value.startsWith('/carrier/')) return carrierReturnTo(value) ?? '/account'
  if (value.startsWith('/admin/')) return adminReturnTo(value) ?? '/account'
  if (value.startsWith('/bookings?')) {
    const filters = readBookingFilters(new URLSearchParams(value.slice('/bookings?'.length)))
    return filters ? bookingListUrl(filters) : '/account'
  }
  const uuid = '[a-fA-F0-9]{8}-(?:[a-fA-F0-9]{4}-){3}[a-fA-F0-9]{12}'
  if (value.startsWith('/payment/result?')) {
    const params = new URLSearchParams(value.slice('/payment/result?'.length))
    const booking = params.get('booking')
    if (
      params.getAll('booking').length === 1 &&
      booking?.length === 36 &&
      new RegExp(`^${uuid}$`).test(booking)
    )
      return `/payment/result?booking=${booking}`
    return '/account'
  }
  if (
    value &&
    (new RegExp(`^/bookings/${uuid}(?:/payment)?$`).test(value) ||
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
