import { expect, it } from 'vitest'
import { emptyPassenger, normalizePassenger, passengerErrors } from './passenger'

const passenger = {
  passenger_first_name: ' Արամ ',
  passenger_last_name: 'Петросян',
  passenger_phone: '+374 (99) 123-456',
}

it('accepts native names and international phone formatting', () => {
  expect(passengerErrors(passenger)).toEqual({})
  expect(normalizePassenger(passenger)).toEqual({
    ...passenger,
    passenger_first_name: 'Արամ',
    passenger_phone: '+37499123456',
  })
  expect(
    normalizePassenger({ ...passenger, passenger_first_name: 'Jose\u0301' }).passenger_first_name,
  ).toBe('José')
})

it('rejects missing names, invisible controls and ambiguous phone numbers', () => {
  expect(Object.keys(passengerErrors(emptyPassenger))).toHaveLength(3)
  for (const name of ['123', '  ', 'Ա\nրամ', 'Ա\u200bրամ', 'А'.repeat(101)])
    expect(passengerErrors({ ...passenger, passenger_first_name: name })).toHaveProperty(
      'passenger_first_name',
    )
  for (const phone of [
    '89991234567',
    '+0123456789',
    '+374123',
    '+1234567890123456',
    '+٣٧٤٩٩١٢٣٤٥٦',
    '+3749912\n3456',
  ])
    expect(passengerErrors({ ...passenger, passenger_phone: phone })).toHaveProperty(
      'passenger_phone',
    )
})
