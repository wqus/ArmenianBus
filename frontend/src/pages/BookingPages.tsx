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
import { BookingFinancials } from '../features/bookings/BookingFinancials'
import {
  bookingFilterParams,
  defaultBookingFilters,
  readBookingFilters,
} from '../features/bookings/filters'
import type { BookingFilters } from '../features/bookings/filters'
import { departureDate, departureTime, formatPrice } from '../features/search/search'
import { ApiError } from '../shared/api/client'
import { Button, ButtonLink, Notice, Loading, PageHeading } from '../shared/ui'

function useInvalidateAvailability() {
  const client = useQueryClient()
  return () => {
    void client.invalidateQueries({ queryKey: ['public-trip'] })
    void client.invalidateQueries({ queryKey: ['public-routes'] })
    void client.invalidateQueries({ queryKey: ['bookings'] })
    void client.invalidateQueries({ queryKey: ['payment'] })
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
      <div>
        <dt>Состояние рейса</dt>
        <dd>
          {
            {
              DRAFT: 'Не опубликован',
              ACTIVE: 'Запланирован',
              DEPARTED: 'В пути',
              COMPLETED: 'Завершён',
              CANCELLED: 'Отменён',
            }[booking.route_status]
          }
        </dd>
      </div>
      <div>
        <dt>Бронь создана · UTC</dt>
        <dd>
          {departureDate.format(new Date(booking.created_at))} ·{' '}
          {departureTime.format(new Date(booking.created_at))}
        </dd>
      </div>
    </dl>
  )
}

