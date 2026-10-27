import { Link } from 'react-router'
import { searchUrl, type SearchInput } from './search'
import { nearbyDates } from './nearby-dates'
import './nearby-dates.css'

const shortDate = new Intl.DateTimeFormat('ru-RU', {
  day: 'numeric',
  month: 'short',
  timeZone: 'UTC',
})
const weekday = new Intl.DateTimeFormat('ru-RU', { weekday: 'short', timeZone: 'UTC' })
const fullDate = new Intl.DateTimeFormat('ru-RU', { dateStyle: 'full', timeZone: 'UTC' })

export function NearbyDates({ input }: { input: SearchInput }) {
  return (
    <nav className="nearby-dates" aria-label="Соседние даты отправления">
      <p>
        Посмотреть другую дату <span>Даты по городу отправления</span>
      </p>
      <div>
        {nearbyDates(input.date).map((value) => {
          const date = new Date(`${value}T00:00:00Z`)
          const content = (
            <>
              <strong>{shortDate.format(date)}</strong>
              <span>{weekday.format(date)}</span>
            </>
          )
          return value === input.date ? (
            <span
              key={value}
              aria-current="date"
              aria-label={`Выбранная дата: ${fullDate.format(date)}`}
            >
              {content}
            </span>
          ) : (
            <Link
              key={value}
              to={searchUrl({ ...input, date: value, offset: 0 })}
              aria-label={`Найти рейсы: ${fullDate.format(date)}`}
            >
              {content}
            </Link>
          )
        })}
      </div>
    </nav>
  )
}
