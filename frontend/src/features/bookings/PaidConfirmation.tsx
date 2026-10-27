import type { BookingDetails } from './booking'
import { JourneySummary } from './JourneySummary'
import { PassengerInfo } from './PassengerInfo'

export function PaidConfirmation({ booking }: { booking: BookingDetails }) {
  return (
    <section
      className="booking-panel paid-confirmation"
      aria-label="Подтверждение оплаченной брони"
    >
      <p className="journey-caption">armatrans · Оплата подтверждена</p>
      <h2>Подтверждение бронирования</h2>
      <p className="booking-reference">
        Номер брони: <span>{booking.id}</span>
      </p>
      <JourneySummary journey={booking} />
      <PassengerInfo passenger={booking} />
      <p>
        Сведения о брони на момент проверки:{' '}
        {new Intl.DateTimeFormat('ru-RU', {
          dateStyle: 'short',
          timeStyle: 'short',
          timeZone: 'UTC',
        }).format(new Date(booking.server_time))}{' '}
        UTC.
      </p>
      <p>
        Перед поездкой проверьте статус брони в личном кабинете. Подтверждение не является кассовым
        чеком. Следуйте адресу посадки в подтверждении; если он не указан, заранее уточните его у
        перевозчика.
      </p>
      <p>Поддержка: support@mathbot.site · bus.mathbot.site</p>
    </section>
  )
}
