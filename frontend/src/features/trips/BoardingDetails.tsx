import type { TravelDetails } from './departure'

export function BoardingDetails({ journey }: { journey: TravelDetails }) {
  return (
    <dl className="boarding-details">
      <div>
        <dt>Место посадки</dt>
        <dd>
          {journey.boarding_address ?? 'Адрес ещё не указан. Уточните у перевозчика до поездки.'}
        </dd>
      </div>
      <div>
        <dt>Место высадки</dt>
        <dd>
          {journey.dropoff_address ?? 'Адрес ещё не указан. Уточните у перевозчика до поездки.'}
        </dd>
      </div>
    </dl>
  )
}
