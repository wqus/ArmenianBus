import { formatPrice } from '../search/search'
import { formatDeparture, type TravelDetails } from '../trips/departure'
import { BoardingDetails } from '../trips/BoardingDetails'

export function JourneySummary({
  journey,
}: {
  journey: TravelDetails & {
    origin: string
    destination: string
    departure_at: string
    seat_number?: number
    company_name: string
    amount: string
  }
}) {
  const departure = formatDeparture(journey)
  return (
    <section className="journey-summary" aria-label="Сведения о выбранной поездке">
      <p className="journey-caption">Ваша поездка</p>
      <h2>
        {journey.origin} <span aria-hidden="true">→</span> {journey.destination}
      </h2>
      <dl>
        <div>
          <dt>Отправление · время города отправления</dt>
          <dd>
            <time dateTime={journey.departure_at}>
              {departure.date}
              <strong>
                {departure.time} {departure.offset}
              </strong>
            </time>
          </dd>
        </div>
        {journey.seat_number !== undefined && (
          <div>
            <dt>Место</dt>
            <dd>{journey.seat_number}</dd>
          </div>
        )}
        <div>
          <dt>Перевозчик</dt>
          <dd>{journey.company_name}</dd>
        </div>
        <div className="journey-summary-total">
          <dt>За одного пассажира</dt>
          <dd>{formatPrice(journey.amount)}</dd>
        </div>
      </dl>
      <BoardingDetails journey={journey} />
    </section>
  )
}

export function BookingSupport({ id }: { id: string }) {
  const href = `mailto:support@mathbot.site?subject=${encodeURIComponent(`Вопрос по брони ${id}`)}`
  return (
    <div className="booking-support">
      <p>Нужна помощь с поездкой или оплатой?</p>
      <a href={href}>Написать в поддержку</a>
      <p className="booking-reference">
        Номер брони: <span>{id}</span>
      </p>
    </div>
  )
}
