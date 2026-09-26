import { ApiError } from '../../shared/api/client'
import type { Session } from '../auth/session'
import { loadBooking } from '../bookings/booking'
import type { BookingDetails } from '../bookings/booking'
import { refundSummary } from '../bookings/refund'
import { isUuid } from '../trips/trip'

export type Payment = {
  id: string
  booking_id: string
  status: 'PENDING' | 'SUCCEEDED' | 'CANCELED' | 'FAILED'
  amount: string
  currency: 'RUB'
  confirmation_url: string | null
  review_reason: string | null
  created_at: string
}

export function confirmationUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value !== value.trim()) return null
  try {
    const url = new URL(value)
    // Redirect checkout is hosted by YooMoney. Never accept credentials, custom ports or lookalikes.
    return url.protocol === 'https:' &&
      url.hostname === 'yoomoney.ru' &&
      !url.username &&
      !url.password &&
      !url.port
      ? url.href
      : null
  } catch {
    return null
  }
}

export function readPayment(data: unknown, id: string): Payment {
  const p = data as Partial<Payment> | null
  if (
    !p ||
    !isUuid(p.id) ||
    p.booking_id !== id ||
    !['PENDING', 'SUCCEEDED', 'CANCELED', 'FAILED'].includes(p.status ?? '') ||
    typeof p.amount !== 'string' ||
    p.amount !== p.amount.trim() ||
    !/^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/.test(p.amount) ||
    !/[1-9]/.test(p.amount) ||
    p.currency !== 'RUB' ||
    !(p.confirmation_url === null || typeof p.confirmation_url === 'string') ||
    !(p.review_reason === null || typeof p.review_reason === 'string') ||
    typeof p.created_at !== 'string' ||
    !/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(p.created_at) ||
    !Number.isFinite(Date.parse(p.created_at))
  )
    throw new Error('Invalid payment response')
  return p as Payment
}

export async function loadPayment(session: Session, id: string, signal?: AbortSignal) {
  try {
    return readPayment(await session.request(`/bookings/${id}/payment`, { signal }), id)
  } catch (error) {
    if (
      error instanceof ApiError &&
      error.status === 404 &&
      error.problem.code === 'PAYMENT_NOT_FOUND'
    )
      return null
    throw error
  }
}

export async function loadCheckout(session: Session, id: string, signal: AbortSignal) {
  const payment = await loadPayment(session, id, signal)
  const value = await loadBooking(session, id, signal)
  if (
    payment &&
    (payment.amount !== value.booking.amount || payment.currency !== value.booking.currency)
  )
    throw new Error('Payment does not match booking')
  return { ...value, payment }
}

const storageKey = (user: string, booking: string) => `armeniabus:payment:${user}:${booking}`
export function savedPaymentKey(user: string, booking: string): string | null {
  const key = localStorage.getItem(storageKey(user, booking))
  if (key !== null && !isUuid(key)) throw new Error('Invalid stored payment key')
  return key
}
export async function paymentKey(
  user: string,
  booking: string,
  existing: boolean,
): Promise<string> {
  if (!navigator.locks) throw new Error('Payment requires Web Locks')
  return navigator.locks.request(storageKey(user, booking), () => {
    const saved = savedPaymentKey(user, booking)
    if (saved) return saved
    // Another device may own a pending attempt. Never replace its key.
    if (existing) throw new Error('Original key unavailable')
    const key = crypto.randomUUID()
    localStorage.setItem(storageKey(user, booking), key)
    if (savedPaymentKey(user, booking) !== key) throw new Error('Payment key was not saved')
    return key
  })
}

export function paymentMessage(payment: Payment | null, booking: BookingDetails) {
  const refund = refundSummary(booking)
  if (refund) return refund
  if (payment?.review_reason)
    return {
      title: 'Платёж требует проверки',
      text:
        payment.review_reason === 'REFUND_REQUIRED'
          ? 'Оплата поступила, но бронь не подтверждена. Создана заявка на возврат. Статус возврата уточните в поддержке по номеру брони.'
          : 'Результат проверяет сервис. Не оплачивайте повторно. Сохраните номер брони для обращения в поддержку.',
    }
  if (payment?.status === 'SUCCEEDED')
    return ['PAID', 'COMPLETED'].includes(booking.status)
      ? { title: 'Оплата подтверждена', text: 'Сервис подтвердил оплату и вашу бронь.' }
      : {
          title: 'Оплата получена, проверяем бронь',
          text: 'Не оплачивайте повторно. Проверьте статус позже или обратитесь в поддержку с номером брони.',
        }
  if (payment?.status === 'CANCELED' || payment?.status === 'FAILED')
    return {
      title: 'Платёж не завершён',
      text:
        booking.status === 'HELD'
          ? 'Этот платёж завершён без подтверждённой оплаты. Для новой попытки откройте бронь, отмените удержание и выберите место заново.'
          : 'Этот платёж завершён без подтверждённой оплаты. Проверьте состояние брони перед выбором новой поездки.',
    }
  if (booking.status !== 'HELD')
    return {
      title: 'Оплата этой брони недоступна',
      text: payment
        ? 'Бронь больше не ожидает оплату. Если вы уже платили, дождитесь результата проверки. Повторно оплачивать не нужно.'
        : 'Проверьте состояние брони перед выбором новой поездки.',
    }
  return payment
    ? {
        title: 'Ожидаем результат оплаты',
        text: 'Возврат на сайт ещё не подтверждает оплату. Статус обновляется по данным сервиса.',
      }
    : {
        title: 'Оплата бронирования',
        text: 'Оплата проходит на защищённой странице ЮKassa. Данные карты вводятся там.',
      }
}

export function paymentError(error: unknown): string {
  if (error instanceof ApiError) {
    const messages: Record<string, string> = {
      PAYMENTS_DISABLED: 'Оплата пока недоступна. Деньги по этому запросу не списывались.',
      HOLD_EXPIRED: 'Срок удержания истёк. Оплата больше недоступна.',
      PAYMENT_NOT_AVAILABLE: 'Состояние брони изменилось. Проверьте результат.',
      IDEMPOTENCY_CONFLICT:
        'Для этой брони уже есть другая попытка оплаты. Проверьте её результат; новый платёж не создаётся.',
      RATE_LIMITED: 'Слишком много запросов. Подождите минуту и обновите статус.',
    }
    if (messages[error.problem.code]) return messages[error.problem.code]
  }
  return 'Ответ не получен или не удалось его проверить. Платёж мог сохраниться. Обновите статус; повтор использует ту же попытку оплаты.'
}
