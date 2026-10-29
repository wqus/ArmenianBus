import { afterEach, expect, it, vi } from 'vitest'
import { loadBooking, readBooking, readDetails, remainingSeconds } from './booking'
import { Session } from '../auth/session'
import { safeReturnTo } from '../auth/types'

const id = '11111111-1111-4111-8111-111111111111'
const b = {
  id,
  route_id: id,
  seat_id: id,
  bus_id: id,
  status: 'HELD',
  amount: '4500.50',
  currency: 'RUB',
  created_at: '2030-06-01T12:00:00Z',
  held_until: '2030-06-01T12:10:00Z',
  server_time: '2030-06-01T12:00:00Z',
  origin: 'Москва',
  destination: 'Ереван',
  departure_at: '2030-06-02T12:00:00Z',
  seat_number: 1,
  company_name: 'Carrier',
  cancellation_allowed: true,
  route_status: 'ACTIVE',
  payment_status: null,
  refund_status: null,
  refund_required: false,
}
afterEach(() => vi.restoreAllMocks())

it('validates private booking data including clock, price, seat and terminal statuses', () => {
  expect(readDetails(b)).toEqual(b)
  for (const status of ['PAID', 'EXPIRED', 'CANCELLED', 'COMPLETED'])
    expect(readDetails({ ...b, status }).status).toBe(status)
  for (const changes of [
    { server_time: 'bad' },
    { amount: 4500.5 },
    { amount: '-1' },
    { status: 'PENDING' },
    { id: '../admin' },
    { seat_number: 0 },
    { cancellation_allowed: 'true' },
    { payment_status: 'PAID' },
    { payment_review_reason: 123 },
    { route_status: 'INVALID' },
    { refund_status: 'REFUNDED' },
    { refund_status: 'OPEN', refund_required: false },
    { passenger_first_name: 123 },
    { passenger_last_name: 'А\u200bБ' },
    { passenger_phone: '89991234567' },
  ])
    expect(() => readDetails({ ...b, ...changes })).toThrow()
  expect(readBooking({ ...b, server_time: undefined })).toHaveProperty('id', id)
})

it('counts down from server time using elapsed monotonic time, regardless of device clock', () => {
  const value = { booking: readDetails(b), receivedAt: 1000, remainingMs: 10_000 }
  vi.spyOn(Date, 'now').mockReturnValue(0)
  expect(remainingSeconds(value, 4500)).toBe(7)
  vi.spyOn(Date, 'now').mockReturnValue(9e12)
  expect(remainingSeconds(value, 4500)).toBe(7)
  expect(remainingSeconds(value, 11_500)).toBe(0)
  expect(remainingSeconds(value, 500)).toBe(10)
})

it('subtracts request latency and rejects a booking for a different identifier', async () => {
  const session = new Session(vi.fn())
  vi.spyOn(session, 'request').mockResolvedValue(b)
  vi.spyOn(performance, 'now').mockReturnValueOnce(1000).mockReturnValueOnce(2500)
  const result = await loadBooking(session, id, new AbortController().signal)
  expect(result.remainingMs).toBe(598_500)
  expect(result.receivedAt).toBe(2500)
  await expect(
    loadBooking(session, '22222222-2222-4222-8222-222222222222', new AbortController().signal),
  ).rejects.toThrow()
})

it('permits only the exact booking/login return paths without foreign targets or extra parameters', () => {
  for (const path of ['/bookings', `/bookings/${id}`, `/trips/${id}/book?seat=${id}`])
    expect(safeReturnTo(path)).toBe(path)
  for (const path of [
    `/bookings/${id}\n`,
    '//example.com',
    '/\\example.com',
    `https://example.com/bookings/${id}`,
    `/trips/${id}/book?seat=${id}&next=//example.com`,
    '/bookings/not-a-uuid',
    '/bookings?next=//example.com',
  ])
    expect(safeReturnTo(path)).toBe('/account')
})
