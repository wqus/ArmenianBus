import { expect, it } from 'vitest'
import { nearbyDates } from './nearby-dates'

it('uses calendar days across leap day and year boundaries', () => {
  expect(nearbyDates('2032-03-01')).toEqual([
    '2032-02-28',
    '2032-02-29',
    '2032-03-01',
    '2032-03-02',
    '2032-03-03',
  ])
  expect(nearbyDates('2030-01-01')).toEqual([
    '2029-12-30',
    '2029-12-31',
    '2030-01-01',
    '2030-01-02',
    '2030-01-03',
  ])
})

it('does not produce dates outside the API range or accept impossible dates', () => {
  expect(nearbyDates('0001-01-01')).toEqual(['0001-01-01', '0001-01-02', '0001-01-03'])
  expect(nearbyDates('9999-12-30')).toEqual(['9999-12-28', '9999-12-29', '9999-12-30'])
  expect(nearbyDates('2030-02-29')).toEqual([])
  expect(nearbyDates('invalid')).toEqual([])
})
