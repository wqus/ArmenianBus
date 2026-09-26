import { describe, expect, it } from 'vitest'
import {
  departureIso,
  exactPrice,
  readBusDetails,
  readOwnRoute,
  readPage,
  utcInput,
} from './contracts'
import { carrierBookingParams, carrierListParams, carrierReturnTo } from './paths'
import { safeReturnTo } from '../auth/types'

const id = '11111111-1111-4111-8111-111111111111'
const second = '22222222-2222-4222-8222-222222222222'
const bus = {
  id,
  carrier_id: id,
  name: 'Автобус',
  capacity: 2,
  created_at: '2030-01-01T00:00:00Z',
  seats: [
    { id, seat_number: 1 },
    { id: second, seat_number: 2 },
  ],
}
const route = {
  id,
  carrier_id: id,
  bus_id: id,
  origin_country: 'RU',
  destination_country: 'AM',
  origin: 'Ростов',
  destination: 'Гюмри',
  departure_at: '2030-02-01T00:30:00+03:00',
  created_at: bus.created_at,
  price: '9999999999.99',
  currency: 'RUB',
  status: 'DRAFT',
}

describe('carrier contracts and write inputs', () => {
  it('keeps decimal prices exact within NUMERIC(12,2)', () => {
    for (const price of ['0.01', '1', '4500.50', '9999999999.99'])
      expect(exactPrice(price)).toBe(true)
    for (const price of ['0', '-1', '1e3', '10000000000', '1.001', '01.20', 'NaN', ' 1', '1,5'])
      expect(exactPrice(price)).toBe(false)
  })
  it('interprets wall time as UTC and rejects impossible dates without browser timezone conversion', () => {
    expect(departureIso('2032-02-29T23:30')).toBe('2032-02-29T23:30:00.000Z')
    expect(utcInput(route.departure_at)).toBe('2030-01-31T21:30')
    for (const input of [
      '2030-02-29T12:00',
      '2030-04-31T12:00',
      '2030-01-01T24:00',
      '2030-01-01T12:00Z',
      'invalid',
    ])
      expect(departureIso(input)).toBeNull()
  })
  it('requires a complete unique numbered seat inventory', () => {
    expect(readBusDetails(bus)).toEqual(bus)
    for (const seats of [
      [],
      [bus.seats[0], bus.seats[0]],
      [{ id, seat_number: 0 }, bus.seats[1]],
      [{ id, seat_number: 2 }, bus.seats[1]],
    ])
      expect(() => readBusDetails({ ...bus, seats })).toThrow()
    expect(() => readBusDetails({ ...bus, capacity: 101 })).toThrow()
  })
  it('rejects malformed private routes and inconsistent pages', () => {
    expect(readOwnRoute(route)).toEqual(route)
    for (const patch of [
      { price: 4500.5 },
      { currency: 'AMD' },
      { destination_country: 'RU' },
      { status: 'ARCHIVED' },
      { departure_at: '2030-01-01T12:00:00' },
    ])
      expect(() => readOwnRoute({ ...route, ...patch })).toThrow()
    expect(readPage({ items: [route], limit: 21, offset: 20 }, 20, readOwnRoute).next).toBe(false)
    for (const page of [
      { items: [route, route], limit: 21, offset: 0 },
      { items: [route], limit: 20, offset: 0 },
      { items: [route], limit: 21, offset: 20 },
    ])
      expect(() => readPage(page, 0, readOwnRoute)).toThrow()
  })
})
describe('carrier URLs', () => {
  it('validates server filters and bounded paging', () => {
    expect(carrierListParams(new URLSearchParams('status=ACTIVE&offset=20'), 'routes')).toEqual({
      status: 'ACTIVE',
      offset: 20,
    })
    for (const q of [
      'status=ACTIVE',
      'offset=-20',
      'offset=1',
      'offset=10020',
      'offset=20&offset=40',
      'unknown=1',
    ])
      expect(carrierListParams(new URLSearchParams(q), 'buses')).toBeNull()
    expect(
      carrierBookingParams(new URLSearchParams(`segment=history&route_id=${id}`))?.routeId,
    ).toBe(id)
    for (const q of [`route_id=${id}&route_id=${id}`, 'route_id=bad', 'status=UNKNOWN'])
      expect(carrierBookingParams(new URLSearchParams(q))).toBeNull()
  })
  it('preserves only valid same-app destinations after login', () => {
    for (const path of [
      '/carrier/buses/new',
      `/carrier/routes/new?bus=${id}`,
      `/carrier/routes/${id}/edit`,
      `/carrier/bookings?status=PAID&route_id=${id}`,
    ])
      expect(safeReturnTo(path)).toBe(path)
    for (const path of [
      `/other/routes/${id}`,
      '//evil.example/carrier/buses',
      '/carrier/routes?next=https://evil.example',
      '/carrier/buses/new#bad',
      `/carrier/routes/new?bus=${id}&bus=${id}`,
      `/carrier/routes/${id}/delete`,
    ]) {
      expect(carrierReturnTo(path)).toBeNull()
      expect(safeReturnTo(path)).toBe('/account')
    }
  })
})
