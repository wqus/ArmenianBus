import { useId, useState } from 'react'
import { cityById, cityName, citySuggestions, countryNames } from './catalog'
import type { City, Country } from './catalog'
import './cities.css'

export function CityInput({
  label,
  name,
  value,
  onChange,
  country,
  required = true,
  disabled = false,
}: {
  label: string
  name: string
  value: string
  onChange: (value: string) => void
  country?: Country
  required?: boolean
  disabled?: boolean
}) {
  const id = useId()
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  const selected = cityById(value)
  const matches = citySuggestions(selected ? '' : value, country).slice(0, 8)
  function choose(city: City) {
    onChange(city.id)
    setOpen(false)
    setActive(-1)
  }
  return (
    <div className="field city-field">
      <label htmlFor={id}>{label}</label>
      <div className="city-control">
        <input
          id={id}
          name={name}
          role="combobox"
          autoComplete="off"
          spellCheck={false}
          required={required}
          disabled={disabled}
          maxLength={200}
          value={cityName(value)}
          onChange={(event) => {
            onChange(event.target.value)
            setOpen(Boolean(event.target.value.trim()))
            setActive(-1)
          }}
          onFocus={() => {
            setOpen(true)
            setActive(-1)
          }}
          onBlur={() => setOpen(false)}
          aria-expanded={open && matches.length > 0}
          aria-autocomplete="list"
          aria-controls={`${id}-list`}
          aria-activedescendant={
            open && active >= 0 && matches[active]
              ? `${id}-option-${matches[active].id}`
              : undefined
          }
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault()
              setOpen(true)
              setActive((index) =>
                event.key === 'ArrowDown'
                  ? Math.min(index + 1, matches.length - 1)
                  : Math.max(index - 1, 0),
              )
            }
            if (event.key === 'Escape') {
              event.preventDefault()
              setOpen(false)
              setActive(-1)
            }
            if (event.key === 'Enter' && open && active >= 0 && matches[active]) {
              event.preventDefault()
              choose(matches[active])
            }
          }}
        />
        <ul
          id={`${id}-list`}
          role="listbox"
          aria-label={`Города: ${label}`}
          hidden={!open || !matches.length}
        >
          {matches.map((city, index) => (
            <li
              key={city.id}
              id={`${id}-option-${city.id}`}
              role="option"
              aria-selected={active === index}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => choose(city)}
            >
              <span>
                {city.names.ru}
                <small>{countryNames[city.country]}</small>
              </span>
              <span className="city-alternates">
                {city.names.en} · {city.names.hy}
              </span>
            </li>
          ))}
        </ul>
        {open && !matches.length && (
          <p className="city-empty" role="status">
            В справочнике нет совпадений. Проверьте название.
          </p>
        )}
      </div>
    </div>
  )
}
