import { ApiError } from '../../shared/api/client'
import { isUuid } from '../trips/trip'

export const routeLabels = {
  DRAFT: 'Черновик',
  ACTIVE: 'Опубликован',
  DEPARTED: 'В пути',
  COMPLETED: 'Завершён',
  CANCELLED: 'Отменён',
}
export type RouteStatus = keyof typeof routeLabels
export type Bus = {
  id: string
  carrier_id: string
  name: string
  capacity: number
  created_at: string
}
export type BusDetails = Bus & { seats: { id: string; seat_number: number }[] }
export type OwnRoute = {
  id: string
  carrier_id: string
  bus_id: string
  origin_country: 'RU' | 'AM'
  destination_country: 'RU' | 'AM'
  origin: string
  destination: string
  departure_at: string
  price: string
  currency: 'RUB'
  status: RouteStatus
  created_at: string
}
export type CarrierProfile = {
  company_name: string
  phone: string
  status: 'PENDING' | 'ACTIVE' | 'BLOCKED'
}
const timestamp = (v: unknown) =>
  typeof v === 'string' && /T.*(?:Z|[+-]\d{2}:\d{2})$/.test(v) && Number.isFinite(Date.parse(v))
const text = (v: unknown) => typeof v === 'string' && v.trim().length > 0
const invalid = () => new Error('Invalid carrier response')
export function readCarrier(v: unknown): CarrierProfile {
  const p = v as Partial<CarrierProfile> | null
  if (
    !p ||
    !text(p.company_name) ||
    !text(p.phone) ||
    !['PENDING', 'ACTIVE', 'BLOCKED'].includes(p.status ?? '')
  )
    throw invalid()
  return p as CarrierProfile
}
export function readBus(v: unknown): Bus {
  const b = v as Partial<Bus> | null
  if (
    !b ||
    !isUuid(b.id) ||
    !isUuid(b.carrier_id) ||
    !text(b.name) ||
    !Number.isInteger(b.capacity) ||
    b.capacity! < 1 ||
    b.capacity! > 100 ||
    !timestamp(b.created_at)
  )
    throw invalid()
  return b as Bus
}
export function readBusDetails(v: unknown): BusDetails {
  const b = readBus(v) as BusDetails
  if (
    !Array.isArray(b.seats) ||
    b.seats.length !== b.capacity ||
    b.seats.some(
      (s) =>
        !s ||
        !isUuid(s.id) ||
        !Number.isInteger(s.seat_number) ||
        s.seat_number < 1 ||
        s.seat_number > b.capacity,
    ) ||
    new Set(b.seats.map((s) => s.id)).size !== b.capacity ||
    new Set(b.seats.map((s) => s.seat_number)).size !== b.capacity
  )
    throw invalid()
  return b
}
export function exactPrice(v: string): boolean {
  return v === v.trim() && /^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/.test(v) && /[1-9]/.test(v)
}
export function readOwnRoute(v: unknown): OwnRoute {
  const r = v as Partial<OwnRoute> | null
  if (
    !r ||
    !isUuid(r.id) ||
    !isUuid(r.carrier_id) ||
    !isUuid(r.bus_id) ||
    !text(r.origin) ||
    !text(r.destination) ||
    !['RU', 'AM'].includes(r.origin_country ?? '') ||
    !['RU', 'AM'].includes(r.destination_country ?? '') ||
    r.origin_country === r.destination_country ||
    !timestamp(r.departure_at) ||
    !timestamp(r.created_at) ||
    typeof r.price !== 'string' ||
    !exactPrice(r.price) ||
    r.currency !== 'RUB' ||
    !Object.hasOwn(routeLabels, r.status ?? '')
  )
    throw invalid()
  return r as OwnRoute
}
export function readPage<T extends { id: string }>(
  v: unknown,
  offset: number,
  read: (item: unknown) => T,
) {
  const page = v as { items?: unknown[]; limit?: number; offset?: number } | null
  if (
    !page ||
    !Array.isArray(page.items) ||
    page.items.length > 21 ||
    page.limit !== 21 ||
    page.offset !== offset
  )
    throw invalid()
  const items = page.items.map(read)
  if (new Set(items.map((i) => i.id)).size !== items.length) throw invalid()
  return { items: items.slice(0, 20), next: items.length > 20 }
}
export function utcInput(iso: string): string {
  return new Date(iso).toISOString().slice(0, 16)
}
export function departureIso(input: string): string | null {
  if (!/^[1-9]\d{3}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(input)) return null
  const date = new Date(`${input}:00Z`)
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 16) === input
    ? date.toISOString()
    : null
}
export function carrierError(error: unknown, writing = false): string {
  if (error instanceof ApiError) {
    const messages: Record<string, string> = {
      BUS_HAS_ROUTES:
        'Автобус используется в незавершённых рейсах. Сначала завершите или отмените эти рейсы.',
      ROUTE_HAS_BOOKINGS:
        'У рейса уже были бронирования. Автобус, направление, дату и цену менять нельзя.',
      INVALID_ROUTE_TRANSITION:
        'Этот переход сейчас недоступен. Обновите рейс и проверьте его состояние.',
      ROUTE_HAS_PAID_BOOKINGS:
        'Для отмены требуется проверка оплаты бронирований. Обратитесь к администратору.',
    }
    if (messages[error.problem.code]) return messages[error.problem.code]
    if (error.status === 403) return 'Операции недоступны. Проверьте активацию профиля перевозчика.'
    if (error.status === 404)
      return 'Запись не найдена, архивирована или недоступна вашему аккаунту.'
    if (error.status === 422)
      return 'Проверьте поля и время отправления: оно должно быть в будущем для создания и редактирования.'
    if (error.status === 409)
      return 'Состояние записи изменилось или операция сейчас запрещена. Обновите данные.'
    if (error.status === 429) return 'Слишком много запросов. Подождите и повторите действие.'
    if (error.status === 401) return 'Проверьте вход и повторите действие.'
  }
  return writing
    ? 'Не удалось подтвердить результат. Изменение могло сохраниться. Проверьте список или обновите запись перед следующей попыткой.'
    : 'Не удалось загрузить актуальные данные. Обновите страницу или повторите запрос.'
}
