import type { VehicleLayout } from './catalog'
import { useRef } from 'react'
import type { KeyboardEvent } from 'react'
import './vehicles.css'

export type MapSeat = {
  id: string
  seat_number: number
  status: 'FREE' | 'HELD' | 'PAID'
}
const labels = { FREE: 'Свободно', HELD: 'Временно удерживается', PAID: 'Занято' }

export function SeatMap({
  layout,
  seats,
  selectedId,
  onSelect,
  disabled = false,
}: {
  layout: VehicleLayout
  seats: MapSeat[]
  selectedId?: string | null
  onSelect?: (id: string) => void
  disabled?: boolean
}) {
  const byNumber = new Map(seats.map((seat) => [seat.seat_number, seat]))
  const cabin = useRef<HTMLDivElement>(null)
  function moveFocus(event: KeyboardEvent<HTMLDivElement>) {
    if (!onSelect || disabled) return
    const directions: Record<string, number[]> = {
      ArrowUp: [-1, 0],
      ArrowDown: [1, 0],
      ArrowLeft: [0, -1],
      ArrowRight: [0, 1],
    }
    const direction = directions[event.key]
    if (!direction) return
    const target = (event.target as HTMLElement).closest<HTMLButtonElement>(
      'button[data-seat-number]',
    )
    if (!target) return
    event.preventDefault()
    const number = Number(target.dataset.seatNumber)
    let row = layout.rows.findIndex((cells) => cells.includes(number))
    let column = layout.rows[row].indexOf(number)
    while (true) {
      row += direction[0]
      column += direction[1]
      if (row < 0 || row >= layout.rows.length || column < 0 || column >= layout.columns) return
      const next = layout.rows[row][column]
      if (next !== null && byNumber.get(next)?.status === 'FREE') {
        cabin.current?.querySelector<HTMLButtonElement>(`[data-seat-number="${next}"]`)?.focus()
        return
      }
    }
  }
  return (
    <div
      className="cabin"
      role="group"
      aria-label={`Схема салона: ${layout.title}`}
      ref={cabin}
      onKeyDown={moveFocus}
    >
      <div className="cabin-front">
        <span className="cabin-driver">
          <span aria-hidden="true">◉</span> Водитель
        </span>
        <span>Передняя часть</span>
      </div>
      <p className="cabin-aisle">Между креслами — проход</p>
      <ol className="cabin-rows">
        {layout.rows.map((row, rowIndex) => (
          <li
            key={rowIndex}
            className="cabin-row"
            style={{ gridTemplateColumns: `repeat(${layout.columns}, minmax(0, 1fr))` }}
          >
            {row.map((number, column) => {
              const seat = number === null ? undefined : byNumber.get(number)
              if (!seat) return <span key={column} aria-hidden="true" className="cabin-gap" />
              const selected = selectedId === seat.id
              return onSelect ? (
                <button
                  type="button"
                  key={column}
                  className={`cabin-seat cabin-seat--${seat.status.toLowerCase()}`}
                  disabled={disabled || seat.status !== 'FREE'}
                  aria-pressed={selected}
                  data-seat-number={number}
                  aria-label={`Место ${number}, ${labels[seat.status].toLowerCase()}`}
                  onClick={() => onSelect(seat.id)}
                >
                  <span>{number}</span>
                  <span className="sr-only">{selected ? 'Выбрано' : labels[seat.status]}</span>
                </button>
              ) : (
                <span
                  key={column}
                  className="cabin-seat cabin-seat--preview"
                  aria-label={`Место ${number}`}
                >
                  {number}
                </span>
              )
            })}
          </li>
        ))}
      </ol>
      <p className="cabin-rear">Задняя часть салона</p>
    </div>
  )
}

export function LayoutPreview({ layout }: { layout: VehicleLayout }) {
  return (
    <SeatMap
      layout={layout}
      seats={layout.rows
        .flat()
        .filter((n): n is number => n !== null)
        .map((n) => ({ id: `preview-${n}`, seat_number: n, status: 'FREE' }))}
    />
  )
}
