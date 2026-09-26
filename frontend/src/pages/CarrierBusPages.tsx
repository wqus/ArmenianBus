import { useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router'
import { useCarrierRead, useCarrierWrite } from '../features/carrier/hooks'
import { carrierError, readBus, readBusDetails, readPage } from '../features/carrier/contracts'
import { carrierListParams } from '../features/carrier/paths'
import { Pager, WriteResult } from '../features/carrier/CarrierUI'
import { isUuid } from '../features/trips/trip'
import { Button, ButtonLink, Field, Notice, PageHeading } from '../shared/ui'

export function CarrierBusesPage() {
  const [params, setParams] = useSearchParams()
  const filters = carrierListParams(params, 'buses')
  const offset = filters?.offset ?? 0
  const query = useCarrierRead(
    `/buses?limit=21&offset=${offset}`,
    (v) => readPage(v, offset, readBus),
    filters !== null,
  )
  return (
    <>
      <PageHeading eyebrow="АВТОПАРК" title="Мои автобусы">
        Вместимость и номера мест фиксируются при создании.
      </PageHeading>
      <div className="booking-actions">
        <ButtonLink to="/carrier/buses/new">Добавить автобус</ButtonLink>
        <Button
          variant="secondary"
          busy={query.isFetching}
          disabled={!filters}
          onClick={() => void query.refetch()}
        >
          Обновить автобусы
        </Button>
      </div>
      {!filters ? (
        <>
          <Notice title="Некорректная страница списка" />
          <Button onClick={() => setParams({})}>Открыть список</Button>
        </>
      ) : query.isError ? (
        <Notice title="Не удалось загрузить автобусы" error>
          {carrierError(query.error)}
        </Notice>
      ) : query.isFetching || !query.data ? (
        <Notice title="Загружаем автобусы…" />
      ) : (
        <>
          {!query.data.items.length && <Notice title="Автобусов на этой странице нет" />}
          <div className="booking-list">
            {query.data.items.map((bus) => (
              <article className="booking-panel" key={bus.id}>
                <h2>{bus.name}</h2>
                <p>Мест: {bus.capacity}</p>
                <ButtonLink to={`/carrier/buses/${bus.id}`}>Открыть автобус</ButtonLink>
              </article>
            ))}
          </div>
          <Pager
            offset={offset}
            next={query.data.next}
            change={(offset) => setParams(offset ? { offset: String(offset) } : {})}
          />
        </>
      )}
    </>
  )
}
export function CreateBusPage() {
  const write = useCarrierWrite()
  const navigate = useNavigate()
  const [name, setName] = useState('')
  const [capacity, setCapacity] = useState('')
  const [error, setError] = useState('')
  async function submit(event: React.SubmitEvent) {
    event.preventDefault()
    if (write.uncertain || write.busy) return
    if (!name.trim() || name.trim().length > 200 || !/^(?:[1-9]\d?|100)$/.test(capacity)) {
      setError('Укажите название и целое количество мест от 1 до 100.')
      return
    }
    setError('')
    const result = await write.run(async () =>
      readBusDetails(
        await write.session.request('/buses', {
          method: 'POST',
          body: JSON.stringify({ name: name.trim(), capacity: Number(capacity) }),
        }),
      ),
    )
    if (result.ok) navigate(`/carrier/buses/${result.value.id}`, { replace: true })
  }
  return (
    <>
      <PageHeading eyebrow="АВТОПАРК" title="Новый автобус">
        После создания можно менять название. Для другой вместимости создайте новый автобус.
      </PageHeading>
      <form className="carrier-form booking-panel" onSubmit={(event) => void submit(event)}>
        <Field
          label="Название автобуса"
          value={name}
          onChange={(event) => setName(event.target.value)}
          maxLength={200}
          required
        />
        <Field
          label="Количество мест"
          inputMode="numeric"
          value={capacity}
          onChange={(event) => setCapacity(event.target.value)}
          required
        />
        {error && <Notice title={error} error />}
        <WriteResult message={write.message} />
        {write.uncertain ? (
          <Notice title="Проверьте список перед новой попыткой">
            Автобус мог сохраниться. Найдите его в списке, чтобы не создать дубликат.
          </Notice>
        ) : (
          <Button type="submit" busy={write.busy}>
            Создать автобус
          </Button>
        )}
      </form>
      <ButtonLink secondary to="/carrier/buses">
        К автобусам
      </ButtonLink>
    </>
  )
}
function BusContent({ id }: { id: string }) {
  const query = useCarrierRead(`/buses/${id}`, (v) => {
    const bus = readBusDetails(v)
    if (bus.id !== id) throw new Error('Wrong bus')
    return bus
  })
  const write = useCarrierWrite()
  const navigate = useNavigate()
  const [name, setName] = useState<string | null>(null)
  const [confirm, setConfirm] = useState(false)
  async function rename(event: React.SubmitEvent) {
    event.preventDefault()
    if (!name?.trim() || name.trim().length > 200 || query.isFetching || query.isError) return
    const result = await write.run(() =>
      write.session.request(`/buses/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: name.trim() }),
      }),
    )
    if (result.ok) setName(null)
    await query.refetch()
  }
  async function archive() {
    if (!confirm || query.isFetching || query.isError) return
    const result = await write.run(() =>
      write.session.request(`/buses/${id}`, { method: 'DELETE' }),
    )
    setConfirm(false)
    if (result.ok) navigate('/carrier/buses', { replace: true })
    else await query.refetch()
  }
  return (
    <>
      <PageHeading eyebrow="АВТОПАРК" title="Автобус">
        Название, места и управление автобусом.
      </PageHeading>
      <div className="booking-actions">
        <ButtonLink secondary to="/carrier/buses">
          К автобусам
        </ButtonLink>
        <Button
          variant="secondary"
          busy={query.isFetching}
          disabled={write.busy}
          onClick={() => void query.refetch()}
        >
          Обновить автобус
        </Button>
      </div>
      <WriteResult message={write.message} />
      {query.isError ? (
        <Notice title="Автобус недоступен" error>
          {carrierError(query.error)}
        </Notice>
      ) : !query.data ? (
        <Notice title="Загружаем автобус…" />
      ) : (
        <section className="booking-panel">
          <h2>{query.data.name}</h2>
          <p>Вместимость: {query.data.capacity}</p>
          <form className="carrier-form" onSubmit={(event) => void rename(event)}>
            <Field
              label="Название автобуса"
              maxLength={200}
              required
              value={name ?? query.data.name}
              onChange={(event) => setName(event.target.value)}
            />
            <Button busy={write.busy} disabled={!name?.trim() || query.isFetching}>
              Сохранить название
            </Button>
          </form>
          <h3>Номера мест</h3>
          <ol className="carrier-seat-list">
            {[...query.data.seats]
              .sort((a, b) => a.seat_number - b.seat_number)
              .map((seat) => (
                <li key={seat.id}>{seat.seat_number}</li>
              ))}
          </ol>
          <div className="booking-actions">
            <ButtonLink to={`/carrier/routes/new?bus=${id}`}>
              Создать рейс на этом автобусе
            </ButtonLink>
          </div>
          {confirm ? (
            <div className="cancel-confirm">
              <p>
                Архивировать автобус? Он исчезнет из списка доступных автобусов. Незавершённые рейсы
                могут помешать архивации.
              </p>
              <div className="booking-actions">
                <Button
                  busy={write.busy}
                  disabled={query.isFetching}
                  onClick={() => void archive()}
                >
                  Да, архивировать автобус
                </Button>
                <Button variant="secondary" disabled={write.busy} onClick={() => setConfirm(false)}>
                  Оставить автобус
                </Button>
              </div>
            </div>
          ) : (
            <Button
              variant="secondary"
              disabled={write.busy || query.isFetching}
              onClick={() => setConfirm(true)}
            >
              Архивировать автобус
            </Button>
          )}
        </section>
      )}
    </>
  )
}
export function CarrierBusPage() {
  const { id } = useParams()
  return isUuid(id) ? (
    <BusContent key={id} id={id.toLowerCase()} />
  ) : (
    <Notice title="Проверьте ссылку на автобус" error />
  )
}
