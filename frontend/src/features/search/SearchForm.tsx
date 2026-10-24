import { useId, useState } from 'react'
import { useNavigate } from 'react-router'
import { Button, Field } from '../../shared/ui'
import { readSearch, searchUrl } from './search'
import { CityInput } from '../cities/CityInput'

export function SearchForm({
  initial,
  onRepeat,
}: {
  initial?: URLSearchParams
  onRepeat?: () => void
}) {
  const navigate = useNavigate()
  const hintId = useId()
  const [origin, setOrigin] = useState(initial?.get('origin')?.slice(0, 200) ?? '')
  const [destination, setDestination] = useState(initial?.get('destination')?.slice(0, 200) ?? '')
  const [date, setDate] = useState(initial?.get('date') ?? '')
  const [error, setError] = useState('')
  return (
    <form
      className="search-panel"
      aria-label="Поиск рейсов"
      aria-describedby={hintId}
      onSubmit={(event) => {
        event.preventDefault()
        const input = readSearch(new URLSearchParams({ origin, destination, date }))
        if (!input) {
          setError('Введите названия обоих городов и корректную дату.')
          return
        }
        setError('')
        const current = initial ? readSearch(initial) : null
        if (current && searchUrl(input) === searchUrl(current)) onRepeat?.()
        else navigate(searchUrl(input))
      }}
    >
      <div className="search-fields">
        <CityInput label="Откуда" name="origin" required value={origin} onChange={setOrigin} />
        <button
          className="swap-cities"
          type="button"
          aria-label="Поменять города местами"
          onClick={() => {
            setOrigin(destination)
            setDestination(origin)
          }}
        >
          <span aria-hidden="true">⇄</span>
        </button>
        <CityInput
          label="Куда"
          name="destination"
          required
          value={destination}
          onChange={setDestination}
        />
        <Field
          label="Дата отправления (UTC)"
          name="date"
          type="date"
          required
          max="9999-12-30"
          value={date}
          onChange={(event) => setDate(event.target.value)}
        />
        <Button type="submit">Найти рейсы</Button>
      </div>
      <p id={hintId} className="search-hint">
        Город можно найти на русском, английском или армянском. Время отправления — UTC.
      </p>
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
    </form>
  )
}
