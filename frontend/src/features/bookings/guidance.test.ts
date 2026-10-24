import { expect, it } from 'vitest'
import { bookingGuidance } from './guidance'

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
