import data from './catalog.json'

export type Country = 'RU' | 'AM'
export type City = {
  id: string
  country: Country
  names: { ru: string; en: string; hy: string }
  aliases: string[]
  timezone: string
}
export const cities = data as City[]
export const countryNames = { RU: 'Россия', AM: 'Армения' }
export const normalizeCity = (value: string) =>
  value.normalize('NFKC').toLowerCase().replaceAll('ё', 'е').trim().replace(/\s+/g, ' ')
export const cityAliases = (city: City) => [city.id, ...Object.values(city.names), ...city.aliases]
export const cityById = (id: string) => cities.find((city) => city.id === id)
export const cityName = (value: string) => cityById(value)?.names.ru ?? value
export function cityTimezone(value: string, country?: Country): string | null {
  const key = normalizeCity(value)
  const matches = cities.filter(
    (city) =>
      (!country || city.country === country) &&
      cityAliases(city).some((alias) => normalizeCity(alias) === key),
  )
  return matches.length === 1 ? matches[0].timezone : null
}
export function citySuggestions(value: string, country?: Country): City[] {
  const key = normalizeCity(value)
  return cities
    .filter(
      (city) =>
        (!country || city.country === country) &&
        (!key || cityAliases(city).some((a) => normalizeCity(a).includes(key))),
    )
    .sort((a, b) => {
      const score = (city: City) =>
        cityAliases(city).some((a) => normalizeCity(a) === key)
          ? 0
          : cityAliases(city).some((a) => normalizeCity(a).startsWith(key))
            ? 1
            : 2
      return score(a) - score(b)
    })
}
