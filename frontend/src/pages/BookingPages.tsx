import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate, useParams, useSearchParams } from 'react-router'
import { useSession } from '../features/auth/context'
import { getTrip, isUuid, tripError } from '../features/trips/trip'
import {
  bookingError,
  loadBooking,
  readBooking,
  readDetails,
  remainingSeconds,
  statusLabels,
} from '../features/bookings/booking'
import type { BookingDetails, TimedBooking } from '../features/bookings/booking'
import { departureDate, departureTime, formatPrice } from '../features/search/search'
import { ApiError } from '../shared/api/client'
import { Button, ButtonLink, Notice, PageHeading } from '../shared/ui'

function useInvalidateAvailability() {
  const client = useQueryClient()
  return () => {
    void client.invalidateQueries({ queryKey: ['public-trip'] })
    void client.invalidateQueries({ queryKey: ['public-routes'] })
    void client.invalidateQueries({ queryKey: ['bookings'] })
  }
}

function CreateBooking({ routeId, seatId }: { routeId: string; seatId: string }) {
  const { session } = useSession()
  const navigate = useNavigate()
  const invalidate = useInvalidateAvailability()
  const pending = useRef(false)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const [state, setState] = useState<'idle' | 'sending' | 'conflict' | 'uncertain' | 'rejected'>(
    'idle',
  )
  const [message, setMessage] = useState('')
  const query = useQuery({
    queryKey: ['public-trip', routeId],
    queryFn: ({ signal }) => getTrip(routeId, signal),
    staleTime: 0,
    networkMode: 'always',
    enabled: state === 'idle',
  })
  const trip = query.data
  const seat = trip?.seats.find((seat) => seat.id === seatId)
  async function create() {
    if (
      pending.current ||
      state !== 'idle' ||
      query.isFetching ||
      query.isError ||
      seat?.status !== 'FREE'
    )
      return
    pending.current = true
    setState('sending')
    try {
      const booking = readBooking(
        await session.request('/bookings', {
          method: 'POST',
          body: JSON.stringify({ route_id: routeId, seat_id: seatId }),
        }),
      )
      if (
        booking.route_id !== routeId ||
        booking.seat_id !== seatId ||
        booking.bus_id !== trip?.route.bus_id
      )
        throw new Error('Unexpected booking')
      invalidate()
      if (!mounted.current) return
      navigate(`/bookings/${booking.id}`, { replace: true })
    } catch (error) {
      invalidate()
      if (!mounted.current) return
      if (error instanceof ApiError && error.problem.code === 'BOOKING_CONFLICT') {
        setState('conflict')
        setMessage(
          'Это место уже удерживается или оплачено. Выберите другое место. Если вы бронировали его ранее, проверьте свои брони.',
        )
      } else if (
        error instanceof ApiError &&
        [401, 403, 404, 409, 422, 429].includes(error.status)
      ) {
        setState('rejected')
        setMessage(
          error.status === 404 || error.status === 409
            ? 'Рейс или место больше недоступны. Вернитесь к выбору места.'
            : bookingError(error),
        )
      } else {
        setState('uncertain')
        setMessage(
          'Ответ не получен, но бронь могла сохраниться. Проверьте свои бронирования перед новой попыткой.',
        )
      }
    } finally {
      pending.current = false
    }
  }
  return (
    <>
      <PageHeading eyebrow="БРОНИРОВАНИЕ" title="Подтвердите выбор">
        После подтверждения место будет временно закреплено за вами. Срок покажем по данным сервера.
      </PageHeading>
      {state !== 'idle' && state !== 'sending' ? (
        <Notice
          title={state === 'uncertain' ? 'Результат нужно проверить' : 'Не удалось удержать место'}
          error
        >
          {message}
        </Notice>
      ) : query.isError ? (
        <Notice title="Не удалось проверить рейс" error>
          {tripError(query.error)}
        </Notice>
      ) : !trip ? (
        <Notice title="Проверяем рейс…" />
      ) : (
        <section className="booking-panel">
          <h2>
            {trip.route.origin} → {trip.route.destination}
          </h2>
          <p>
            {departureDate.format(new Date(trip.route.departure_at))} ·{' '}
            {departureTime.format(new Date(trip.route.departure_at))} UTC
          </p>
          <p>{trip.route.company_name}</p>
          {seat?.status === 'FREE' ? (
            <>
              <p className="booking-amount">
                Место {seat.seat_number} · {formatPrice(trip.route.price)}
              </p>
              <Button
                busy={state === 'sending'}
                disabled={query.isFetching}
                onClick={() => void create()}
              >
                Удержать место
              </Button>
              <p className="seat-help">Это временное удержание. Оплата ещё не выполнена.</p>
            </>
          ) : (
            <Notice title="Место больше недоступно">
              Вернитесь к рейсу и выберите свободное место.
            </Notice>
          )}
        </section>
      )}
      <div className="booking-actions">
        <ButtonLink secondary to={`/trips/${routeId}`}>
          Вернуться к рейсу
        </ButtonLink>
        <ButtonLink secondary to="/bookings">
          Мои бронирования
        </ButtonLink>
      </div>
    </>
  )
}

