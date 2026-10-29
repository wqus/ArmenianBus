import type { BookingDetails } from './booking'
import { refundSummary } from './refund'

const paymentLabels = {
  PENDING: 'Ожидает подтверждения',
  SUCCEEDED: 'Платёж подтверждён',
  CANCELED: 'Отменён провайдером',
  FAILED: 'Не выполнен',
}
export function BookingFinancials({ booking }: { booking: BookingDetails }) {
  const refund = refundSummary(booking)
  return (
    <div className="booking-financials">
      <p>
        <strong>Платёж:</strong>{' '}
        {booking.payment_review_reason
          ? 'Требует проверки'
          : booking.payment_status
            ? paymentLabels[booking.payment_status]
            : 'Не создан'}
      </p>
      {refund && (
        <div className="booking-refund">
          <h3>{refund.title}</h3>
          <p>{refund.text}</p>
        </div>
      )}
    </div>
  )
}
