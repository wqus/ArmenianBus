import { expect, it } from 'vitest'
import { bookingListUrl, readBookingFilters } from './filters'
import { safeReturnTo } from '../auth/types'
import { refundSummary } from './refund'
import type { BookingDetails } from './booking'
import { paymentMessage } from '../payments/payment'

it('round trips filters with bounded pagination and a canonical login return', () => {
  const filters = { segment: 'history', status: 'CANCELLED', offset: 20 } as const
  const url = bookingListUrl(filters)
  expect(readBookingFilters(new URLSearchParams(url.split('?')[1]))).toEqual(filters)
  expect(safeReturnTo(url)).toBe(url)
  expect(readBookingFilters(new URLSearchParams())).toEqual({
    segment: 'all',
    status: '',
    offset: 0,
  })
})

it('rejects invalid, duplicate and unbounded parameters instead of silently querying another list', () => {
  for (const query of [
    'status=PAID&status=HELD',
    'segment=future',
    'offset=-20',
    'offset=1',
    'offset=10020',
    'offset=2e1',
    'offset=20%0A',
    'next=//evil.test',
    'segment=history&x=1',
  ]) {
    expect(readBookingFilters(new URLSearchParams(query))).toBeNull()
    expect(safeReturnTo(`/bookings?${query}`)).toBe('/account')
  }
})

it('distinguishes an open refund from an operator record on both booking and payment screens', () => {
  const open = { refund_status: 'OPEN' } as BookingDetails
  const recorded = { refund_status: 'REFUND_RECORDED' } as BookingDetails
  expect(refundSummary(open)?.title).toBe('Заявка на возврат открыта')
  expect(refundSummary(recorded)?.title).toBe('Возврат отмечен оператором')
  expect(paymentMessage(null, recorded)).toEqual(refundSummary(recorded))
  expect(refundSummary({ refund_status: null } as BookingDetails)).toBeNull()
})
