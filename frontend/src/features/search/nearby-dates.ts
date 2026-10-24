import { validDate } from './search'

export function nearbyDates(value: string): string[] {
  if (!validDate(value)) return []
  const midnight = Date.parse(`${value}T00:00:00Z`)
  return [-2, -1, 0, 1, 2]
    .map((offset) => new Date(midnight + offset * 86_400_000).toISOString().slice(0, 10))
    .filter(validDate)
}
