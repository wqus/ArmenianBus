import { expect, it } from 'vitest'
import { actionLinkToken } from './action-link'
import { readUser } from './types'

const token = '1'.repeat(32) + '.' + 'a'.repeat(64)
it('accepts only one correctly shaped capability in the fragment', () => {
  expect(actionLinkToken(`#token=${token}`)).toBe(token)
  for (const hash of [
    '',
    '#token=secret',
    `#token=${token}&token=${token}`,
    `#token=${token}&next=//evil.test`,
    `#token=${token}%0a`,
    `#other=${token}`,
  ])
    expect(actionLinkToken(hash)).toBeNull()
})

it('keeps old user responses readable but refuses forged verification values', () => {
  const user = {
    id: 'id',
    email: 'example@example.com',
    role: 'PASSENGER',
    status: 'ACTIVE',
    created_at: '2030-01-01T00:00:00Z',
  }
  expect(readUser(user)).toEqual(user)
  expect(readUser({ ...user, email_verified_at: null }).email_verified_at).toBeNull()
  expect(
    readUser({ ...user, email_verified_at: '2030-01-01T00:00:00Z' }).email_verified_at,
  ).toBeTruthy()
  for (const value of [true, 'yes', '2030-01-01', 'not a date'])
    expect(() => readUser({ ...user, email_verified_at: value })).toThrow()
})
