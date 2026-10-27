import { expect, it } from 'vitest'
import {
  formatDeparture,
  journeyZone,
  localInput,
  localDepartureIso,
  validTravelDetails,
} from './departure'

it('uses the departure city, never the browser zone, including the next calendar day', () => {
  const at = '2030-06-01T22:00:00Z'
  const moscow = formatDeparture({ origin: 'Moscow', departure_at: at })
  expect(moscow).toMatchObject({
    date: '2 июня 2030 г.',
    time: '01:00',
    offset: 'UTC+3',
    zone: 'Europe/Moscow',
  })
  expect(formatDeparture({ origin: 'Երևան', departure_at: at }).time).toBe('02:00')
  expect(formatDeparture({ origin: 'Екатеринбург', departure_at: at }).time).toBe('03:00')
  expect(journeyZone({ origin: 'Armavir' })).toBe('UTC')
  expect(journeyZone({ origin: 'Armavir', origin_country: 'AM' })).toBe('Asia/Yerevan')
  expect(journeyZone({ origin: 'Custom', departure_timezone: 'Asia/Omsk' })).toBe('Asia/Omsk')
})

it('round-trips carrier local inputs and rejects invalid, skipped and repeated times', () => {
  expect(localDepartureIso('2030-06-02T01:00', 'Europe/Moscow')).toBe('2030-06-01T22:00:00.000Z')
  expect(localDepartureIso('2030-03-01T12:30', 'Asia/Yerevan')).toBe('2030-03-01T08:30:00.000Z')
  expect(localInput('2030-06-01T22:00:39.123Z', 'Asia/Yerevan')).toBe('2030-06-02T02:00')
  expect(localDepartureIso('2030-02-30T10:00', 'UTC')).toBeNull()
  expect(localDepartureIso('2030-03-10T02:30', 'America/New_York')).toBeNull()
  expect(localDepartureIso('2030-11-03T01:30', 'America/New_York')).toBeNull()
  expect(localDepartureIso('2030-06-01T10:00', 'Wrong/Zone')).toBeNull()
  expect(localDepartureIso('9999-12-31T23:59', 'Europe/Moscow')).toBe('9999-12-31T20:59:00.000Z')
})

it('accepts legacy details and rejects malformed addresses and zones', () => {
  expect(validTravelDetails({})).toBe(true)
  expect(
    validTravelDetails({
      boarding_address: 'Автостанция, платформа 2',
      departure_timezone: 'Asia/Yerevan',
    }),
  ).toBe(true)
  expect(validTravelDetails({ boarding_address: '   ' })).toBe(false)
  expect(validTravelDetails({ dropoff_address: 'Адрес\u200b 1' })).toBe(false)
  expect(validTravelDetails({ departure_timezone: 'Wrong/Zone' })).toBe(false)
})