function BookingContent({ id }: { id: string }) {
  const { session, user } = useSession()
  const invalidate = useInvalidateAvailability()
  const [busy, setBusy] = useState(false)
  const pending = useRef(false)
  const [confirm, setConfirm] = useState<'HELD' | 'PAID' | null>(null)
  const [error, setError] = useState('')
  const query = useQuery({
    queryKey: ['booking', user?.id, id],
    queryFn: ({ signal }) => loadBooking(session, id, signal),
    staleTime: 0,
    networkMode: 'always',
    refetchOnWindowFocus: 'always',
    refetchInterval: (query) =>
      !query.state.error &&
      (['HELD', 'PAID'].includes(query.state.data?.booking.status ?? '') ||
        query.state.data?.booking.refund_status === 'OPEN')
        ? 15_000
        : false,
  })
  const value = query.data
  async function cancel() {
    if (
      pending.current ||
      !confirm ||
      value?.booking.status !== confirm ||
      !value.booking.cancellation_allowed ||
      query.isFetching ||
      query.isError
    )
      return
    pending.current = true
    setBusy(true)
    setError('')
    try {
      await session.request(`/bookings/${id}${confirm === 'HELD' ? '?hold_only=true' : ''}`, {
        method: 'DELETE',
      })
    } catch (error) {
      setError(`${bookingError(error)} Проверьте текущий статус перед повторной отменой.`)
    } finally {
      setConfirm(null)
      invalidate()
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
        <Loading title="Загружаем бронирование…" />
      ) : (
        <section className="booking-panel">
          <div role="status">
            <h2>{statusLabels[value.booking.status]}</h2>
          </div>
          <BookingInfo booking={value.booking} />
          <BookingFinancials booking={value.booking} />
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
          {(value.booking.status === 'HELD' || value.booking.status === 'PAID') &&
            value.booking.cancellation_allowed &&
            (confirm === value.booking.status ? (
              <div className="cancel-confirm">
                <p>
                  {confirm === 'PAID'
                    ? 'Отменить оплаченную бронь? Место освободится, а сервис создаст заявку на ручной возврат. Отмена не означает, что деньги уже возвращены.'
                    : 'Отменить удержание? Место станет доступно другим пассажирам.'}
                </p>
                <div className="booking-actions">
                  <Button busy={busy} disabled={query.isFetching} onClick={() => void cancel()}>
                    {confirm === 'PAID' ? 'Да, отменить оплаченную бронь' : 'Да, освободить место'}
                  </Button>
                  <Button variant="secondary" disabled={busy} onClick={() => setConfirm(null)}>
                    Сохранить бронь
                  </Button>
                </div>
              </div>
            ) : (
              <Button
                variant="secondary"
                disabled={query.isFetching || busy}
                onClick={() => setConfirm(value.booking.status as 'HELD' | 'PAID')}
              >
                {value.booking.status === 'PAID'
                  ? 'Отменить оплаченную бронь'
                  : 'Отменить удержание'}
              </Button>
            ))}
          {value.booking.status === 'PAID' && !value.booking.cancellation_allowed && (
            <Notice title="Отмена оплаченной брони недоступна">
              Сервер учитывает срок до отправления и состояние рейса. Если нужна помощь, обратитесь
              в поддержку с номером брони.
            </Notice>
          )}
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
  const parsed = readBookingFilters(params)
  const filters = parsed ?? defaultBookingFilters
  const { segment, status, offset } = filters
  function changeFilters(changes: Partial<BookingFilters>) {
    setParams(bookingFilterParams({ ...filters, offset: 0, ...changes }))
  }
  const query = useQuery({
    queryKey: ['bookings', user?.id, segment, status, offset],
    enabled: parsed !== null,
    queryFn: async ({ signal }) => {
      const search = new URLSearchParams({ limit: '21', offset: String(offset), segment })
      if (status) search.set('status', status)
      const data = await session.request<{ items: unknown[]; limit: number; offset: number }>(
        `/cabinet/bookings?${search}`,
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
      const items = data.items.map(readDetails)
      if (
        new Set(items.map((item) => item.id)).size !== items.length ||
        items.some((item) => status && item.status !== status)
      )
        throw new Error('Invalid booking list')
      return { items: items.slice(0, 20), next: items.length > 20 }
    },
    staleTime: 0,
    networkMode: 'always',
    refetchOnWindowFocus: 'always',
  })
  if (!parsed)
    return (
      <div className="container information-page">
        <PageHeading eyebrow="ЛИЧНЫЙ КАБИНЕТ" title="Проверьте фильтры">
          Параметры списка некорректны. Откройте все бронирования и выберите фильтры заново.
        </PageHeading>
        <Button onClick={() => setParams({})}>Все бронирования</Button>
      </div>
    )
  return (
    <div className="container information-page">
      <PageHeading eyebrow="ЛИЧНЫЙ КАБИНЕТ" title="Мои бронирования">
        Предстоящие поездки, история и состояние оплаты. Последние бронирования — в начале списка.
      </PageHeading>
      <section className="booking-filters" aria-label="Фильтры бронирований">
        <div className="booking-segments" role="group" aria-label="Период поездок">
          {(
            [
              ['all', 'Все'],
              ['upcoming', 'Предстоящие'],
              ['history', 'История'],
            ] as const
          ).map(([value, label]) => (
            <Button
              key={value}
              variant={segment === value ? 'primary' : 'secondary'}
              aria-pressed={segment === value}
              onClick={() => changeFilters({ segment: value })}
            >
              {label}
            </Button>
          ))}
        </div>
        <div className="booking-status-filter">
          <label htmlFor="booking-status">Статус брони</label>
          <select
            id="booking-status"
            value={status}
            onChange={(event) =>
              changeFilters({ status: event.target.value as BookingFilters['status'] })
            }
          >
            <option value="">Все статусы</option>
            {Object.entries(statusLabels).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>
        <p className="seat-help">
          Предстоящие — действующие удержания и оплаченные брони на будущие рейсы. Остальные записи
          находятся в истории.
        </p>
      </section>
      <div className="booking-actions">
        <Button variant="secondary" busy={query.isFetching} onClick={() => void query.refetch()}>
          Обновить бронирования
        </Button>
        <ButtonLink secondary to="/search">
          Найти рейс
        </ButtonLink>
        <ButtonLink secondary to="/account">
          Мой профиль
        </ButtonLink>
      </div>
      {query.isFetching ? (
        <Loading title="Проверяем бронирования…" />
      ) : query.isError ? (
        <Notice title="Не удалось загрузить бронирования" error>
          {bookingError(query.error)}
        </Notice>
      ) : (
        query.data && (
          <>
            {!query.data.items.length && (
              <Notice title="Бронирований на этой странице нет">
                Измените фильтры или обновите список, если только что создали бронь.
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
                    {departureTime.format(new Date(booking.departure_at))} UTC ·{' '}
                    {booking.company_name}
                  </p>
                  <p>
                    {statusLabels[booking.status]} · {formatPrice(booking.amount)}
                  </p>
                  <BookingFinancials booking={booking} />
                  <ButtonLink to={`/bookings/${booking.id}`}>Открыть бронь</ButtonLink>
                </article>
              ))}
            </div>
            <nav className="search-pagination" aria-label="Страницы бронирований">
              {offset > 0 && (
                <Button variant="secondary" onClick={() => changeFilters({ offset: offset - 20 })}>
                  Предыдущая страница
                </Button>
              )}
              {(offset > 0 || query.data.next) && <span>Страница {offset / 20 + 1}</span>}
              {query.data.next && offset < 10_000 && (
                <Button variant="secondary" onClick={() => changeFilters({ offset: offset + 20 })}>
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
