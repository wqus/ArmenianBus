import { useState } from 'react'
import { useParams, useSearchParams } from 'react-router'
import { Button, ButtonLink, Field, Notice, Loading, PageHeading } from '../shared/ui'
import { readDetails, statusLabels, type BookingDetails } from '../features/bookings/booking'
import { BookingFinancials } from '../features/bookings/BookingFinancials'
import { bookingFilterParams } from '../features/bookings/filters'
import { carrierBookingParams } from '../features/carrier/paths'
import { carrierError, readPage, routeLabels } from '../features/carrier/contracts'
import { useCarrierRead } from '../features/carrier/hooks'
import { Pager } from '../features/carrier/CarrierUI'
import { isUuid } from '../features/trips/trip'
import { departureDate, departureTime, formatPrice } from '../features/search/search'

function BookingInfo({ booking: b }: { booking: BookingDetails }) {
  return (
    <>
      <p>
        {b.origin} → {b.destination}
      </p>
      <p>
        {departureDate.format(new Date(b.departure_at))} ·{' '}
        {departureTime.format(new Date(b.departure_at))} UTC · Место {b.seat_number}
      </p>
      <p>
        <strong>{statusLabels[b.status]}</strong> · {formatPrice(b.amount)}
      </p>
      <p>Рейс: {routeLabels[b.route_status]}</p>
      <BookingFinancials booking={b} />
    </>
  )
}

function RouteFilter({ value, apply }: { value: string; apply: (value: string) => void }) {
  const [draft, setDraft] = useState(value)
  const [error, setError] = useState('')
  return (
    <form
      className="carrier-form"
      onSubmit={(event) => {
        event.preventDefault()
        const id = draft.trim()
        if (id && !isUuid(id)) {
          setError('Укажите полный идентификатор рейса или очистите поле.')
          return
        }
        setError('')
        apply(id)
      }}
    >
      <Field
        label="Идентификатор рейса"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        error={error}
        hint="Скопируйте идентификатор из карточки рейса или оставьте поле пустым."
      />
      <Button type="submit" variant="secondary">
        Применить рейс
      </Button>
    </form>
  )
}

export function CarrierBookingsPage() {
  const [params, setParams] = useSearchParams()
  const filters = carrierBookingParams(params)
  const offset = filters?.offset ?? 0
  const api = new URLSearchParams({
    limit: '21',
    offset: String(offset),
    segment: filters?.segment ?? 'all',
  })
  if (filters?.status) api.set('status', filters.status)
  if (filters?.routeId) api.set('route_id', filters.routeId)
  const query = useCarrierRead(
    `/carriers/me/bookings?${api}`,
    (v) => readPage(v, offset, readDetails),
    !!filters,
  )
  function change(patch: Partial<NonNullable<typeof filters>>) {
    if (!filters) return
    const next = { ...filters, offset: 0, ...patch }
    const clean = bookingFilterParams(next)
    if (next.routeId) clean.set('route_id', next.routeId)
    setParams(clean)
  }
  return (
    <>
      <PageHeading eyebrow="БРОНИРОВАНИЯ" title="Пассажиры ваших рейсов">
        Статусы мест, оплаты и возвратов. Отдельные брони доступны для просмотра.
      </PageHeading>
      {!filters ? (
        <>
          <Notice title="Проверьте фильтры" error />
          <ButtonLink to="/carrier/bookings">Сбросить фильтры</ButtonLink>
        </>
      ) : (
        <>
          <div className="booking-filters">
            <div className="booking-segments" aria-label="Период бронирований">
              {(['all', 'upcoming', 'history'] as const).map((segment) => (
                <Button
                  key={segment}
                  variant="secondary"
                  aria-pressed={filters.segment === segment}
                  onClick={() => change({ segment })}
                >
                  {{ all: 'Все', upcoming: 'Предстоящие', history: 'История' }[segment]}
                </Button>
              ))}
            </div>
            <div className="booking-status-filter">
              <label htmlFor="carrier-booking-status">Статус брони</label>
              <select
                id="carrier-booking-status"
                value={filters.status}
                onChange={(e) => change({ status: e.target.value as typeof filters.status })}
              >
                <option value="">Все статусы</option>
                {Object.entries(statusLabels).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <RouteFilter
            key={filters.routeId}
            value={filters.routeId}
            apply={(routeId) => change({ routeId })}
          />
          <Button variant="secondary" busy={query.isFetching} onClick={() => void query.refetch()}>
            Обновить бронирования
          </Button>
          {query.isPending ? (
            <Loading title="Загружаем бронирования…" />
          ) : query.isError ? (
            <Notice title="Не удалось загрузить бронирования" error>
              {carrierError(query.error)}
            </Notice>
          ) : (
            <>
              {query.data.items.length === 0 && (
                <Notice title="Бронирований на этой странице нет" />
              )}
              <div className="booking-list">
                {query.data.items.map((b) => (
                  <article className="booking-panel" key={b.id}>
                    <h2>Место {b.seat_number}</h2>
                    <BookingInfo booking={b} />
                    <ButtonLink to={`/carrier/bookings/${b.id}`} secondary>
                      Открыть бронь
                    </ButtonLink>
                  </article>
                ))}
              </div>
              <Pager
                offset={offset}
                next={query.data.next}
                change={(offset) => change({ offset })}
              />
            </>
          )}
        </>
      )}
    </>
  )
}

function BookingContent({ id }: { id: string }) {
  const query = useCarrierRead(`/carriers/me/bookings/${id}`, (v) => {
    const b = readDetails(v)
    if (b.id !== id) throw new Error('Unexpected booking')
    return b
  })
  return (
    <>
      <PageHeading eyebrow="БРОНИРОВАНИЯ" title="Бронь на ваш рейс">
        Данные доступны только перевозчику этого рейса.
      </PageHeading>
      <Button variant="secondary" busy={query.isFetching} onClick={() => void query.refetch()}>
        Обновить бронь
      </Button>
      {query.isPending ? (
        <Loading title="Загружаем бронь…" />
      ) : query.isError ? (
        <Notice title="Не удалось проверить бронь" error>
          {carrierError(query.error)}
        </Notice>
      ) : (
        <section className="booking-panel">
          <p className="booking-reference">Номер брони: {query.data.id}</p>
          <BookingInfo booking={query.data} />
          <ButtonLink to={`/carrier/routes/${query.data.route_id}`} secondary>
            Открыть рейс
          </ButtonLink>
        </section>
      )}
      <div className="page-back">
        <ButtonLink to="/carrier/bookings" secondary>
          Все бронирования
        </ButtonLink>
      </div>
    </>
  )
}
export function CarrierBookingPage() {
  const { id } = useParams()
  return isUuid(id) ? (
    <BookingContent key={id} id={id.toLowerCase()} />
  ) : (
    <Notice title="Некорректный номер брони" error />
  )
}
