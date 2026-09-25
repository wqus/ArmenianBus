import { ApiError } from '../../shared/api/client'
import { isUuid } from '../trips/trip'
import type { Session } from '../auth/session'

export type Booking = {
  id: string
  route_id: string
  seat_id: string
  bus_id: string
  status: 'HELD' | 'PAID' | 'EXPIRED' | 'CANCELLED' | 'COMPLETED'
  amount: string
  currency: 'RUB'
  held_until: string
  created_at: string
}
export type BookingDetails = Booking & {
  server_time: string
  origin: string
  destination: string
  departure_at: string
  seat_number: number
  company_name: string
  cancellation_allowed: boolean
}
export type TimedBooking = { booking: BookingDetails; receivedAt: number; remainingMs: number }
const timestamp = (value: unknown): value is string =>
  typeof value === 'string' &&
  /T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
  Number.isFinite(Date.parse(value))
const text = (value: unknown) => typeof value === 'string' && value.trim().length > 0
const invalid = () =>
  new ApiError(200, { code: 'INVALID_RESPONSE', message: 'Не удалось прочитать бронирование.' })

export function readBooking(data: unknown): Booking {
  const b = data as Partial<Booking> | null
  if (
    !b ||
    !isUuid(b.id) ||
    !isUuid(b.route_id) ||
    !isUuid(b.seat_id) ||
    !isUuid(b.bus_id) ||
    !['HELD', 'PAID', 'EXPIRED', 'CANCELLED', 'COMPLETED'].includes(b.status ?? '') ||
    typeof b.amount !== 'string' ||
    !/^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/.test(b.amount) ||
    !/[1-9]/.test(b.amount) ||
    b.currency !== 'RUB' ||
    !timestamp(b.held_until) ||
    !timestamp(b.created_at)
  )
    throw invalid()
  return b as Booking
}
export function readDetails(data: unknown): BookingDetails {
  readBooking(data)
  const b = data as Partial<BookingDetails>
  if (
    !timestamp(b.server_time) ||
    !timestamp(b.departure_at) ||
    !text(b.origin) ||
    !text(b.destination) ||
    !text(b.company_name) ||
    !Number.isInteger(b.seat_number) ||
    b.seat_number! < 1 ||
    b.seat_number! > 100 ||
    typeof b.cancellation_allowed !== 'boolean'
  )
    throw invalid()
  return b as BookingDetails
}
export async function loadBooking(
  session: Session,
  id: string,
  signal: AbortSignal,
): Promise<TimedBooking> {
  const start = performance.now()
  const booking = readDetails(await session.request(`/cabinet/bookings/${id}`, { signal }))
  if (booking.id !== id) throw invalid()
  const receivedAt = performance.now()
  // Subtract the full round trip conservatively; use monotonic time, not the device clock.
  return {
    booking,
    receivedAt,
    remainingMs: Math.max(
      0,
      Date.parse(booking.held_until) - Date.parse(booking.server_time) - (receivedAt - start),
    ),
  }
}
export function remainingSeconds(value: TimedBooking, now: number): number {
  return Math.max(0, Math.ceil((value.remainingMs - Math.max(0, now - value.receivedAt)) / 1000))
}
export const statusLabels = {
  HELD: 'Место удерживается',
  PAID: 'Оплачено',
  EXPIRED: 'Срок удержания истёк',
  CANCELLED: 'Бронь отменена',
  COMPLETED: 'Поездка завершена',
}

export function bookingError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 404) return 'Бронь не найдена или недоступна этому аккаунту.'
    if (error.status === 401)
      return 'Сессия обновилась или завершилась. Проверьте вход и повторите действие.'
    if (error.status === 403) return 'Бронирование доступно только активному аккаунту пассажира.'
    if (error.status === 0) return error.message
    if (error.problem.code === 'BOOKING_NOT_HELD')
      return 'Статус брони изменился. Отмена удержания не выполнена.'
  }
  return 'Не удалось подтвердить результат. Обновите данные брони.'
}
