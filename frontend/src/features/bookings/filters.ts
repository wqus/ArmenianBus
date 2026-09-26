import type { Booking } from './booking'

export type BookingFilters = {
  segment: 'all' | 'upcoming' | 'history'
  status: Booking['status'] | ''
  offset: number
}
export const defaultBookingFilters: BookingFilters = { segment: 'all', status: '', offset: 0 }

export function readBookingFilters(params: URLSearchParams): BookingFilters | null {
  if (
    [...params.keys()].some(
      (key) => !['segment', 'status', 'offset'].includes(key) || params.getAll(key).length !== 1,
    )
  )
    return null
  const segment = params.get('segment') ?? 'all'
  const status = params.get('status') ?? ''
  const offset = params.get('offset') ?? '0'
  if (
    !['all', 'upcoming', 'history'].includes(segment) ||
    !['', 'HELD', 'PAID', 'EXPIRED', 'CANCELLED', 'COMPLETED'].includes(status) ||
    offset !== offset.trim() ||
    !/^(?:0|[1-9]\d{0,4})$/.test(offset) ||
    Number(offset) > 10000 ||
    Number(offset) % 20 !== 0
  )
    return null
  return {
    segment: segment as BookingFilters['segment'],
    status: status as BookingFilters['status'],
    offset: Number(offset),
  }
}

export function bookingFilterParams(filters: BookingFilters): URLSearchParams {
  const params = new URLSearchParams()
  if (filters.segment !== 'all') params.set('segment', filters.segment)
  if (filters.status) params.set('status', filters.status)
  if (filters.offset) params.set('offset', String(filters.offset))
  return params
}

export function bookingListUrl(filters: BookingFilters): string {
  const query = bookingFilterParams(filters).toString()
  return `/bookings${query ? `?${query}` : ''}`
}
