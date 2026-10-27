import { useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router'
import { useCarrierRead, useCarrierWrite } from '../features/carrier/hooks'
import {
  carrierError,
  exactPrice,
  readBus,
  readBusDetails,
  readOwnRoute,
  readPage,
  routeLabels,
} from '../features/carrier/contracts'
import type { OwnRoute, RouteStatus } from '../features/carrier/contracts'
import { carrierListParams } from '../features/carrier/paths'
import { Pager, WriteResult } from '../features/carrier/CarrierUI'
import { isUuid } from '../features/trips/trip'
import { CityInput } from '../features/cities/CityInput'
import { formatPrice } from '../features/search/search'
import { cityTimezone, cities } from '../features/cities/catalog'
import {
  formatDeparture,
  journeyZone,
  localInput,
  localDepartureIso,
  timezoneLabel,
} from '../features/trips/departure'
import { BoardingDetails } from '../features/trips/BoardingDetails'
import { Button, ButtonLink, Field, Notice, Loading, PageHeading } from '../shared/ui'

function RouteInfo({ route }: { route: OwnRoute }) {
  return (
    <>
      <p className="carrier-status" data-status={route.status}>
        {routeLabels[route.status]}
      </p>
      <h2>
        {route.origin} → {route.destination}
      </h2>
      <dl className="carrier-facts">
        <div>
          <dt>Отправление · время города отправления</dt>
          <dd>
            <time dateTime={route.departure_at}>
              {formatDeparture(route).date} · {formatDeparture(route).time}{' '}
              {formatDeparture(route).offset}
            </time>
          </dd>
        </div>
        <div>
          <dt>Цена билета</dt>
          <dd>{formatPrice(route.price)}</dd>
        </div>
      </dl>
      <BoardingDetails journey={route} />
    </>
  )
}
export function CarrierRoutesPage() {
  const [params, setParams] = useSearchParams()
  const filters = carrierListParams(params, 'routes')
  const offset = filters?.offset ?? 0
  const status = filters?.status ?? ''
  const query = useCarrierRead(
    `/routes/my?limit=21&offset=${offset}${status ? `&status=${status}` : ''}`,
    (v) => readPage(v, offset, readOwnRoute),
    filters !== null,
  )
  function change(status: string, offset: number) {
    const p = new URLSearchParams()
    if (status) p.set('status', status)
    if (offset) p.set('offset', String(offset))
    setParams(p)
  }
  return (
    <>
      <PageHeading eyebrow="ПЕРЕВОЗЧИКУ" title="Мои рейсы">
        Создайте черновик, проверьте данные и опубликуйте рейс.
      </PageHeading>
      <div className="booking-actions">
        <ButtonLink to="/carrier/routes/new">Создать рейс</ButtonLink>
        <Button
          variant="secondary"
          disabled={!filters}
          busy={query.isFetching}
          onClick={() => void query.refetch()}
        >
          Обновить рейсы
        </Button>
      </div>
      {!filters ? (
        <>
          <Notice title="Некорректные фильтры" />
          <Button onClick={() => setParams({})}>Открыть список</Button>
        </>
      ) : (
        <>
          <div className="booking-status-filter">
            <label htmlFor="route-status">Статус рейса</label>
            <select
              id="route-status"
              value={status}
              onChange={(event) => change(event.target.value, 0)}
            >
              <option value="">Все статусы</option>
              {Object.entries(routeLabels).map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </select>
          </div>
          {query.isError ? (
            <Notice title="Не удалось загрузить рейсы" error>
              {carrierError(query.error)}
            </Notice>
          ) : query.isFetching || !query.data ? (
            <Loading title="Загружаем рейсы…" />
          ) : (
            <>
              {!query.data.items.length && <Notice title="Рейсов на этой странице нет" />}
              <div className="booking-list carrier-records">
                {query.data.items.map((route) => (
                  <article className="booking-panel carrier-record" key={route.id}>
                    <div className="carrier-record-main">
                      <RouteInfo route={route} />
                    </div>
                    <ButtonLink to={`/carrier/routes/${route.id}`}>Управлять рейсом</ButtonLink>
                  </article>
                ))}
              </div>
              <Pager
                offset={offset}
                next={query.data.next}
                change={(offset) => change(status, offset)}
              />
            </>
          )}
        </>
      )}
    </>
  )
}

function RouteForm({ initial, selectedBus = '' }: { initial?: OwnRoute; selectedBus?: string }) {
  const [busId, setBusId] = useState(initial?.bus_id ?? selectedBus)
  const [offset, setOffset] = useState(0)
  const buses = useCarrierRead(`/buses?limit=21&offset=${offset}`, (v) =>
    readPage(v, offset, readBus),
  )
  const selected = useCarrierRead(
    `/buses/${busId}`,
    (v) => {
      const bus = readBusDetails(v)
      if (bus.id !== busId) throw new Error('Wrong bus')
      return bus
    },
    isUuid(busId),
  )
  const [direction, setDirection] = useState(initial?.origin_country ?? 'RU')
  const [origin, setOrigin] = useState(initial?.origin ?? '')
  const [destination, setDestination] = useState(initial?.destination ?? '')
  const [customZone, setCustomZone] = useState(initial ? journeyZone(initial) : '')
  const zone = cityTimezone(origin, direction) ?? (direction === 'AM' ? 'Asia/Yerevan' : customZone)
  const [departure, setDeparture] = useState(
    initial ? localInput(initial.departure_at, journeyZone(initial)) : '',
  )
  const [boarding, setBoarding] = useState(initial?.boarding_address ?? '')
  const [dropoff, setDropoff] = useState(initial?.dropoff_address ?? '')
  const [price, setPrice] = useState(initial?.price ?? '')
  const [error, setError] = useState('')
  const write = useCarrierWrite()
  const navigate = useNavigate()
  const disabled =
    write.busy || write.uncertain || selected.isFetching || !selected.data || selected.isError
  async function submit(event: React.SubmitEvent) {
    event.preventDefault()
    if (disabled) return
    const at = localDepartureIso(departure, zone)
    const amount = price.replace(',', '.')
    if (
      !at ||
      !origin.trim() ||
      !destination.trim() ||
      origin.trim().length > 200 ||
      destination.trim().length > 200 ||
      [boarding, dropoff].some(
        (address) =>
          address.trim().length < 5 || [...address.trim()].length > 500 || /\p{C}/u.test(address),
      ) ||
      !exactPrice(amount)
    ) {
      setError(
        'Проверьте города, адреса, часовой пояс, местное время и цену. Если время неоднозначно из-за перевода часов, выберите другое время.',
      )
      return
    }
    const fields = {
      bus_id: busId,
      origin_country: direction,
      destination_country: direction === 'RU' ? 'AM' : 'RU',
      origin: origin.trim(),
      destination: destination.trim(),
      departure_at:
        initial &&
        zone === journeyZone(initial) &&
        departure === localInput(initial.departure_at, zone)
          ? initial.departure_at
          : at,
      departure_timezone: zone,
      boarding_address: boarding.trim(),
      dropoff_address: dropoff.trim(),
      price: amount,
    }
    const body = initial
      ? Object.fromEntries(
          Object.entries(fields).filter(([key, value]) => value !== initial[key as keyof OwnRoute]),
        )
      : { ...fields, currency: 'RUB' }
    if (!Object.keys(body).length) {
      setError('Данные не изменены.')
      return
    }
    setError('')
    const result = await write.run(async () => {
      const route = readOwnRoute(
        await write.session.request(initial ? `/routes/${initial.id}` : '/routes', {
          method: initial ? 'PATCH' : 'POST',
          body: JSON.stringify(body),
        }),
      )
      if (initial && route.id !== initial.id) throw new Error('Wrong route')
      return route
    })
    if (result.ok) navigate(`/carrier/routes/${result.value.id}`, { replace: true })
  }
  return (
    <form className="carrier-form booking-panel" onSubmit={(event) => void submit(event)}>
      <fieldset className="carrier-form-section">
        <legend>1. Транспорт</legend>
        <div className="booking-status-filter">
          <label htmlFor="route-bus">Автобус</label>
          <select
            id="route-bus"
            value={busId}
            disabled={buses.isFetching || buses.isError || write.busy}
            onChange={(event) => setBusId(event.target.value)}
          >
            <option value="">Выберите автобус</option>
            {busId && !buses.data?.items.some((bus) => bus.id === busId) && (
              <option value={busId}>{selected.data?.name ?? 'Выбранный автобус'}</option>
            )}
            {!buses.isError &&
              buses.data?.items.map((bus) => (
                <option key={bus.id} value={bus.id}>
                  {bus.name} · {bus.capacity} мест
                </option>
              ))}
          </select>
        </div>
        {buses.isError && (
          <Notice title="Не удалось прочитать автопарк" error>
            {carrierError(buses.error)}
          </Notice>
        )}
        <div>
          <Button
            type="button"
            variant="secondary"
            busy={buses.isFetching}
            onClick={() => void buses.refetch()}
          >
            Обновить автопарк
          </Button>
          <Pager offset={offset} next={buses.data?.next ?? false} change={setOffset} />
        </div>
        {selected.isError && (
          <Notice title="Выбранный автобус недоступен" error>
            {carrierError(selected.error)}
          </Notice>
        )}
        {!buses.isFetching && !buses.data?.items.length && (
          <ButtonLink secondary to="/carrier/buses/new">
            Добавить автобус
          </ButtonLink>
        )}
      </fieldset>
      <fieldset className="carrier-form-section">
        <legend>2. Маршрут</legend>
        <div className="booking-status-filter">
          <label htmlFor="route-direction">Направление</label>
          <select
            id="route-direction"
            value={direction}
            onChange={(event) => {
              setDirection(event.target.value as 'RU' | 'AM')
              setOrigin('')
              setDestination('')
              setCustomZone('')
              setDeparture('')
            }}
          >
            <option value="RU">Россия → Армения</option>
            <option value="AM">Армения → Россия</option>
          </select>
        </div>
        <CityInput
          label="Город отправления"
          name="origin"
          value={origin}
          onChange={(value) => {
            if (cityTimezone(value, direction) !== cityTimezone(origin, direction)) setDeparture('')
            setOrigin(value)
          }}
          country={direction}
          required
        />
        <CityInput
          label="Город прибытия"
          name="destination"
          value={destination}
          onChange={setDestination}
          country={direction === 'RU' ? 'AM' : 'RU'}
          required
        />
      </fieldset>
      <fieldset className="carrier-form-section">
        <legend>3. Посадка и высадка</legend>
        <Field
          label="Адрес посадки"
          value={boarding}
          onChange={(event) => setBoarding(event.target.value)}
          required
          minLength={5}
          maxLength={500}
          hint="Город, улица, номер дома или автостанция; укажите точный ориентир и платформу, если известны."
        />
        <Field
          label="Адрес высадки"
          value={dropoff}
          onChange={(event) => setDropoff(event.target.value)}
          required
          minLength={5}
          maxLength={500}
          hint="Точное место прибытия в городе назначения. Пассажир увидит его до бронирования."
        />
      </fieldset>
      <fieldset className="carrier-form-section">
        <legend>4. Отправление и цена</legend>
        <div className="booking-status-filter">
          <label htmlFor="departure-zone">Часовой пояс отправления</label>
          <select
            id="departure-zone"
            value={zone}
            disabled={!!cityTimezone(origin, direction) || direction === 'AM'}
            onChange={(event) => {
              setCustomZone(event.target.value)
              setDeparture('')
            }}
          >
            <option value="">Выберите пояс города</option>
            {[
              ...new Set([
                ...cities.map((city) => city.timezone),
                'Europe/Kaliningrad',
                'Europe/Kirov',
                'Europe/Astrakhan',
                'Europe/Ulyanovsk',
                'Asia/Barnaul',
                'Asia/Tomsk',
                'Asia/Novokuznetsk',
                'Asia/Chita',
                'Asia/Yakutsk',
                'Asia/Khandyga',
                'Asia/Vladivostok',
                'Asia/Ust-Nera',
                'Asia/Magadan',
                'Asia/Sakhalin',
                'Asia/Srednekolymsk',
                'Asia/Kamchatka',
                'Asia/Anadyr',
                'UTC',
              ]),
            ].map((value) => (
              <option key={value} value={value}>
                {timezoneLabel(value)}
              </option>
            ))}
          </select>
          <p className="seat-help">
            Для города из справочника пояс определяется автоматически. При смене пояса укажите время
            заново.
          </p>
        </div>
        <Field
          label="Отправление (местное время)"
          type="datetime-local"
          value={departure}
          onChange={(event) => setDeparture(event.target.value)}
          required
          hint={`Время города отправления${zone ? ` · пояс: ${timezoneLabel(zone)}` : ''}. Часовой пояс устройства не используется.`}
        />
        <Field
          label="Цена билета, ₽"
          inputMode="decimal"
          value={price}
          onChange={(event) => setPrice(event.target.value)}
          required
          hint="Стоимость для одного пассажира, в рублях. Например, 4500,50."
        />
      </fieldset>
      {error && <Notice title={error} error />}
      <WriteResult message={write.message} />
      {write.uncertain ? (
        <Notice title="Сначала проверьте результат">
          Откройте список рейсов и проверьте сохранённые данные перед новой попыткой.
        </Notice>
      ) : (
        <Button type="submit" busy={write.busy} disabled={disabled}>
          {initial ? 'Сохранить изменения рейса' : 'Создать черновик'}
        </Button>
      )}
    </form>
  )
}
export function CreateRoutePage() {
  const [params] = useSearchParams()
  const bus = params.get('bus')
  return (
    <>
      <PageHeading eyebrow="РЕЙСЫ" title="Новый рейс">
        Черновик появится в поиске только после публикации.
      </PageHeading>
      {!params.size || (params.size === 1 && isUuid(bus)) ? (
        <RouteForm selectedBus={bus?.toLowerCase()} />
      ) : (
        <Notice title="Проверьте выбранный автобус" error />
      )}
      <ButtonLink secondary to="/carrier/routes">
        К рейсам
      </ButtonLink>
    </>
  )
}
function RouteContent({ id, edit }: { id: string; edit: boolean }) {
  const query = useCarrierRead(`/routes/my/${id}`, (v) => {
    const route = readOwnRoute(v)
    if (route.id !== id) throw new Error('Wrong route')
    return route
  })
  const write = useCarrierWrite()
  const navigate = useNavigate()
  const [confirm, setConfirm] = useState<{
    from: RouteStatus
    to: RouteStatus | 'ARCHIVE'
    readAt: number
  } | null>(null)
  const route = query.data
  async function transition() {
    if (
      !confirm ||
      !route ||
      confirm.from !== route.status ||
      confirm.readAt !== query.dataUpdatedAt ||
      query.isFetching ||
      query.isError
    )
      return
    const result = await write.run(() =>
      write.session.request(
        `/routes/${id}`,
        confirm.to === 'ARCHIVE'
          ? { method: 'DELETE' }
          : { method: 'PATCH', body: JSON.stringify({ status: confirm.to }) },
      ),
    )
    setConfirm(null)
    if (result.ok && confirm.to === 'ARCHIVE') navigate('/carrier/routes', { replace: true })
    else await query.refetch()
  }
  const actions: [RouteStatus | 'ARCHIVE', string][] =
    route?.status === 'DRAFT'
      ? [
          ['ACTIVE', 'Опубликовать рейс'],
          ['ARCHIVE', 'Архивировать черновик'],
        ]
      : route?.status === 'ACTIVE'
        ? [
            ['DEPARTED', 'Отметить отправление'],
            ['CANCELLED', 'Отменить рейс'],
          ]
        : route?.status === 'DEPARTED'
          ? [['COMPLETED', 'Завершить рейс']]
          : []
  return (
    <>
      <PageHeading eyebrow="РЕЙСЫ" title={edit ? 'Изменение рейса' : 'Управление рейсом'}>
        После первой брони направление, автобус, дата и цена неизменяемы. Доступность переходов
        проверяет сервер.
      </PageHeading>
      <div className="booking-actions">
        <ButtonLink secondary to="/carrier/routes">
          К рейсам
        </ButtonLink>
        <Button
          variant="secondary"
          disabled={write.busy}
          busy={query.isFetching}
          onClick={() => void query.refetch()}
        >
          Обновить рейс
        </Button>
      </div>
      <WriteResult message={write.message} />
      {query.isError ? (
        <Notice title="Рейс недоступен" error>
          {carrierError(query.error)}
        </Notice>
      ) : !route ? (
        <Loading title="Загружаем рейс…" />
      ) : edit ? (
        ['DRAFT', 'ACTIVE'].includes(route.status) ? (
          <RouteForm key={route.id} initial={route} />
        ) : (
          <Notice title="Редактирование доступно только для черновика или опубликованного рейса" />
        )
      ) : (
        <section className="booking-panel carrier-route-detail">
          <RouteInfo route={route} />
          <p className="booking-reference">Номер рейса: {id}</p>
          <div className="carrier-route-guidance">
            <h3>Что дальше</h3>
            <p>
              {
                {
                  DRAFT:
                    'Проверьте маршрут, время UTC, цену и автобус. После публикации рейс станет доступен пассажирам в поиске.',
                  ACTIVE:
                    'Рейс опубликован. Откройте бронирования перед посадкой. После запланированного времени можно отметить отправление.',
                  DEPARTED:
                    'Рейс отмечен как отправившийся. Когда поездка закончится, подтвердите её завершение.',
                  COMPLETED: 'Рейс завершён. Данные рейса и бронирований доступны для просмотра.',
                  CANCELLED:
                    'Рейс отменён. Для оплаченных билетов проверяйте заявки на возврат с администратором; отмена не означает, что деньги уже поступили пассажиру.',
                }[route.status]
              }
            </p>
          </div>
          <div className="booking-actions">
            <ButtonLink secondary to={`/carrier/buses/${route.bus_id}`}>
              Автобус рейса
            </ButtonLink>
            <ButtonLink to={`/carrier/bookings?route_id=${id}`}>Бронирования рейса</ButtonLink>
            {['DRAFT', 'ACTIVE'].includes(route.status) && (
              <ButtonLink secondary to={`/carrier/routes/${id}/edit`}>
                Изменить данные
              </ButtonLink>
            )}
          </div>
          {confirm?.from === route.status && confirm.readAt === query.dataUpdatedAt ? (
            <div className="cancel-confirm">
              <p>
                {confirm.to === 'CANCELLED'
                  ? 'Отменить рейс? Удержания и оплаченные брони будут отменены. Для оплаченных билетов создаются заявки на ручной возврат.'
                  : confirm.to === 'ACTIVE'
                    ? 'Опубликовать рейс? Пассажиры смогут бронировать места по указанной цене и времени.'
                    : confirm.to === 'ARCHIVE'
                      ? 'Архивировать черновик? Он исчезнет из рабочего списка.'
                      : confirm.to === 'DEPARTED'
                        ? 'Подтвердить отправление? Сервер разрешает этот переход после запланированного времени. Обратного перехода нет.'
                        : 'Завершить поездку? Оплаченные брони станут завершёнными. Обратного перехода нет.'}
              </p>
              <div className="booking-actions">
                <Button
                  busy={write.busy}
                  disabled={query.isFetching}
                  onClick={() => void transition()}
                >
                  Подтвердить действие
                </Button>
                <Button variant="secondary" disabled={write.busy} onClick={() => setConfirm(null)}>
                  Вернуться без изменений
                </Button>
              </div>
            </div>
          ) : (
            <div className="booking-actions">
              {actions.map(([to, label]) => (
                <Button
                  key={to}
                  variant="secondary"
                  disabled={write.busy || query.isFetching}
                  onClick={() =>
                    setConfirm({ from: route.status, to, readAt: query.dataUpdatedAt })
                  }
                >
                  {label}
                </Button>
              ))}
            </div>
          )}
        </section>
      )}
    </>
  )
}
export function CarrierRoutePage({ edit = false }: { edit?: boolean }) {
  const { id } = useParams()
  return isUuid(id) ? (
    <RouteContent key={`${id}:${edit}`} id={id.toLowerCase()} edit={edit} />
  ) : (
    <Notice title="Проверьте ссылку на рейс" error />
  )
}
