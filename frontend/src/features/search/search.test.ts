import { afterEach, expect, it, vi } from 'vitest'
import {
  departureDate,
  departureTime,
  formatPrice,
  readSearch,
  searchRoutes,
  searchUrl,
  validDate,
} from './search'
import { ApiError } from '../../shared/api/client'

afterEach(() => vi.unstubAllGlobals())
const input = { origin: 'Ростов-на-Дону', destination: 'Գյումրի', date: '2030-06-01', offset: 0 }
const route = {
  id: 'test-route',
  origin: input.origin,
  destination: input.destination,
  origin_country: 'RU',
  destination_country: 'AM',
  departure_at: '2030-06-02T01:00:00+03:00',
  price: '4500.50',
  currency: 'RUB',
  status: 'ACTIVE',
  company_name: 'Test carrier',
  bus_name: 'Test bus',
  capacity: 2,
  free_seats: 0,
}

it('preserves Unicode and literal SQL/URL punctuation through a shareable search URL', () => {
  const search = { ...input, origin: '  Город %_&+  ', offset: 20 }
  const params = new URL(searchUrl(search), 'http://localhost').searchParams
  expect(readSearch(params)).toEqual({ ...search, origin: search.origin.trim() })
})

it('rejects impossible dates, repeated parameters, blank cities and invalid offsets', () => {
  for (const date of ['2030-02-29', '2030-04-31', '0000-01-01', '9999-12-31', '30-01-01'])
    expect(validDate(date)).toBe(false)
  expect(validDate('2032-02-29')).toBe(true)
  expect(validDate('0001-01-01')).toBe(true)
  for (const changes of [
    { offset: '-20' },
    { offset: '1' },
    { offset: '10020' },
    { offset: '2e1' },
    { origin: ' ' },
    { destination: 'a'.repeat(201) },
  ]) {
    expect(readSearch(new URLSearchParams({ ...input, offset: '0', ...changes }))).toBeNull()
  }
  const duplicate = new URLSearchParams({ ...input, offset: '0' })
  duplicate.append('date', input.date)
  expect(readSearch(duplicate)).toBeNull()
})

it('formats exact decimal prices and UTC dates across midnight', () => {
  expect(formatPrice('9999999999.99')).toBe('9\u00a0999\u00a0999\u00a0999,99 ₽')
  expect(formatPrice('0.01')).toBe('0,01 ₽')
  expect(formatPrice('4500.5')).toBe('4\u00a0500,50 ₽')
  expect(departureDate.format(new Date(route.departure_at))).toContain('1 июня 2030')
  expect(departureTime.format(new Date(route.departure_at))).toBe('22:00')
})

it('fetches one lookahead record without displaying or skipping it and uses no credentials', async () => {
  const fetch = vi.fn().mockImplementation(
    async () =>
      new Response(
        JSON.stringify({
          items: Array.from({ length: 21 }, (_, i) => ({ ...route, id: String(i) })),
          limit: 21,
          offset: 0,
        }),
      ),
  )
  vi.stubGlobal('fetch', fetch)
  const result = await searchRoutes(input)
  expect(result.items).toHaveLength(20)
  expect(result.items[19].id).toBe('19')
  expect(result.hasNext).toBe(true)
  expect(new URL(fetch.mock.calls[0][0], 'http://localhost').searchParams.get('limit')).toBe('21')
  expect(fetch.mock.calls[0][1].credentials).toBe('omit')
})

it('rejects malformed prices, availability, times and pagination at the API boundary', async () => {
  for (const changes of [
    { price: 4500.5 },
    { price: 'NaN' },
    { price: '-1.00' },
    { free_seats: 3 },
    { free_seats: -1 },
    { departure_at: 'not a date' },
    { departure_at: '2030-06-01T12:00:00' },
    { currency: 'AMD' },
  ]) {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ items: [{ ...route, ...changes }], limit: 21, offset: 0 })),
        ),
    )
    await expect(searchRoutes(input)).rejects.toBeInstanceOf(ApiError)
  }
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(new Response(JSON.stringify({ items: [], limit: 20, offset: 0 }))),
  )
  await expect(searchRoutes(input)).rejects.toMatchObject({ problem: { code: 'INVALID_RESPONSE' } })
})
