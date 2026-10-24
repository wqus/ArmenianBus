import { useQuery } from '@tanstack/react-query'
import { useParams, useSearchParams } from 'react-router'
import { ApiError } from '../shared/api/client'
import { Button, ButtonLink, Notice, Loading, PageHeading } from '../shared/ui'
import { departureDate, departureTime } from '../features/search/search'
import { backToSearch, getTrip, isUuid, tripError } from '../features/trips/trip'
import { SeatPicker } from '../features/trips/SeatPicker'

function TripDetails({ id }: { id: string }) {
  const query = useQuery({
    queryKey: ['public-trip', id],
    queryFn: ({ signal }) => getTrip(id, signal),
    staleTime: 0,
    networkMode: 'always',
    refetchOnWindowFocus: 'always',
    refetchInterval: (query) => (query.state.error ? false : 15_000),
    refetchIntervalInBackground: false,
  })
  const trip = query.data
  const unavailable = query.error instanceof ApiError && query.error.status === 404
  return (
    <>
      <PageHeading
        eyebrow="ДЕТАЛИ ПОЕЗДКИ"
        title={
          trip && !query.isError
            ? `${trip.route.origin} → ${trip.route.destination}`
            : 'Рейс и места'
        }
      >
        Проверьте отправление и выберите свободное место.
      </PageHeading>
      <div className="trip-toolbar">
        <p role="status">
          {query.isFetching
            ? 'Обновляем рейс и места…'
            : query.isError
              ? 'Доступность не подтверждена'
              : 'Доступность обновляется автоматически'}
        </p>
        <Button
          variant="secondary"
          busy={query.isFetching}
          onClick={() => {
            void query.refetch()
          }}
        >
          Обновить места
        </Button>
      </div>
      {query.isError ? (
        <Notice title={unavailable ? 'Рейс недоступен' : 'Не удалось загрузить рейс'} error>
          {unavailable
            ? 'Рейс больше не доступен для выбора или ссылка неверна. Вернитесь к поиску, чтобы найти другую поездку.'
            : tripError(query.error)}
        </Notice>
      ) : !trip ? (
        <Loading title="Загружаем рейс…">Проверяем расписание и места.</Loading>
      ) : (
        <>
          <section className="trip-overview" aria-label="Информация о рейсе">
            <dl>
              <div>
                <dt>Отправление · UTC</dt>
                <dd>
                  <time dateTime={trip.route.departure_at}>
                    {departureDate.format(new Date(trip.route.departure_at))}
                    <strong>{departureTime.format(new Date(trip.route.departure_at))} UTC</strong>
                  </time>
                </dd>
              </div>
              <div>
                <dt>Перевозчик</dt>
                <dd>{trip.route.company_name}</dd>
              </div>
              <div>
                <dt>Автобус</dt>
                <dd>
                  {trip.route.bus_name}
                  <span>Мест: {trip.route.capacity}</span>
                </dd>
              </div>
              <div>
                <dt>Доступность</dt>
                <dd>{query.isFetching ? 'Проверяем…' : `Свободных мест: ${trip.freeSeats}`}</dd>
              </div>
            </dl>
          </section>
          {trip.freeSeats === 0 && !query.isFetching && (
            <Notice title="Свободных мест нет">
              Можно обновить доступность позже или выбрать другой рейс в поиске.
            </Notice>
          )}
          <SeatPicker
            key={trip.route.bus_id}
            seats={trip.seats}
            price={trip.route.price}
            busy={query.isFetching}
            routeId={trip.route.id}
            layoutId={trip.layoutId}
          />
        </>
      )}
    </>
  )
}

export function TripPage() {
  const { id = '' } = useParams()
  const [params] = useSearchParams()
  return (
    <div className="container trip-page">
      <ButtonLink to={backToSearch(params)} secondary>
        К результатам поиска
      </ButtonLink>
      {isUuid(id) ? (
        <TripDetails key={id} id={id.toLowerCase()} />
      ) : (
        <>
          <PageHeading eyebrow="ДЕТАЛИ ПОЕЗДКИ" title="Рейс недоступен">
            Проверьте ссылку или найдите другую поездку.
          </PageHeading>
          <Notice title="Некорректная ссылка на рейс" error>
            Вернитесь к поиску и выберите рейс из результатов.
          </Notice>
        </>
      )}
    </div>
  )
}
