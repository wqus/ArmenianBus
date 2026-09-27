import { useState } from 'react'
import { Link, NavLink, Outlet, useParams, useSearchParams } from 'react-router'
import { Button, ButtonLink, Field as Input, Notice, Loading, PageHeading } from '../shared/ui'
import { readPage } from '../features/carrier/contracts'
import { Pager } from '../features/carrier/CarrierUI'
import { isUuid } from '../features/trips/trip'
import { formatPrice } from '../features/search/search'
import {
  resources,
  labels,
  readRecord,
  type AdminRecord,
  type Field,
} from '../features/admin/resources'
import { readAdminFilters } from '../features/admin/paths'
import { operations, operationBody, adminError, type Operation } from '../features/admin/operations'
import { useAdminRead, useAdminWrite } from '../features/admin/hooks'
import { readHealth, workerLabels, stateLabels, queueLabels } from '../features/admin/health'

const date = (value: unknown) =>
  typeof value === 'string'
    ? new Date(value).toISOString().replace('T', ' ').replace('.000Z', ' UTC').replace('Z', ' UTC')
    : '—'
function Display({ field, value }: { field: Field; value: unknown }) {
  if (value === null) return <>—</>
  if (field.link) return <Link to={`/admin/${field.link}/${String(value)}`}>{String(value)}</Link>
  if (field.kind === 'date') return <>{date(value)}</>
  if (field.kind === 'money') return <>{formatPrice(String(value))}</>
  if (field.kind === 'json')
    return <pre className="admin-event">{JSON.stringify(value, null, 2)}</pre>
  if (field.kind === 'boolean') return <>{value ? 'Да' : 'Нет'}</>
  return <>{field.values ? (labels[String(value)] ?? String(value)) : String(value)}</>
}
function RecordFields({
  kind,
  record,
  summary = false,
}: {
  kind: string
  record: AdminRecord
  summary?: boolean
}) {
  return (
    <dl className="admin-fields">
      {resources[kind].fields
        .filter((f) => !summary || resources[kind].summary.includes(f.key))
        .map((field) => (
          <div key={field.key}>
            <dt>{field.label}</dt>
            <dd>
              <Display field={field} value={record[field.key]} />
            </dd>
          </div>
        ))}
    </dl>
  )
}
export function AdminLayout() {
  return (
    <div className="container information-page">
      <nav className="carrier-nav" aria-label="Кабинет администратора">
        <NavLink to="/admin" end>
          Обзор
        </NavLink>
        {Object.entries(resources).map(([key, resource]) => (
          <NavLink key={key} to={`/admin/${key}`}>
            {resource.title}
          </NavLink>
        ))}
      </nav>
      <Outlet />
    </div>
  )
}
export function AdminOverviewPage() {
  const query = useAdminRead('/operations/health', readHealth)
  return (
    <>
      <PageHeading eyebrow="АДМИНИСТРАТОРУ" title="Состояние операций">
        Очереди и последние сигналы фоновых обработчиков. Данные обновляются по запросу и при
        возврате к вкладке.
      </PageHeading>
      <Button variant="secondary" busy={query.isFetching} onClick={() => void query.refetch()}>
        Обновить состояние
      </Button>
      {query.isPending ? (
        <Loading title="Загружаем состояние…" />
      ) : query.isError ? (
        <Notice title="Не удалось проверить операции" error>
          {adminError(query.error)}
        </Notice>
      ) : (
        <>
          <p>Проверено: {date(query.data.checked_at)}</p>
          <div className="booking-list">
            {query.data.workers.map((w) => (
              <section className="booking-panel" key={w.name}>
                <h2>{workerLabels[w.name]}</h2>
                <p>
                  <strong>{stateLabels[w.state]}</strong>
                </p>
                <p>Последний сигнал: {date(w.last_seen_at)}</p>
                <p>Последний успех: {date(w.last_success_at)}</p>
                <p>Обработано: {w.last_count ?? '—'}</p>
                {w.last_error && <p>Ошибка: {w.last_error}</p>}
              </section>
            ))}
          </div>
          <section className="booking-panel">
            <h2>Очереди</h2>
            <dl className="admin-fields">
              {Object.entries(queueLabels).map(([key, label]) => (
                <div key={key}>
                  <dt>{label}</dt>
                  <dd>{query.data.queues[key as keyof typeof queueLabels]}</dd>
                </div>
              ))}
            </dl>
            <p>
              Самое раннее ожидающее уведомление:{' '}
              {date(query.data.queues.oldest_notification_due_at)}
            </p>
            <div className="booking-actions">
              <ButtonLink to="/admin/payments?review_required=true">Платежи на проверке</ButtonLink>
              <ButtonLink to="/admin/refund-cases?status=OPEN">Открытые возвраты</ButtonLink>
              <ButtonLink to="/admin/notifications?status=FAILED">Ошибки доставки</ButtonLink>
            </div>
          </section>
        </>
      )}
    </>
  )
}
function Filters({
  kind,
  params,
  apply,
}: {
  kind: string
  params: URLSearchParams
  apply: (p: URLSearchParams) => void
}) {
  const [values, setValues] = useState(Object.fromEntries(params)),
    [error, setError] = useState('')
  return (
    <form
      className="admin-filters"
      onSubmit={(event) => {
        event.preventDefault()
        const p = new URLSearchParams()
        for (const field of resources[kind].filters)
          if (values[field.key]?.trim()) p.set(field.key, values[field.key].trim())
        const clean = readAdminFilters(kind, p)
        if (!clean) {
          setError('Проверьте фильтры: идентификаторы должны быть полными UUID.')
          return
        }
        setError('')
        apply(clean)
      }}
    >
      {resources[kind].filters.map((field) =>
        field.values ? (
          <div className="booking-status-filter" key={field.key}>
            <label htmlFor={`admin-${field.key}`}>{field.label}</label>
            <select
              id={`admin-${field.key}`}
              value={values[field.key] ?? ''}
              onChange={(e) => setValues({ ...values, [field.key]: e.target.value })}
            >
              <option value="">Все</option>
              {field.values.map((value) => (
                <option value={value} key={value}>
                  {labels[value] ?? value}
                </option>
              ))}
            </select>
          </div>
        ) : (
          <Input
            key={field.key}
            label={field.label}
            maxLength={field.max ?? 36}
            value={values[field.key] ?? ''}
            onChange={(e) => setValues({ ...values, [field.key]: e.target.value })}
          />
        ),
      )}
      <div className="booking-actions">
        <Button type="submit">Применить фильтры</Button>
        <Button
          type="button"
          variant="secondary"
          onClick={() => {
            setValues({})
            setError('')
            apply(new URLSearchParams())
          }}
        >
          Сбросить фильтры
        </Button>
      </div>
      {error && <Notice title={error} error />}
    </form>
  )
}
function ListContent({ kind }: { kind: string }) {
  const [params, setParams] = useSearchParams(),
    filters = readAdminFilters(kind, params),
    offset = Number(filters?.get('offset') ?? 0)
  const api = new URLSearchParams(filters ?? undefined)
  api.set('limit', '21')
  api.set('offset', String(offset))
  const query = useAdminRead(
    `/${kind}?${api}`,
    (v) => readPage(v, offset, (item) => readRecord(kind, item)),
    filters !== null,
  )
  return (
    <>
      <PageHeading eyebrow="АДМИНИСТРАТОРУ" title={resources[kind].title}>
        {kind === 'audit'
          ? 'История действий. Записи доступны только для чтения.'
          : 'Фильтруйте список и открывайте запись для подробностей и доступных действий.'}
      </PageHeading>
      {!filters ? (
        <>
          <Notice title="Некорректные фильтры в ссылке" error />
          <Button onClick={() => setParams({})}>Открыть список</Button>
        </>
      ) : (
        <>
          <Filters key={params.toString()} kind={kind} params={filters} apply={setParams} />
          <Button variant="secondary" busy={query.isFetching} onClick={() => void query.refetch()}>
            Обновить список
          </Button>
          {query.isPending ? (
            <Loading title="Загружаем список…" />
          ) : query.isError ? (
            <Notice title="Список недоступен" error>
              {adminError(query.error)}
            </Notice>
          ) : (
            <>
              {!query.data.items.length && <Notice title="Записей на этой странице нет" />}
              <div className="booking-list">
                {query.data.items.map((record) => (
                  <article key={record.id} className="booking-panel">
                    <h2>
                      {kind === 'users'
                        ? String(record.email)
                        : kind === 'carriers'
                          ? String(record.company_name)
                          : kind === 'audit'
                            ? String(record.action)
                            : `${resources[kind].title} · ${record.id.slice(0, 8)}`}
                    </h2>
                    <RecordFields kind={kind} record={record} summary={kind !== 'audit'} />
                    {kind !== 'audit' && (
                      <ButtonLink secondary to={`/admin/${kind}/${record.id}`}>
                        Открыть запись
                      </ButtonLink>
                    )}
                  </article>
                ))}
              </div>
              <Pager
                offset={offset}
                next={query.data.next}
                change={(value) => {
                  const p = new URLSearchParams(filters)
                  if (value) p.set('offset', String(value))
                  else p.delete('offset')
                  setParams(p)
                }}
              />
            </>
          )}
        </>
      )}
    </>
  )
}
export function AdminListPage() {
  const { kind } = useParams()
  return kind && Object.hasOwn(resources, kind) ? (
    <ListContent key={kind} kind={kind} />
  ) : (
    <Notice title="Раздел не найден" error />
  )
}
function ActionForm({
  operation,
  confirm,
}: {
  operation: Operation
  confirm: (body: Record<string, unknown>) => void
}) {
  const [value, setValue] = useState(''),
    [error, setError] = useState('')
  const label =
    operation.input === 'reason'
      ? 'Причина действия'
      : operation.input === 'reference'
        ? 'Номер выполненного возврата'
        : 'Идентификатор платежа у провайдера'
  return (
    <form
      className="carrier-form"
      onSubmit={(event) => {
        event.preventDefault()
        const body = operationBody(operation, value)
        if (!body) {
          setError(
            operation.input === 'reference'
              ? 'Нужен номер до 100 символов: латинские буквы, цифры и . _ : / -. Первый символ — буква или цифра.'
              : operation.input === 'external_id'
                ? 'Укажите полный UUID из кабинета провайдера.'
                : 'Укажите причину от 1 до 500 символов.',
          )
          return
        }
        setError('')
        confirm(body)
      }}
    >
      {operation.input && (
        <Input
          label={label}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          required
          maxLength={
            operation.input === 'reason' ? 500 : operation.input === 'reference' ? 100 : 36
          }
          hint={
            operation.input === 'external_id'
              ? 'Найдите существующий платёж в кабинете провайдера.'
              : 'Не указывайте секреты или платёжные реквизиты.'
          }
          error={error}
        />
      )}
      <Button type="submit" variant="secondary">
        {operation.label}
      </Button>
    </form>
  )
}
function DetailContent({ kind, id }: { kind: string; id: string }) {
  const query = useAdminRead(`/${kind}/${id}`, (v) => {
      const record = readRecord(kind, v)
      if (record.id !== id) throw new Error('Wrong admin record')
      return record
    }),
    write = useAdminWrite()
  const [intent, setIntent] = useState<{
    operation: Operation
    body: Record<string, unknown>
    at: number
  } | null>(null)
  async function execute() {
    if (
      !intent ||
      query.isFetching ||
      query.isError ||
      intent.at !== query.dataUpdatedAt ||
      write.busy
    )
      return
    const current = intent
    setIntent(null)
    await write.run(async () => {
      const result = readRecord(
        kind,
        await write.session.request(`/admin/${kind}/${id}/${current.operation.suffix}`, {
          method: current.operation.method,
          body: JSON.stringify(current.body),
        }),
      )
      if (result.id !== id) throw new Error('Wrong operation response')
    })
  }
  const entity = (
    {
      users: 'user',
      carriers: 'carrier',
      routes: 'route',
      bookings: 'booking',
      payments: 'payment',
      'refund-cases': 'refund_case',
      notifications: 'notification',
    } as Record<string, string>
  )[kind]
  return (
    <>
      <PageHeading eyebrow="АДМИНИСТРАТОРУ" title={`${resources[kind].title}: запись`}>
        Проверьте данные перед действием. Решения и причины сохраняются в аудите.
      </PageHeading>
      <div className="booking-actions">
        <ButtonLink secondary to={`/admin/${kind}`}>
          К списку
        </ButtonLink>
        <Button
          variant="secondary"
          busy={query.isFetching}
          disabled={write.busy}
          onClick={() => {
            setIntent(null)
            void query.refetch()
          }}
        >
          Обновить запись
        </Button>
        <ButtonLink secondary to={`/admin/audit?entity_id=${id}&entity_type=${entity}`}>
          Аудит записи
        </ButtonLink>
      </div>
      {write.error && (
        <Notice title="Результат операции" error>
          {write.error}
        </Notice>
      )}
      {write.done && (
        <Notice title="Запрос выполнен">Проверьте актуальное состояние записи ниже.</Notice>
      )}
      {query.isPending ? (
        <Loading title="Загружаем запись…" />
      ) : query.isError ? (
        <Notice title="Запись недоступна" error>
          {adminError(query.error)}
        </Notice>
      ) : (
        <section className="booking-panel">
          <h2>Данные записи</h2>
          <RecordFields kind={kind} record={query.data} />
          {kind === 'users' && query.data.role === 'ADMIN' && (
            <Notice title="Административный аккаунт защищён" />
          )}
          {kind === 'refund-cases' && (
            <Notice title="Ручной возврат">
              Отметка оператора не является банковским подтверждением зачисления.
            </Notice>
          )}
          {kind === 'carriers' && (
            <ButtonLink secondary to={`/admin/routes?carrier_id=${id}`}>
              Рейсы перевозчика
            </ButtonLink>
          )}
          {kind === 'routes' && (
            <ButtonLink secondary to={`/admin/bookings?route_id=${id}`}>
              Брони рейса
            </ButtonLink>
          )}
          {kind === 'bookings' && (
            <div className="booking-actions">
              <ButtonLink secondary to={`/admin/payments?booking_id=${id}`}>
                Платежи брони
              </ButtonLink>
              <ButtonLink secondary to={`/admin/notifications?booking_id=${id}`}>
                Уведомления брони
              </ButtonLink>
            </div>
          )}
          {!write.busy &&
            !query.isFetching &&
            (intent?.at === query.dataUpdatedAt ? (
              <section className="cancel-confirm" aria-label="Подтверждение действия">
                <h3>{intent.operation.label}</h3>
                <p>{intent.operation.description}</p>
                {intent.operation.input && (
                  <p className="admin-input-review">
                    Введённое значение: {String(intent.body[intent.operation.input])}
                  </p>
                )}
                <div className="booking-actions">
                  <Button onClick={() => void execute()}>Подтвердить действие</Button>
                  <Button variant="secondary" onClick={() => setIntent(null)}>
                    Вернуться без изменений
                  </Button>
                </div>
              </section>
            ) : (
              operations(kind, query.data).map((operation) => (
                <ActionForm
                  key={`${operation.key}:${query.dataUpdatedAt}`}
                  operation={operation}
                  confirm={(body) => setIntent({ operation, body, at: query.dataUpdatedAt })}
                />
              ))
            ))}
          {write.busy && <Notice title="Выполняем действие…" />}
        </section>
      )}
    </>
  )
}
export function AdminDetailPage() {
  const { kind, id } = useParams()
  return kind && kind !== 'audit' && Object.hasOwn(resources, kind) && isUuid(id) ? (
    <DetailContent key={`${kind}:${id}`} kind={kind} id={id.toLowerCase()} />
  ) : (
    <Notice title="Некорректная ссылка на запись" error />
  )
}
