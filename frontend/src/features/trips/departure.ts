import { cities, cityTimezone, type Country } from '../cities/catalog'

const zoneNames: Record<string, string> = {
  'Europe/Kaliningrad': 'Калининград',
  'Europe/Kirov': 'Киров',
  'Europe/Astrakhan': 'Астрахань',
  'Europe/Ulyanovsk': 'Ульяновск',
  'Asia/Barnaul': 'Барнаул',
  'Asia/Tomsk': 'Томск',
  'Asia/Novokuznetsk': 'Новокузнецк',
  'Asia/Chita': 'Чита',
  'Asia/Yakutsk': 'Якутск',
  'Asia/Khandyga': 'Хандыга',
  'Asia/Vladivostok': 'Владивосток',
  'Asia/Ust-Nera': 'Усть-Нера',
  'Asia/Magadan': 'Магадан',
  'Asia/Sakhalin': 'Сахалин',
  'Asia/Srednekolymsk': 'Среднеколымск',
  'Asia/Kamchatka': 'Камчатка',
  'Asia/Anadyr': 'Анадырь',
  UTC: 'UTC — для старых записей с неизвестным поясом',
}
export const timezoneLabel = (zone: string) =>
  cities.find((city) => city.timezone === zone)?.names.ru ?? zoneNames[zone] ?? zone

export type TravelDetails = {
  departure_timezone?: string | null
  boarding_address?: string | null
  dropoff_address?: string | null
}
type Journey = TravelDetails & { origin: string; origin_country?: Country; departure_at: string }

export function validTimezone(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 64) return false
  try {
    new Intl.DateTimeFormat('en', { timeZone: value })
    return true
  } catch {
    return false
  }
}
export function validTravelDetails(value: TravelDetails): boolean {
  return (
    (value.departure_timezone == null || validTimezone(value.departure_timezone)) &&
    [value.boarding_address, value.dropoff_address].every(
      (address) =>
        address == null ||
        (typeof address === 'string' &&
          address.trim().length >= 5 &&
          [...address].length <= 500 &&
          !/\p{C}/u.test(address)),
    )
  )
}
export function journeyZone(journey: Omit<Journey, 'departure_at'>): string {
  return journey.departure_timezone ?? cityTimezone(journey.origin, journey.origin_country) ?? 'UTC'
}
export function formatDeparture(journey: Journey) {
  const zone = journeyZone(journey)
  const date = new Date(journey.departure_at)
  const offset = new Intl.DateTimeFormat('en', { timeZone: zone, timeZoneName: 'shortOffset' })
    .formatToParts(date)
    .find((part) => part.type === 'timeZoneName')!
    .value.replace('GMT', 'UTC')
  return {
    date: new Intl.DateTimeFormat('ru-RU', { dateStyle: 'long', timeZone: zone }).format(date),
    time: new Intl.DateTimeFormat('ru-RU', { timeStyle: 'short', timeZone: zone }).format(date),
    offset,
    zone,
  }
}
export function localInput(iso: string, zone: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(iso))
  const get = (name: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === name)!.value
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`
}
export function localDepartureIso(input: string, zone: string): string | null {
  if (!/^[1-9]\d{3}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(input) || !validTimezone(zone)) return null
  const naive = new Date(`${input}:00Z`).getTime()
  if (!Number.isFinite(naive) || new Date(naive).toISOString().slice(0, 16) !== input) return null
  // Collect candidate offsets around the wall time; verify by a round trip.
  // A gap has no candidates; a repeated DST time has two and needs clarification.
  const matches = new Set<number>()
  for (let hour = -36; hour <= 36; hour += 6) {
    const sample = naive + hour * 3_600_000
    const offset =
      new Date(`${localInput(new Date(sample).toISOString(), zone)}:00Z`).getTime() - sample
    const candidate = naive - offset
    if (Number.isFinite(candidate) && localInput(new Date(candidate).toISOString(), zone) === input)
      matches.add(candidate)
  }
  return matches.size === 1 ? new Date([...matches][0]).toISOString() : null
}
