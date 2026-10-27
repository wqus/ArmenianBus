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
import { PassengerInfo } from '../features/bookings/PassengerInfo'
import { PaidConfirmation } from '../features/bookings/PaidConfirmation'
import { formatDeparture } from '../features/trips/departure'
import { BoardingDetails } from '../features/trips/BoardingDetails'
import { emptyPassenger, normalizePassenger, passengerErrors } from '../features/bookings/passenger'
import { JourneySummary, BookingSupport } from '../features/bookings/JourneySummary'
import { bookingGuidance, hasPaidConfirmation } from '../features/bookings/guidance'
import '../features/bookings/passenger.css'
import {
  bookingFilterParams,
  defaultBookingFilters,
  readBookingFilters,
} from '../features/bookings/filters'
import type { BookingFilters } from '../features/bookings/filters'
import { departureDate, departureTime, formatPrice } from '../features/search/search'
import { ApiError } from '../shared/api/client'
import { Button, ButtonLink, Field, Notice, Loading, PageHeading } from '../shared/ui'

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
  const [passenger, setPassenger] = useState(emptyPassenger)
  const [errors, setErrors] = useState<ReturnType<typeof passengerErrors>>({})
  const form = useRef<HTMLFormElement>(null)
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
    const invalid = passengerErrors(passenger)
    setErrors(invalid)
    if (Object.keys(invalid).length) {
      form.current
        ?.querySelector<HTMLInputElement>('[name="' + Object.keys(invalid)[0] + '"]')
        ?.focus()
      return
    }
    pending.current = true
    setState('sending')
    try {
      const booking = readBooking(
        await session.request('/bookings', {
          method: 'POST',
          body: JSON.stringify({
            route_id: routeId,
            seat_id: seatId,
            ...normalizePassenger(passenger),
          }),
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
        <div className="passenger-checkout">
          <JourneySummary
            journey={{ ...trip.route, amount: trip.route.price, seat_number: seat?.seat_number }}
          />
          <section className="booking-panel checkout-action">
            <h2>Проверьте выбор</h2>
            <p>
              После подтверждения начнётся временное удержание. Деньги на этом шаге не списываются.
            </p>
            {seat?.status === 'FREE' ? (
              <>
                <p className="booking-amount">Место {seat.seat_number}</p>
                <form
                  ref={form}
                  className="passenger-form"
                  noValidate
                  onSubmit={(event) => {
                    event.preventDefault()
                    void create()
                  }}
                >
                  <fieldset disabled={state === 'sending'}>
                    <legend>Кто поедет</legend>
                    <p className="seat-help">
                      Укажите данные человека, который поедет, даже если оформляете бронь для
                      другого. Телефон нужен для связи по поездке.
                    </p>
                    {(
                      [
                        ['passenger_first_name', 'Имя пассажира', 'given-name'],
                        ['passenger_last_name', 'Фамилия пассажира', 'family-name'],
                        ['passenger_phone', 'Телефон пассажира', 'tel'],
                      ] as const
                    ).map(([key, label, autoComplete]) => (
                      <Field
                        key={key}
                        name={key}
                        label={label}
                        autoComplete={autoComplete}
                        type={key === 'passenger_phone' ? 'tel' : 'text'}
                        required
                        maxLength={key === 'passenger_phone' ? 40 : 100}
                        value={passenger[key]}
                        error={errors[key]}
                        hint={
                          key === 'passenger_phone'
                            ? 'С кодом страны, например +374… или +7…'
                            : undefined
                        }
                        onChange={(event) => {
                          setPassenger({ ...passenger, [key]: event.target.value })
                          setErrors((current) => ({ ...current, [key]: undefined }))
                        }}
                      />
                    ))}
                  </fieldset>
                  <Button type="submit" busy={state === 'sending'} disabled={query.isFetching}>
                    Удержать место
                  </Button>
                </form>
                <p className="seat-help">Это временное удержание. Оплата ещё не выполнена.</p>
              </>
            ) : (
              <Notice title="Место больше недоступно">
                Вернитесь к рейсу и выберите свободное место.
              </Notice>
            )}
          </section>
        </div>
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
    <div className="container information-page passenger-page">
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

function HoldTimer({ value, now }: { value: TimedBooking; now: number }) {
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
        <dt>Отправление · время города отправления</dt>
        <dd>
          {formatDeparture(booking).date} · {formatDeparture(booking).time}{' '}
          {formatDeparture(booking).offset}
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
  const [printing, setPrinting] = useState(false)
  const printingPending = useRef(false)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
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
  async function printConfirmation() {
    if (printingPending.current || busy || query.isFetching || query.isError) return
    printingPending.current = true
    setPrinting(true)
    setError('')
    try {
      const fresh = await query.refetch()
      if (!mounted.current) return
      if (fresh.isError || !fresh.data || !hasPaidConfirmation(fresh.data.booking)) {
        setError('Не удалось подтвердить действующую оплаченную бронь. Проверьте её статус.')
        return
      }
      // Wait for the refreshed confirmation to be committed to the DOM before printing.
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      )
      if (mounted.current && document.querySelector('.paid-confirmation')) window.print()
    } finally {
      printingPending.current = false
      if (mounted.current) setPrinting(false)
    }
  }
  const [now, setNow] = useState(() => performance.now())
  useEffect(() => {
    if (value?.booking.status !== 'HELD') return
    const timer = window.setInterval(() => setNow(performance.now()), 1000)
    return () => clearInterval(timer)
  }, [value?.booking.status])
  const canPay =
    value?.booking.status === 'HELD' &&
    remainingSeconds(value, now) > 0 &&
    !value.booking.refund_status &&
    value.booking.route_status === 'ACTIVE' &&
    (value.booking.payment_status === null || value.booking.payment_status === 'PENDING')
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
        <div className="booking-detail-layout">
          <div role="status" className="passenger-status" data-status={value.booking.status}>
            <p className="journey-caption">Статус брони</p>
            <h2>{statusLabels[value.booking.status]}</h2>
            <p>{bookingGuidance(value.booking)}</p>
            <p className="booking-route-caption">
              {value.booking.origin} → {value.booking.destination} · Место{' '}
              {value.booking.seat_number}
            </p>
          </div>
          <section className="booking-panel booking-detail">
            <BookingInfo booking={value.booking} />
            <BoardingDetails journey={value.booking} />
            <PassengerInfo passenger={value.booking} />
            <BookingFinancials booking={value.booking} />
            {hasPaidConfirmation(value.booking) && !query.isFetching && (
              <PaidConfirmation booking={value.booking} />
            )}
          </section>
          <aside className="booking-panel checkout-action" aria-labelledby="booking-actions-title">
            <h2 id="booking-actions-title">Что дальше</h2>
            {hasPaidConfirmation(value.booking) && (
              <Button
                variant="secondary"
                busy={printing}
                disabled={busy || query.isFetching}
                onClick={() => void printConfirmation()}
              >
                Распечатать / сохранить PDF
              </Button>
            )}
            <p className="checkout-amount">
              {formatPrice(value.booking.amount)}
              <span>за одного пассажира</span>
            </p>
            {value.booking.status === 'HELD' && <HoldTimer value={value} now={now} />}
            <div className="booking-actions">
              {canPay && !query.isFetching && !busy ? (
                <ButtonLink to={`/bookings/${id}/payment`}>
                  {value.booking.payment_status === 'PENDING'
                    ? 'Открыть платёж'
                    : 'Перейти к оплате'}
                </ButtonLink>
              ) : (
                <ButtonLink secondary to={`/bookings/${id}/payment`}>
                  Проверить оплату
                </ButtonLink>
              )}
            </div>
            {value.booking.status === 'HELD' && !canPay && (
              <p className="seat-help">
                Перед оплатой проверьте результат и срок удержания. Новый платёж на этой странице не
                создаётся.
              </p>
            )}
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
                      {confirm === 'PAID'
                        ? 'Да, отменить оплаченную бронь'
                        : 'Да, освободить место'}
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
                Сервер учитывает срок до отправления и состояние рейса. Если нужна помощь,
                обратитесь в поддержку с номером брони.
              </Notice>
            )}
            {error && (
              <Notice title="Результат отмены" error>
                {error}
              </Notice>
            )}
            <BookingSupport id={value.booking.id} />
            <ButtonLink secondary to={`/trips/${value.booking.route_id}`}>
              Открыть рейс
            </ButtonLink>
          </aside>
        </div>
      )}
    </>
  )
}

export function BookingPage() {
  const { id = '' } = useParams()
  return (
    <div className="container information-page passenger-page">
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
    <div className="container information-page passenger-page booking-cabinet">
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
                <article className="booking-panel booking-row" key={booking.id}>
                  <div className="booking-row-main">
                    <span className="booking-status-label" data-status={booking.status}>
                      {statusLabels[booking.status]}
                    </span>
                    <h2>
                      {booking.origin} → {booking.destination}
                    </h2>
                    <p>
                      {formatDeparture(booking).date} · Место {booking.seat_number}
                    </p>
                    <p>
                      {formatDeparture(booking).time} {formatDeparture(booking).offset} ·{' '}
                      {booking.company_name}
                    </p>
                    <BookingFinancials booking={booking} />
                  </div>
                  <div className="booking-row-action">
                    <strong className="booking-row-price">{formatPrice(booking.amount)}</strong>
                    <span>за одного пассажира</span>
                    <ButtonLink to={`/bookings/${booking.id}`}>Открыть бронь</ButtonLink>
                  </div>
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
