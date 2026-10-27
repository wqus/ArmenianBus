import { ApiError, apiRequest } from '../../shared/api/client'
import { validTravelDetails, type TravelDetails } from '../trips/departure'

export const PAGE_SIZE = 20
export const MAX_OFFSET = 10_000
export type SearchInput = { origin: string; destination: string; date: string; offset: number }
export type SearchRoute = TravelDetails & {
  id: string
  origin: string
  destination: string
  origin_country: 'RU' | 'AM'
  destination_country: 'RU' | 'AM'
  departure_at: string
  price: string
  currency: 'RUB'
  company_name: string
  bus_name: string
  capacity: number
  free_seats: number
}

export function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value < '0001-01-01' || value > '9999-12-30')
    return false
  const date = new Date(`${value}T00:00:00Z`)
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
}

export function readSearch(params: URLSearchParams): SearchInput | null {
  if (['origin', 'destination', 'date', 'offset'].some((key) => params.getAll(key).length > 1))
    return null
  const origin = params.get('origin')?.trim() ?? ''
  const destination = params.get('destination')?.trim() ?? ''
  const date = params.get('date') ?? ''
  const rawOffset = params.get('offset') ?? '0'
  const offset = Number(rawOffset)
  if (
    !origin ||
    origin.length > 200 ||
    !destination ||
    destination.length > 200 ||
    !validDate(date) ||
    !/^\d+$/.test(rawOffset) ||
    !Number.isSafeInteger(offset) ||
    offset > MAX_OFFSET ||
    offset % PAGE_SIZE !== 0
  )
    return null
  return { origin, destination, date, offset }
}

export function searchUrl(input: SearchInput): string {
  const params = new URLSearchParams({
    origin: input.origin,
    destination: input.destination,
    date: input.date,
  })
  if (input.offset) params.set('offset', String(input.offset))
  return `/search?${params}`
}

const text = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0
const country = (value: unknown) => value === 'RU' || value === 'AM'
export function isRoute(value: unknown): value is SearchRoute {
  if (!value || typeof value !== 'object') return false
  const route = value as Record<string, unknown>
  return (
    text(route.id) &&
    text(route.origin) &&
    text(route.destination) &&
    country(route.origin_country) &&
    country(route.destination_country) &&
    route.origin_country !== route.destination_country &&
    route.status === 'ACTIVE' &&
    text(route.departure_at) &&
    /T.*(?:Z|[+-]\d{2}:\d{2})$/.test(route.departure_at) &&
    Number.isFinite(Date.parse(route.departure_at)) &&
    typeof route.price === 'string' &&
    /^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/.test(route.price) &&
    /[1-9]/.test(route.price) &&
    route.currency === 'RUB' &&
    text(route.company_name) &&
    text(route.bus_name) &&
    typeof route.capacity === 'number' &&
    Number.isInteger(route.capacity) &&
    route.capacity >= 1 &&
    route.capacity <= 100 &&
    typeof route.free_seats === 'number' &&
    Number.isInteger(route.free_seats) &&
    route.free_seats >= 0 &&
    route.free_seats <= route.capacity &&
    validTravelDetails(route as TravelDetails)
  )
}

export async function searchRoutes(input: SearchInput, signal?: AbortSignal) {
  // One extra item determines whether a next page exists; it belongs to that next page.
  const params = new URLSearchParams({
    ...input,
    offset: String(input.offset),
    limit: String(PAGE_SIZE + 1),
    date_basis: 'local',
  })
  const data = await apiRequest<unknown>(`/routes/search?${params}`, { signal })
  if (
    !data ||
    typeof data !== 'object' ||
    !('items' in data) ||
    !Array.isArray(data.items) ||
    !('limit' in data) ||
    data.limit !== PAGE_SIZE + 1 ||
    !('offset' in data) ||
    data.offset !== input.offset ||
    data.items.length > PAGE_SIZE + 1 ||
    !data.items.every(isRoute)
  ) {
    throw new ApiError(200, {
      code: 'INVALID_RESPONSE',
      message: 'Сервис вернул неожиданный ответ.',
    })
  }
  return {
    items: data.items.slice(0, PAGE_SIZE) as SearchRoute[],
    hasNext: data.items.length > PAGE_SIZE,
  }
}

// Decimal stays a string: no floating-point arithmetic or rounding of ticket prices.
export function formatPrice(price: string): string {
  const [whole, fraction = ''] = price.split('.')
  return `${BigInt(whole).toLocaleString('ru-RU')},${fraction.padEnd(2, '0')} ₽`
}

export const departureDate = new Intl.DateTimeFormat('ru-RU', {
  dateStyle: 'long',
  timeZone: 'UTC',
})
export const departureTime = new Intl.DateTimeFormat('ru-RU', {
  timeStyle: 'short',
  timeZone: 'UTC',
})

export function searchError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 422) return 'Проверьте названия городов и дату отправления.'
    if (error.status === 429) return 'Слишком много запросов. Подождите немного и повторите поиск.'
    if (error.problem.code === 'INVALID_RESPONSE')
      return 'Не удалось прочитать данные рейсов. Попробуйте ещё раз.'
    if (error.status === 0) return error.message
  }
  return 'Поиск временно недоступен. Попробуйте ещё раз.'
}
