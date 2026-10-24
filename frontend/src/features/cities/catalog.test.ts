import { describe, expect, it } from 'vitest'
import { cities, cityName, citySuggestions } from './catalog'

describe('shared multilingual city catalog', () => {
  it('finds one Yerevan identity in three languages and spelling variants', () => {
    for (const query of ['Yere', 'ЕРЕВ', 'Երև', 'Երեւ']) {
      expect(citySuggestions(query).map((city) => city.id)).toContain('am-yerevan')
    }
    expect(cityName('am-yerevan')).toBe('Ереван')
  })
  it('keeps same-named cities separate and filters by country', () => {
    expect(
      citySuggestions('Armavir')
        .map((city) => city.id)
        .sort(),
    ).toEqual(['am-armavir', 'ru-armavir'])
    expect(citySuggestions('Արմավիր', 'AM').map((city) => city.id)).toEqual(['am-armavir'])
    expect(cities.length).toBeLessThanOrEqual(100)
  })
})
