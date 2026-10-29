import { afterEach, expect, it, vi } from 'vitest'
import { confirmationUrl, paymentKey, paymentMessage, readPayment } from './payment'
import type { BookingDetails } from '../bookings/booking'
import { safeReturnTo } from '../auth/types'

const id = '11111111-1111-4111-8111-111111111111'
const p = {
  id,
  booking_id: id,
  status: 'PENDING',
  amount: '4500.50',
  currency: 'RUB',
  confirmation_url: 'https://yoomoney.ru/checkout/test',
  review_reason: null,
  created_at: '2030-01-01T00:00:00Z',
}
afterEach(() => vi.unstubAllGlobals())

it('accepts only HTTPS checkout URLs on the provider host without credentials', () => {
  expect(confirmationUrl(p.confirmation_url)).toBe(p.confirmation_url)
  for (const url of [
    'javascript:alert(1)',
    'http://yoomoney.ru/test',
    '//yoomoney.ru',
    'https://yoomoney.ru.evil.test',
    'https://user:pass@yoomoney.ru',
    'https://yoomoney.ru:444/test',
    'https://evil.test/yoomoney.ru',
    ' https://yoomoney.ru',
  ])
    expect(confirmationUrl(url)).toBeNull()
})

it('rejects mismatched booking, invalid price and unknown payment status', () => {
  expect(readPayment(p, id)).toEqual(p)
  for (const changes of [
    { id: `${id}\n` },
    { amount: '4500.50\n' },
    { booking_id: 'wrong' },
    { amount: 4500.5 },
    { status: 'PAID' },
    { currency: 'USD' },
    { review_reason: false },
    { created_at: 'yesterday' },
  ])
    expect(() => readPayment({ ...p, ...changes }, id)).toThrow()
})

it('keeps payment success separate from booking confirmation and refund completion', () => {
  const booking = { status: 'HELD' } as BookingDetails
  const paid = readPayment({ ...p, status: 'SUCCEEDED' }, id)
  expect(paymentMessage(paid, booking).title).not.toBe('Оплата подтверждена')
  expect(paymentMessage(paid, { ...booking, status: 'PAID' }).title).toBe('Оплата подтверждена')
  expect(
    paymentMessage(paid, {
      ...booking,
      status: 'PAID',
      payment_review_reason: 'PROVIDER_STATE_CONFLICT',
    }).title,
  ).toBe('Платёж требует проверки')
  expect(
    paymentMessage({ ...paid, review_reason: 'REFUND_REQUIRED' }, { ...booking, status: 'EXPIRED' })
      .text,
  ).toContain('Статус возврата уточните')
})

it('persists one key across attempts, isolates users and refuses unsafe recovery', async () => {
  const values = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  })
  vi.stubGlobal('navigator', { locks: { request: (_: string, action: () => unknown) => action() } })
  const key = await paymentKey('user', id, false)
  expect(await paymentKey('user', id, true)).toBe(key)
  expect(await paymentKey('user', id, false)).toBe(key)
  await expect(paymentKey('another-user', id, true)).rejects.toThrow()
  expect(await paymentKey('another-user', id, false)).not.toBe(key)
  vi.stubGlobal('localStorage', {
    getItem: () => null,
    setItem: () => {
      throw new Error('Disabled')
    },
  })
  await expect(paymentKey('user', id, false)).rejects.toThrow()
})

it('preserves only bounded payment login return routes', () => {
  expect(safeReturnTo(`/payment/result?booking=${id}&status=succeeded&next=//evil.test`)).toBe(
    `/payment/result?booking=${id}`,
  )
  for (const path of [`/bookings/${id}/payment`, `/payment/result?booking=${id}`])
    expect(safeReturnTo(path)).toBe(path)
  for (const path of [
    `/payment/result?booking=${id}%0A`,
    `/payment/result?booking=${id}&booking=${id}`,
    '/payment/result?booking=bad',
    `//evil.test/payment/result?booking=${id}`,
    `/bookings/${id}/payment?next=//evil.test`,
  ])
    expect(safeReturnTo(path)).toBe('/account')
})
