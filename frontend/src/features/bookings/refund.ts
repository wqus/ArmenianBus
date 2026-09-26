import type { BookingDetails } from './booking'

export function refundSummary(booking: BookingDetails) {
  if (booking.refund_status === 'OPEN')
    return {
      title: 'Заявка на возврат открыта',
      text: 'Возврат обрабатывается вручную. После записи результата оператором здесь появится отметка о выполнении.',
    }
  if (booking.refund_status === 'REFUND_RECORDED')
    return {
      title: 'Возврат отмечен оператором',
      text: 'Оператор записал выполнение ручного возврата. Если деньги ещё не поступили, обратитесь в поддержку с номером брони.',
    }
  return null
}
