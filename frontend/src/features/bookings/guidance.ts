import type { BookingDetails } from './booking'

export function hasPaidConfirmation(
  booking: Pick<BookingDetails, 'status' | 'route_status' | 'refund_status' | 'payment_status'>,
): boolean {
  return (
    booking.status === 'PAID' &&
    booking.payment_status === 'SUCCEEDED' &&
    booking.refund_status === null &&
    ['ACTIVE', 'DEPARTED'].includes(booking.route_status)
  )
}

export function bookingGuidance(
  booking: Pick<BookingDetails, 'status' | 'route_status' | 'refund_status' | 'payment_status'>,
): string {
  if (booking.refund_status === 'OPEN')
    return 'Бронь отменена или требует возврата. Заявка обрабатывается отдельно — это ещё не подтверждение поступления денег.'
  if (booking.refund_status === 'REFUND_RECORDED')
    return 'Оператор отметил ручной возврат. Срок поступления денег уточняйте у банка; при вопросах сохраните номер брони.'
  if (booking.route_status === 'CANCELLED')
    return 'Рейс отменён. Если оплата уже прошла, проверьте сведения о возврате или обратитесь в поддержку.'
  if (booking.payment_status === 'SUCCEEDED' && !['PAID', 'COMPLETED'].includes(booking.status))
    return 'Оплата получена, но бронь пока не подтверждена как оплаченная. Не оплачивайте повторно: проверьте результат или обратитесь в поддержку.'
  if (booking.status === 'HELD' && booking.payment_status === 'PENDING')
    return 'Платёж ожидает результата. Откройте его состояние; если уже оплатили, дождитесь подтверждения и не платите повторно.'
  if (booking.status === 'HELD' && ['CANCELED', 'FAILED'].includes(booking.payment_status ?? ''))
    return 'Платёж завершён без подтверждённой оплаты. Откройте его результат: там описано дальнейшее действие перед новой попыткой.'
  return {
    HELD: 'Место временно закреплено за вами. Завершите оплату до окончания удержания, чтобы подтвердить поездку.',
    PAID: 'Оплата и бронирование подтверждены. Сохраните сведения о поездке и уточните условия посадки у перевозчика.',
    EXPIRED:
      'Срок удержания закончился. Для новой брони снова выберите свободное место. Если уже платили, сначала проверьте результат оплаты.',
    CANCELLED:
      'Эта бронь отменена и не даёт права на поездку. Если оплата уже прошла, проверьте сведения о возврате.',
    COMPLETED: 'Поездка завершена. Сведения о бронировании и оплате сохранены в истории.',
  }[booking.status]
}