export function CreateBookingPage() {
  const { id = '' } = useParams()
  const [params] = useSearchParams()
  const seat = params.get('seat')
  return (
    <div className="container information-page">
      {isUuid(id) && isUuid(seat) && params.getAll('seat').length === 1 ? (
        <CreateBooking
          key={`${id}:${seat}`}
          routeId={id.toLowerCase()}
          seatId={seat.toLowerCase()}
        />
      ) : (
        <>
          <PageHeading eyebrow="БРОНИРОВАНИЕ" title="Проверьте выбранное место">
            Откройте рейс из поиска и выберите место заново.
          </PageHeading>
          <ButtonLink to="/search">Найти рейс</ButtonLink>
        </>
      )}
    </div>
  )
}

function HoldTimer({ value }: { value: TimedBooking }) {
  const [now, setNow] = useState(() => performance.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(performance.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  const seconds = remainingSeconds(value, now)
  return (
    <div className="hold-timer">
      <span>До окончания удержания</span>
      <strong role="timer" aria-live="off">
        {String(Math.floor(seconds / 60)).padStart(2, '0')}:{String(seconds % 60).padStart(2, '0')}
      </strong>
      <p>
        {seconds
          ? 'Место временно закреплено за вами. Оно ещё не оплачено.'
          : 'Проверяем срок удержания на сервере. Обновите статус при необходимости.'}
      </p>
    </div>
  )
}

function BookingInfo({ booking }: { booking: BookingDetails }) {
  return (
    <dl className="booking-info">
      <div>
        <dt>Направление</dt>
        <dd>
          {booking.origin} → {booking.destination}
        </dd>
      </div>
      <div>
        <dt>Отправление · UTC</dt>
        <dd>
          {departureDate.format(new Date(booking.departure_at))} ·{' '}
          {departureTime.format(new Date(booking.departure_at))}
        </dd>
      </div>
      <div>
        <dt>Место</dt>
        <dd>{booking.seat_number}</dd>
      </div>
      <div>
        <dt>Перевозчик</dt>
        <dd>{booking.company_name}</dd>
      </div>
      <div>
        <dt>Стоимость брони</dt>
        <dd>{formatPrice(booking.amount)}</dd>
      </div>
    </dl>
  )
}

function BookingContent({ id }: { id: string }) {
  const { session, user } = useSession()
  const invalidate = useInvalidateAvailability()
  const [busy, setBusy] = useState(false)
  const pending = useRef(false)
  const [confirm, setConfirm] = useState(false)
  const [error, setError] = useState('')
  const query = useQuery({
    queryKey: ['booking', user?.id, id],
    queryFn: ({ signal }) => loadBooking(session, id, signal),
    staleTime: 0,
    networkMode: 'always',
    refetchOnWindowFocus: 'always',
    refetchInterval: (query) =>
      !query.state.error && query.state.data?.booking.status === 'HELD' ? 15_000 : false,
  })
  const value = query.data
  async function cancel() {
    if (pending.current || !confirm || value?.booking.status !== 'HELD') return
    pending.current = true
    setBusy(true)
    setError('')
    try {
      await session.request(`/bookings/${id}?hold_only=true`, { method: 'DELETE' })
      invalidate()
    } catch (error) {
      setError(`${bookingError(error)} Проверьте текущий статус перед повторной отменой.`)
    } finally {
      setConfirm(false)
      await query.refetch()
      setBusy(false)
      pending.current = false
    }
  }
  return (
    <>
      <PageHeading eyebrow="ВАША БРОНЬ" title="Бронирование">
        Состояние брони и срок удержания места.
      </PageHeading>
      <div className="booking-actions">
        <Button
          variant="secondary"
          busy={query.isFetching}
          disabled={busy}
          onClick={() => void query.refetch()}
        >
          Обновить статус
        </Button>
        <ButtonLink secondary to="/bookings">
          Мои бронирования
        </ButtonLink>
      </div>
      {query.isError ? (
        <Notice title="Не удалось проверить бронь" error>
          {bookingError(query.error)}
        </Notice>
      ) : !value ? (
        <Notice title="Загружаем бронирование…" />
      ) : (
        <section className="booking-panel">
          <div role="status">
            <h2>{statusLabels[value.booking.status]}</h2>
          </div>
          <BookingInfo booking={value.booking} />
          {value.booking.status === 'HELD' && <HoldTimer value={value} />}
          <div className="booking-actions">
            <ButtonLink to={`/bookings/${id}/payment`}>
              {value.booking.status === 'HELD' ? 'Перейти к оплате' : 'Проверить оплату'}
            </ButtonLink>
          </div>
          {value.booking.status === 'EXPIRED' && (
            <Notice title="Место больше не удерживается">
              Для новой поездки выберите свободное место заново.
            </Notice>
          )}
          {value.booking.status === 'HELD' &&
            value.booking.cancellation_allowed &&
            (confirm ? (
              <div className="cancel-confirm">
                <p>Отменить удержание? Место станет доступно другим пассажирам.</p>
                <div className="booking-actions">
                  <Button busy={busy} disabled={query.isFetching} onClick={() => void cancel()}>
                    Да, освободить место
                  </Button>
                  <Button variant="secondary" disabled={busy} onClick={() => setConfirm(false)}>
                    Сохранить бронь
                  </Button>
                </div>
              </div>
            ) : (
              <Button
                variant="secondary"
                disabled={query.isFetching || busy}
                onClick={() => setConfirm(true)}
              >
                Отменить удержание
              </Button>
            ))}
          {error && (
            <Notice title="Результат отмены" error>
              {error}
            </Notice>
          )}
          <p className="booking-reference">Номер брони: {value.booking.id}</p>
          <ButtonLink secondary to={`/trips/${value.booking.route_id}`}>
            Открыть рейс
          </ButtonLink>
        </section>
      )}
    </>
  )
}

export function BookingPage() {
  const { id = '' } = useParams()
  return (
    <div className="container information-page">
      {isUuid(id) ? (
        <BookingContent key={id} id={id.toLowerCase()} />
      ) : (
        <>
          <PageHeading eyebrow="ВАША БРОНЬ" title="Бронь недоступна">
            Проверьте ссылку или откройте список бронирований.
          </PageHeading>
          <ButtonLink to="/bookings">Мои бронирования</ButtonLink>
        </>
      )}
    </div>
  )
}

export function BookingsPage() {
  const { session, user } = useSession()
  const [params, setParams] = useSearchParams()
  const raw = Number(params.get('offset') ?? 0)
  const offset = Number.isInteger(raw) && raw >= 0 && raw <= 10_000 && raw % 20 === 0 ? raw : 0
  const query = useQuery({
    queryKey: ['bookings', user?.id, offset],
    queryFn: async ({ signal }) => {
      const data = await session.request<{ items: unknown[]; limit: number; offset: number }>(
        `/cabinet/bookings?limit=21&offset=${offset}`,
        { signal },
      )
      if (
        !data ||
        !Array.isArray(data.items) ||
        data.items.length > 21 ||
        data.offset !== offset ||
        data.limit !== 21
      )
        throw new Error('Invalid booking list')
      return { items: data.items.slice(0, 20).map(readDetails), next: data.items.length > 20 }
    },
    staleTime: 0,
    networkMode: 'always',
    refetchOnWindowFocus: 'always',
  })
  return (
    <div className="container information-page">
      <PageHeading eyebrow="ПАССАЖИРУ" title="Мои бронирования">
        Последние бронирования — в начале списка. Здесь можно проверить результат, если ответ при
        создании не пришёл.
      </PageHeading>
      <div className="booking-actions">
        <Button variant="secondary" busy={query.isFetching} onClick={() => void query.refetch()}>
          Обновить бронирования
        </Button>
        <ButtonLink secondary to="/search">
          Найти рейс
        </ButtonLink>
      </div>
      {query.isFetching ? (
        <Notice title="Проверяем бронирования…" />
      ) : query.isError ? (
        <Notice title="Не удалось загрузить бронирования" error>
          {bookingError(query.error)}
        </Notice>
      ) : (
        query.data && (
          <>
            {!query.data.items.length && (
              <Notice title="Бронирований на этой странице нет">
                Если вы только что отправили запрос, обновите список через несколько секунд.
              </Notice>
            )}
            <div className="booking-list">
              {query.data.items.map((booking) => (
                <article className="booking-panel" key={booking.id}>
                  <h2>
                    {booking.origin} → {booking.destination}
                  </h2>
                  <p>
                    {departureDate.format(new Date(booking.departure_at))} · Место{' '}
                    {booking.seat_number}
                  </p>
                  <p>
                    {statusLabels[booking.status]} · {formatPrice(booking.amount)}
                  </p>
                  <ButtonLink to={`/bookings/${booking.id}`}>Открыть бронь</ButtonLink>
                </article>
              ))}
            </div>
            <nav className="search-pagination" aria-label="Страницы бронирований">
              {offset > 0 && (
                <Button
                  variant="secondary"
                  onClick={() => setParams({ offset: String(offset - 20) })}
                >
                  Предыдущая страница
                </Button>
              )}
              {(offset > 0 || query.data.next) && <span>Страница {offset / 20 + 1}</span>}
              {query.data.next && offset < 10_000 && (
                <Button
                  variant="secondary"
                  onClick={() => setParams({ offset: String(offset + 20) })}
                >
                  Следующая страница
                </Button>
              )}
            </nav>
          </>
        )
      )}
    </div>
  )
}
