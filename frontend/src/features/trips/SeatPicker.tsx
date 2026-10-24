import { useState } from 'react'
import { Button, ButtonLink, Notice } from '../../shared/ui'
import { formatPrice } from '../search/search'
import type { Seat } from './trip'
import { findLayout } from '../vehicles/catalog'
import { SeatMap } from '../vehicles/SeatMap'

const labels = { FREE: 'Свободно', HELD: 'Временно удерживается', PAID: 'Занято' }

export function SeatPicker({
  seats,
  price,
  busy,
  routeId,
  layoutId,
}: {
  seats: Seat[]
  price: string
  busy: boolean
  routeId: string
  layoutId?: string | null
}) {
  const layout = findLayout(layoutId)
  const [selection, setSelection] = useState<{ seats: Seat[]; id: string | null; lost: boolean }>({
    seats,
    id: null,
    lost: false,
  })
  // Reconcile while rendering new data, before an obsolete choice reaches the screen.
  // A seat becoming free again must not silently restore a previously lost selection.
  if (selection.seats !== seats) {
    const stillFree = seats.some((seat) => seat.id === selection.id && seat.status === 'FREE')
    setSelection({
      seats,
      id: stillFree ? selection.id : null,
      lost: selection.lost || (selection.id !== null && !stillFree),
    })
  }
  const chosen = seats.find((seat) => seat.id === selection.id && seat.status === 'FREE')
  return (
    <div className="seat-layout">
      <div>
        <fieldset className="seat-picker" disabled={busy} aria-describedby="seat-picker-help">
          <legend>Выберите место</legend>
          <p id="seat-picker-help" className="seat-help">
            {layout
              ? 'Схема подтверждена перевозчиком. Передняя часть салона — сверху. Масштаб и расположение дверей не показаны.'
              : 'Для этого автобуса схема салона не подтверждена. Выберите место по номеру; расположение уточняйте у перевозчика.'}
          </p>
          <ul className="seat-legend" aria-label="Обозначения мест">
            <li>
              <span className="seat-dot seat-dot--selected" />
              Выбрано
            </li>
            <li>
              <span className="seat-dot seat-dot--free" />
              Свободно
            </li>
            <li>
              <span className="seat-dot seat-dot--held" />
              Временно удерживается
            </li>
            <li>
              <span className="seat-dot seat-dot--paid" />
              Занято
            </li>
          </ul>
          {layout ? (
            <SeatMap
              layout={layout}
              seats={seats}
              selectedId={chosen?.id}
              disabled={busy}
              onSelect={(id) =>
                setSelection({ seats, id: chosen?.id === id ? null : id, lost: false })
              }
            />
          ) : (
            <div className="seat-grid">
              {seats.map((seat) => (
                <button
                  type="button"
                  key={seat.id}
                  className={`seat seat--${seat.status.toLowerCase()}`}
                  disabled={seat.status !== 'FREE'}
                  aria-pressed={chosen?.id === seat.id}
                  aria-label={`Место ${seat.seat_number}, ${labels[seat.status].toLowerCase()}`}
                  onClick={() =>
                    setSelection({
                      seats,
                      id: chosen?.id === seat.id ? null : seat.id,
                      lost: false,
                    })
                  }
                >
                  <strong>{seat.seat_number}</strong>
                  <span>{chosen?.id === seat.id ? 'Выбрано' : labels[seat.status]}</span>
                </button>
              ))}
            </div>
          )}
        </fieldset>
      </div>
      <aside className="seat-choice" aria-labelledby="seat-choice-title">
        <span className="eyebrow">ВАША ПОЕЗДКА</span>
        <h2 id="seat-choice-title">
          {chosen ? `Место ${chosen.seat_number}` : 'Выберите свободное место'}
        </h2>
        <p className="seat-choice-price">
          {formatPrice(price)}
          <span>за одного пассажира</span>
        </p>
        <div aria-live="polite">
          {selection.lost && (
            <Notice title="Выбранное место стало недоступно">
              Выберите другое свободное место.
            </Notice>
          )}
          {chosen && (
            <p className="seat-choice-status">
              {busy
                ? 'Проверяем доступность выбранного места…'
                : `Выбрано место ${chosen.seat_number}.`}
            </p>
          )}
        </div>
        <p className="seat-help">
          Выбор на этой странице не удерживает место. Доступность может измениться до бронирования.
        </p>
        {chosen && (
          <div className="booking-choice-actions">
            {!busy && (
              <ButtonLink to={`/trips/${routeId}/book?seat=${chosen.id}`}>
                Перейти к бронированию
              </ButtonLink>
            )}
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => setSelection({ seats, id: null, lost: false })}
            >
              Снять выбор
            </Button>
          </div>
        )}
      </aside>
      {chosen && !busy && (
        <div
          className="seat-mobile-action"
          role="region"
          aria-label="Выбранное место и бронирование"
        >
          <span>
            <strong>Место {chosen.seat_number}</strong>
            <span>{formatPrice(price)}</span>
          </span>
          <ButtonLink to={`/trips/${routeId}/book?seat=${chosen.id}`}>Бронировать</ButtonLink>
        </div>
      )}
    </div>
  )
}
