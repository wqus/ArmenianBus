import { expect, it } from 'vitest'
import { bookingGuidance, hasPaidConfirmation } from './guidance'

it('offers a confirmation only for verified, active paid bookings without any refund', () => {
  const paid = {
    status: 'PAID',
    route_status: 'ACTIVE',
    refund_status: null,
    payment_status: 'SUCCEEDED',
  } as const
  expect(hasPaidConfirmation(paid)).toBe(true)
  expect(hasPaidConfirmation({ ...paid, route_status: 'DEPARTED' })).toBe(true)
  for (const status of ['HELD', 'EXPIRED', 'CANCELLED', 'COMPLETED'] as const)
    expect(hasPaidConfirmation({ ...paid, status })).toBe(false)
  for (const payment_status of [null, 'PENDING', 'FAILED', 'CANCELED'] as const)
    expect(hasPaidConfirmation({ ...paid, payment_status })).toBe(false)
  for (const refund_status of ['OPEN', 'REFUND_RECORDED'] as const)
    expect(hasPaidConfirmation({ ...paid, refund_status })).toBe(false)
  for (const route_status of ['DRAFT', 'CANCELLED', 'COMPLETED'] as const)
    expect(hasPaidConfirmation({ ...paid, route_status })).toBe(false)
})

it('never asks for another payment when receipt is known but the booking is not confirmed', () => {
  for (const status of ['HELD', 'EXPIRED', 'CANCELLED'] as const) {
    const message = bookingGuidance({
      status,
      route_status: 'ACTIVE',
      refund_status: null,
      payment_status: 'SUCCEEDED',
    })
    expect(message).not.toMatch(/Завершите оплату|чтобы подтвердить поездку/)
    expect(message).toContain('Не оплачивайте повторно')
  }
})

it('does not ask to continue a payment attempt that has already failed or been canceled', () => {
  for (const payment_status of ['FAILED', 'CANCELED'] as const) {
    expect(
      bookingGuidance({
        status: 'HELD',
        route_status: 'ACTIVE',
        refund_status: null,
        payment_status,
      }),
    ).not.toContain('Завершите оплату')
  }
})
