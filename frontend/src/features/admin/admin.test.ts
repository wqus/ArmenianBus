import { expect, it } from 'vitest'
import { readRecord } from './resources'
import { operations, operationBody } from './operations'
import { readAdminFilters, adminReturnTo } from './paths'
import { readHealth } from './health'
import { safeReturnTo } from '../auth/types'
import { records, health, id } from './fixtures.testdata'

it('validates admin DTOs and excludes undeclared sensitive fields', () => {
  for (const [kind, value] of Object.entries(records)) {
    expect(
      readRecord(kind, { ...value, password_hash: 'secret', request_payload: 'secret' }),
    ).not.toHaveProperty('password_hash')
    expect(readRecord(kind, value).id).toBe(id)
    expect(() => readRecord(kind, { ...value, id: 'bad' })).toThrow()
  }
  expect(() => readRecord('payments', { ...records.payments, amount: 4500.5 })).toThrow()
  expect(() =>
    readRecord('notifications', { ...records.notifications, retry_generation: -1 }),
  ).toThrow()
  expect(() =>
    readRecord('refund-cases', { ...records['refund-cases'], status: 'REFUND_RECORDED' }),
  ).toThrow()
  expect(() => readRecord('constructor', {})).toThrow()
})
it('validates monitoring rather than treating absent data as healthy', () => {
  expect(readHealth(health).workers[1].state).toBe('DISABLED')
  expect(() =>
    readHealth({ ...health, workers: [health.workers[0], health.workers[0], health.workers[2]] }),
  ).toThrow()
  expect(() => readHealth({ ...health, queues: { ...health.queues, open_refunds: -1 } })).toThrow()
})
it('allows only bounded resource-specific filters and safe return paths', () => {
  const path = `/admin/payments?status=PENDING&review_required=true&booking_id=${id}&offset=20`
  expect(safeReturnTo(path)).toBe(path)
  for (const path of [
    '/admin/users?offset=1',
    '/admin/users?offset=10020',
    '/admin/users?role=ADMIN&role=CARRIER',
    '/admin/users?role=OWNER',
    '/admin/payments?review_required=yes',
    '/admin/routes?carrier_id=bad',
    '/admin/audit?action=' + 'x'.repeat(101),
    '/admin/constructor',
    '/admin/audit/' + id,
    '//evil.example/admin/users',
    '/admin/users/' + id + '?next=bad',
  ])
    expect(adminReturnTo(path)).toBeNull()
  expect(readAdminFilters('users', new URLSearchParams('role=CARRIER&offset=0'))?.toString()).toBe(
    'role=CARRIER',
  )
})
it('protects admin users and terminal records and pins retries to their observed generation', () => {
  expect(operations('users', readRecord('users', { ...records.users, role: 'ADMIN' }))).toEqual([])
  expect(
    operations('routes', readRecord('routes', { ...records.routes, status: 'DEPARTED' })),
  ).toEqual([])
  expect(
    operations(
      'notifications',
      readRecord('notifications', { ...records.notifications, status: 'SENT' }),
    ),
  ).toEqual([])
  const retry = operations('notifications', readRecord('notifications', records.notifications))[0]
  expect(operationBody(retry, ' Fixed SMTP ')).toEqual({
    expected_generation: 2,
    reason: 'Fixed SMTP',
  })
  expect(operationBody(retry, ' '.repeat(10))).toBeNull()
  expect(operationBody(retry, 'x'.repeat(501))).toBeNull()
})
it('requires a provider UUID or valid refund reference and never accepts an arbitrary status', () => {
  const verify = operations('payments', readRecord('payments', records.payments))[0]
  expect(operationBody(verify, 'bad')).toBeNull()
  expect(operationBody(verify, id)).toEqual({ external_id: id })
  const known = operations(
    'payments',
    readRecord('payments', { ...records.payments, external_id: id }),
  )[0]
  expect(operationBody(known, 'ignored')).toEqual({})
  const refund = operations('refund-cases', readRecord('refund-cases', records['refund-cases']))[0]
  expect(operationBody(refund, ' refund:123/AB-1 ')).toEqual({ reference: 'refund:123/AB-1' })
  for (const bad of ['-leading', 'кириллица', 'x'.repeat(101), 'two words', ''])
    expect(operationBody(refund, bad)).toBeNull()
})
