import { useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router'
import { useCarrierRead, useCarrierWrite } from '../features/carrier/hooks'
import { carrierError, readBus, readBusDetails, readPage } from '../features/carrier/contracts'
import { carrierListParams } from '../features/carrier/paths'
import { Pager, WriteResult } from '../features/carrier/CarrierUI'
import { isUuid } from '../features/trips/trip'
import { Button, ButtonLink, Field, Notice, Loading, PageHeading } from '../shared/ui'
import { findLayout, findVehicleModel, layouts, vehicleModels } from '../features/vehicles/catalog'
import { LayoutPreview } from '../features/vehicles/SeatMap'

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
        <Loading title="Загружаем автобусы…" />
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
  const [modelId, setModelId] = useState('')
  const [layoutId, setLayoutId] = useState('')
  const [confirmed, setConfirmed] = useState(false)
  const layout = findLayout(layoutId)
  const supportUrl = `mailto:support@mathbot.site?subject=${encodeURIComponent('Схема салона для armatrans')}&body=${encodeURIComponent(`Название транспорта: ${name}\nМодель: ${findVehicleModel(modelId)?.name ?? ''}\nЧисло пассажирских мест:\nПрикладываю схему с нумерацией и фото салона.`)}`
  const [error, setError] = useState('')
  async function submit(event: React.SubmitEvent) {
    event.preventDefault()
    if (write.uncertain || write.busy) return
    if (!name.trim() || name.trim().length > 200 || !layout || !modelId || !confirmed) {
      setError('Выберите модель и схему, затем подтвердите нумерацию мест.')
      return
    }
    setError('')
    const result = await write.run(async () =>
      readBusDetails(
        await write.session.request('/buses', {
          method: 'POST',
          body: JSON.stringify({
            name: name.trim(),
            capacity: layout.capacity,
            layout_id: layout.id,
            vehicle_model_id: modelId,
            layout_confirmed: confirmed,
          }),
        }),
      ),
    )
    if (result.ok) navigate(`/carrier/buses/${result.value.id}`, { replace: true })
  }
  return (
    <>
      <PageHeading eyebrow="АВТОПАРК" title="Новый автобус">
        Выберите модель, проверьте салон и нумерацию. Схема закрепляется при создании автобуса.
      </PageHeading>
      <div className="vehicle-create-layout">
        <form className="carrier-form booking-panel" onSubmit={(event) => void submit(event)}>
          <div className="field booking-status-filter">
            <label htmlFor="vehicle-model">Модель транспорта</label>
            <select
              id="vehicle-model"
              value={modelId}
              required
              disabled={write.busy || write.uncertain}
              onChange={(event) => {
                const model = findVehicleModel(event.target.value)
                setModelId(event.target.value)
                setLayoutId(model?.recommended_layout_id ?? '')
                setConfirmed(false)
                if (!name || name === findVehicleModel(modelId)?.name) {
                  setName(model && model.id !== 'other' ? model.name : '')
                }
              }}
            >
              <option value="">Выберите модель</option>
              {vehicleModels.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.name}
                </option>
              ))}
            </select>
          </div>
          <Field
            label="Название автобуса"
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={200}
            required
          />
          <div className="field booking-status-filter">
            <label htmlFor="vehicle-layout">Схема салона</label>
            <select
              id="vehicle-layout"
              value={layoutId}
              required
              disabled={write.busy || write.uncertain}
              onChange={(event) => {
                setLayoutId(event.target.value)
                setConfirmed(false)
              }}
            >
              <option value="">Выберите схему</option>
              {layouts.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.title}
                </option>
              ))}
              <option value="unsupported">Ни одна схема не подходит</option>
            </select>
          </div>
          <p className="layout-help">
            Модель предлагает стартовый шаблон, а не заводскую комплектацию. Если салон отличается,
            выберите другую схему. Водитель и сопровождающий в число пассажиров не входят.
          </p>
          <Field label="Количество мест" value={layout?.capacity ?? ''} readOnly />
          {layout && (
            <label className="layout-confirm">
              <input
                type="checkbox"
                checked={confirmed}
                required
                disabled={write.busy || write.uncertain}
                onChange={(event) => setConfirmed(event.target.checked)}
              />
              Подтверждаю: расположение и номера пассажирских мест совпадают с моим транспортом.
            </label>
          )}
          <div className="vehicle-support">
            <strong>Не нашли подходящую схему?</strong>
            <p>
              Не подбирайте похожую наугад. Отправьте модель, вместимость, фото салона и план с
              номерами мест — поддержка поможет добавить вариант.
            </p>
            <a href={supportUrl}>Написать на support@mathbot.site</a>
          </div>
          {error && <Notice title={error} error />}
          <WriteResult message={write.message} />
          {write.uncertain ? (
            <Notice title="Проверьте список перед новой попыткой">
              Автобус мог сохраниться. Найдите его в списке, чтобы не создать дубликат.
            </Notice>
          ) : (
            <Button type="submit" busy={write.busy} disabled={!layout || !confirmed || !modelId}>
              Создать автобус
            </Button>
          )}
        </form>
        <aside className="vehicle-preview" aria-labelledby="vehicle-preview-title">
          <h2 id="vehicle-preview-title">Проверьте салон</h2>
          {layout ? (
            <>
              <p>{layout.title}. Пассажиры увидят эту нумерацию.</p>
              <LayoutPreview layout={layout} />
            </>
          ) : (
            <p>Выберите подходящую схему. Для нестандартного салона обратитесь в поддержку.</p>
          )}
          <p>
            Вид сверху. Схематично, без масштаба и расположения дверей. После создания изменить
            схему нельзя — для другой комплектации создайте отдельный автобус.
          </p>
        </aside>
      </div>
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
        <Loading title="Загружаем автобус…" />
      ) : (
        <section className="booking-panel">
          <h2>{query.data.name}</h2>
          <p>Вместимость: {query.data.capacity}</p>
          {query.data.layout_id && findLayout(query.data.layout_id) ? (
            <>
              <p>Схема: {findLayout(query.data.layout_id)!.title}</p>
              <LayoutPreview layout={findLayout(query.data.layout_id)!} />
            </>
          ) : (
            <p className="layout-help">
              Схема не подтверждена: пассажир видит список номеров. Для салона со схемой создайте
              новый автобус.
            </p>
          )}
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
