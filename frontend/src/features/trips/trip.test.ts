import { afterEach, expect, it, vi } from 'vitest'
import { backToSearch, getTrip, parseTrip, tripUrl } from './trip'

const id = '11111111-1111-4111-8111-111111111111'
const bus = '22222222-2222-4222-8222-222222222222'
const first = '33333333-3333-4333-8333-333333333333'
const second = '44444444-4444-4444-8444-444444444444'
const route = {
  id,
  bus_id: bus,
  origin: 'Москва',
  destination: 'Ереван',
  origin_country: 'RU',
  destination_country: 'AM',
  departure_at: '2030-06-01T10:00:00Z',
  price: '4500.50',
  currency: 'RUB',
  status: 'ACTIVE',
  company_name: 'Carrier',
  bus_name: 'Bus',
  capacity: 2,
  free_seats: 2,
}
const availability = {
  route_id: id,
  bus_id: bus,
  free_seats: 1,
  seats: [
    { id: second, seat_number: 2, status: 'HELD' },
    { id: first, seat_number: 1, status: 'FREE' },
  ],
}
afterEach(() => vi.unstubAllGlobals())

it('uses the seat response count when availability changed between the two reads', () => {
  const trip = parseTrip(id, route, availability)
  expect(trip.freeSeats).toBe(1)
  expect(trip.seats.map((seat) => seat.seat_number)).toEqual([1, 2])
  expect(availability.seats[0].seat_number).toBe(2)
})

it('rejects mismatched route, bus and capacity instead of showing seats from another bus', () => {
  for (const changes of [{ route_id: bus }, { bus_id: id }, { seats: [] }, { free_seats: 2 }]) {
    expect(() => parseTrip(id, route, { ...availability, ...changes })).toThrow()
  }
  expect(() => parseTrip(bus, route, availability)).toThrow()
})

it('rejects duplicated or malformed seat identities, numbers and statuses', () => {
  for (const changes of [
    { id: second },
    { id: 'not-a-uuid' },
    { seat_number: 2 },
    { seat_number: 0 },
    { seat_number: 3 },
    { seat_number: 1.5 },
    { status: 'UNKNOWN' },
  ]) {
    expect(() =>
      parseTrip(id, route, {
        ...availability,
        seats: [availability.seats[0], { ...availability.seats[1], ...changes }],
      }),
    ).toThrow()
  }
})

it('never invents a layout for legacy buses or accepts a layout with wrong capacity', () => {
  expect(parseTrip(id, route, availability).layoutId).toBeNull()
  for (const layout_id of ['unknown', 'van-8-v1', 8]) {
    expect(() => parseTrip(id, route, { ...availability, layout_id })).toThrow()
  }
  const seats = Array.from({ length: 8 }, (_, n) => ({
    id: `${String(n + 1).padStart(8, '0')}-3333-4333-8333-333333333333`,
    seat_number: n + 1,
    status: 'FREE',
  }))
  expect(
    parseTrip(
      id,
      { ...route, capacity: 8 },
      { ...availability, layout_id: 'van-8-v1', seats, free_seats: 8 },
    ).layoutId,
  ).toBe('van-8-v1')
})

it('keeps a validated search context and ignores arbitrary return targets', () => {
  const params = new URLSearchParams({
    origin: 'Москва',
    destination: 'Գյումրի',
    date: '2030-06-01',
    offset: '20',
    next: 'https://example.com',
  })
  expect(tripUrl(id, params.toString())).not.toContain('example.com')
  expect(backToSearch(params)).toContain('offset=20')
  expect(backToSearch(new URLSearchParams('next=//example.com'))).toBe('/search')
})

it('loads both public endpoints with cancellation and without credentials', async () => {
  const fetch = vi
    .fn()
    .mockImplementation(
      async (url: string) =>
        new Response(JSON.stringify(url.endsWith('/seats') ? availability : route)),
    )
  vi.stubGlobal('fetch', fetch)
  const controller = new AbortController()
  await expect(getTrip(id, controller.signal)).resolves.toHaveProperty('freeSeats', 1)
  expect(fetch).toHaveBeenCalledTimes(2)
  for (const [, options] of fetch.mock.calls) {
    expect(options.credentials).toBe('omit')
    expect(options.headers.has('Authorization')).toBe(false)
    controller.abort()
    expect(options.signal.aborted).toBe(true)
  }
})

it('rejects invalid identifiers before issuing a request', async () => {
  const fetch = vi.fn()
  vi.stubGlobal('fetch', fetch)
  await expect(getTrip('../my', new AbortController().signal)).rejects.toMatchObject({
    status: 404,
  })
  expect(fetch).not.toHaveBeenCalled()
})
