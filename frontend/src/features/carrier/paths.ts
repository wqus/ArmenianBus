import { isUuid } from '../trips/trip'
import { readBookingFilters, bookingFilterParams } from '../bookings/filters'
export function carrierListParams(params: URLSearchParams, kind: 'buses' | 'routes') {
  if (
    [...params.keys()].some(
      (k) =>
        !(kind === 'routes' ? ['offset', 'status'] : ['offset']).includes(k) ||
        params.getAll(k).length !== 1,
    )
  )
    return null
  const raw = params.get('offset') ?? '0'
  const status = params.get('status') ?? ''
  if (
    raw !== raw.trim() ||
    !/^(?:0|[1-9]\d{0,4})$/.test(raw) ||
    Number(raw) > 10000 ||
    Number(raw) % 20 !== 0 ||
    !['', 'DRAFT', 'ACTIVE', 'DEPARTED', 'COMPLETED', 'CANCELLED'].includes(status)
  )
    return null
  return { offset: Number(raw), status }
}
export function carrierBookingParams(params: URLSearchParams) {
  const route = params.get('route_id')
  if (params.getAll('route_id').length > 1 || (route !== null && !isUuid(route))) return null
  const rest = new URLSearchParams(params)
  rest.delete('route_id')
  const filters = readBookingFilters(rest)
  return filters ? { ...filters, routeId: route ?? '' } : null
}
export function carrierReturnTo(value: string): string | null {
  if (!value.startsWith('/carrier/') || value !== value.trim()) return null
  const [path, query = ''] = value.split('?')
  if (value.split('?').length > 2 || value.includes('#')) return null
  const params = new URLSearchParams(query)
  if (path === '/carrier/bookings') {
    const filters = carrierBookingParams(params)
    if (!filters) return null
    const clean = bookingFilterParams(filters)
    if (filters.routeId) clean.set('route_id', filters.routeId)
    return path + (clean.size ? `?${clean}` : '')
  }
  if (path === '/carrier/buses' || path === '/carrier/routes') {
    const filters = carrierListParams(params, path.endsWith('buses') ? 'buses' : 'routes')
    if (!filters) return null
    const clean = new URLSearchParams()
    if (filters.status) clean.set('status', filters.status)
    if (filters.offset) clean.set('offset', String(filters.offset))
    return path + (clean.size ? `?${clean}` : '')
  }
  if (
    path === '/carrier/routes/new' &&
    params.size === 1 &&
    params.getAll('bus').length === 1 &&
    isUuid(params.get('bus'))
  )
    return `${path}?bus=${params.get('bus')}`
  if (query) return null
  const parts = path.split('/')
  if (['/carrier/buses/new', '/carrier/routes/new'].includes(path)) return path
  if (parts.length === 4 && ['buses', 'routes', 'bookings'].includes(parts[2]) && isUuid(parts[3]))
    return path
  if (parts.length === 5 && parts[2] === 'routes' && isUuid(parts[3]) && parts[4] === 'edit')
    return path
  return null
}
