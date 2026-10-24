export function PassengerInfo({
  passenger,
}: {
  passenger: {
    passenger_first_name?: string | null
    passenger_last_name?: string | null
    passenger_phone?: string | null
  }
}) {
  return (
    <div className="passenger-contact">
      <h3>Пассажир</h3>
      {passenger.passenger_first_name && passenger.passenger_last_name ? (
        <dl className="booking-info">
          <div>
            <dt>Имя и фамилия</dt>
            <dd>
              {passenger.passenger_first_name} {passenger.passenger_last_name}
            </dd>
          </div>
          <div>
            <dt>Контактный телефон</dt>
            <dd>{passenger.passenger_phone ?? 'Не указан'}</dd>
          </div>
        </dl>
      ) : (
        <p>
          В этой брони данные пассажира ещё не собирались. Если нужно уточнить их, обратитесь в
          поддержку.
        </p>
      )}
    </div>
  )
}
