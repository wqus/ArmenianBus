import { ApiError, apiRequest } from '../../shared/api/client'
import { isRoute, readSearch, searchUrl } from '../search/search'
import type { SearchRoute } from '../search/search'

export type Seat = { id: string; seat_number: number; status: 'FREE' | 'HELD' | 'PAID' }
export type Trip = { route: SearchRoute & { bus_id: string }; seats: Seat[]; freeSeats: number }
export const isUuid = (value: unknown): value is string =>
  typeof value === 'string' && /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(value)

function invalidResponse(): never {
  throw new ApiError(200, {
    code: 'INVALID_RESPONSE',
    message: 'Не удалось прочитать данные рейса. Обновите страницу рейса.',
  })
}

export function parseTrip(id: string, route: unknown, availability: unknown): Trip {
  if (
    !isRoute(route) ||
    route.id !== id ||
    !('bus_id' in route) ||
    !isUuid(route.bus_id) ||
    !availability ||
    typeof availability !== 'object' ||
    !('route_id' in availability) ||
    availability.route_id !== id ||
    !('bus_id' in availability) ||
    availability.bus_id !== route.bus_id ||
    !('seats' in availability) ||
    !Array.isArray(availability.seats) ||
    availability.seats.length !== route.capacity ||
    !('free_seats' in availability)
  )
    return invalidResponse()
  const seats: Seat[] = []
  const ids = new Set<string>()
  const numbers = new Set<number>()
  for (const seat of availability.seats as unknown[]) {
    if (
      !seat ||
      typeof seat !== 'object' ||
      !('id' in seat) ||
      !isUuid(seat.id) ||
      ids.has(seat.id) ||
      !('seat_number' in seat) ||
      typeof seat.seat_number !== 'number' ||
      !Number.isInteger(seat.seat_number) ||
      seat.seat_number < 1 ||
      seat.seat_number > route.capacity ||
      numbers.has(seat.seat_number) ||
      !('status' in seat) ||
      !['FREE', 'HELD', 'PAID'].includes(String(seat.status))
    )
      return invalidResponse()
    ids.add(seat.id)
    numbers.add(seat.seat_number)
    seats.push({
      id: seat.id,
      seat_number: seat.seat_number,
      status: seat.status as Seat['status'],
    })
  }
  const freeSeats = seats.filter((seat) => seat.status === 'FREE').length
  if (availability.free_seats !== freeSeats) return invalidResponse()
  // These are separate reads: the seat response owns the displayed availability count.
  return {
    route: { ...route, bus_id: route.bus_id },
    seats: seats.sort((a, b) => a.seat_number - b.seat_number),
    freeSeats,
  }
}

export async function getTrip(id: string, signal: AbortSignal): Promise<Trip> {
  if (!isUuid(id)) throw new ApiError(404, { code: 'ROUTE_NOT_FOUND', message: 'Рейс недоступен.' })
  const [route, seats] = await Promise.all([
    apiRequest<unknown>(`/routes/${id}`, { signal }),
    apiRequest<unknown>(`/routes/${id}/seats`, { signal }),
  ])
  return parseTrip(id, route, seats)
}

export function tripUrl(id: string, search?: string): string {
  const parsed = readSearch(new URLSearchParams(search))
  return `/trips/${encodeURIComponent(id)}${parsed ? searchUrl(parsed).replace('/search', '') : ''}`
}

export function backToSearch(params: URLSearchParams): string {
  const search = readSearch(params)
  return search ? searchUrl(search) : '/search'
}

export function tripError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.problem.code === 'INVALID_RESPONSE')
      return 'Данные рейса изменились или получены не полностью. Обновите их.'
    if (error.status === 0) return error.message
    if (error.status === 429)
      return 'Слишком много запросов. Подождите немного и повторите попытку.'
  }
  return 'Не удалось проверить рейс и места. Повторите попытку.'
}
