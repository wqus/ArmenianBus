import { isUuid } from '../trips/trip'
import { exactPrice, readOwnRoute } from '../carrier/contracts'
import { readDetails } from '../bookings/booking'

type Kind = 'text' | 'uuid' | 'date' | 'money' | 'boolean' | 'integer' | 'json'
export type Field = {
  key: string
  label: string
  kind: Kind
  nullable?: boolean
  values?: string[]
  link?: string
}
export type Filter = { key: string; label: string; values?: string[]; uuid?: boolean; max?: number }
export type Resource = { title: string; fields: Field[]; filters: Filter[]; summary: string[] }
export type AdminRecord = { id: string } & Record<string, unknown>
const f = (key: string, label: string, kind: Kind = 'text', extra: Partial<Field> = {}): Field => ({
  key,
  label,
  kind,
  ...extra,
})
const id = f('id', 'Идентификатор', 'uuid')
const created = f('created_at', 'Создано (UTC)', 'date')
const status = (values: string[]) => f('status', 'Статус', 'text', { values })
const ref = (key: string, label: string, link: string) => f(key, label, 'uuid', { link })
const time = (key: string, label: string) => f(key, label, 'date', { nullable: true })
const filter = (key: string, label: string, values?: string[]): Filter => ({
  key,
  label,
  values,
  uuid: key.endsWith('_id'),
})
const userStatuses = ['ACTIVE', 'BLOCKED'],
  carrierStatuses = ['PENDING', 'ACTIVE', 'BLOCKED']
const routeStatuses = ['DRAFT', 'ACTIVE', 'DEPARTED', 'COMPLETED', 'CANCELLED']
const bookingStatuses = ['HELD', 'PAID', 'EXPIRED', 'CANCELLED', 'COMPLETED']
const paymentStatuses = ['PENDING', 'SUCCEEDED', 'CANCELED', 'FAILED']
const refundStatuses = ['OPEN', 'REFUND_RECORDED'],
  notificationStatuses = ['PENDING', 'SENT', 'FAILED']

export const resources: Record<string, Resource> = {
  users: {
    title: 'Пользователи',
    summary: ['email', 'role', 'status'],
    filters: [
      filter('role', 'Роль', ['PASSENGER', 'CARRIER', 'ADMIN']),
      filter('status', 'Статус', userStatuses),
    ],
    fields: [
      id,
      f('email', 'Электронная почта'),
      f('role', 'Роль', 'text', { values: ['PASSENGER', 'CARRIER', 'ADMIN'] }),
      status(userStatuses),
      created,
    ],
  },
  carriers: {
    title: 'Перевозчики',
    summary: ['company_name', 'phone', 'status'],
    filters: [filter('status', 'Статус', carrierStatuses)],
    fields: [
      id,
      ref('user_id', 'Аккаунт', 'users'),
      f('company_name', 'Компания'),
      f('phone', 'Телефон'),
      status(carrierStatuses),
      created,
    ],
  },
  routes: {
    title: 'Рейсы',
    summary: ['origin', 'destination', 'departure_at', 'status', 'price', 'archived_at'],
    filters: [
      filter('status', 'Статус', routeStatuses),
      filter('carrier_id', 'Идентификатор перевозчика'),
    ],
    fields: [
      id,
      ref('carrier_id', 'Перевозчик', 'carriers'),
      f('bus_id', 'Автобус', 'uuid'),
      f('origin_country', 'Страна отправления'),
      f('destination_country', 'Страна прибытия'),
      f('origin', 'Отправление'),
      f('destination', 'Прибытие'),
      f('departure_at', 'Отправление (UTC)', 'date'),
      f('price', 'Цена, RUB', 'money'),
      f('currency', 'Валюта', 'text', { values: ['RUB'] }),
      status(routeStatuses),
      created,
      time('archived_at', 'Архивирован (UTC)'),
    ],
  },
  bookings: {
    title: 'Бронирования',
    summary: ['origin', 'destination', 'seat_number', 'status', 'amount'],
    filters: [
      filter('status', 'Статус', bookingStatuses),
      filter('route_id', 'Идентификатор рейса'),
      filter('passenger_id', 'Идентификатор пассажира'),
    ],
    fields: [
      id,
      ref('route_id', 'Рейс', 'routes'),
      ref('passenger_id', 'Пассажир', 'users'),
      f('bus_id', 'Автобус', 'uuid'),
      f('seat_id', 'Идентификатор места', 'uuid'),
      f('seat_number', 'Место', 'integer'),
      f('origin', 'Отправление'),
      f('destination', 'Прибытие'),
      f('company_name', 'Компания'),
      f('departure_at', 'Отправление (UTC)', 'date'),
      f('held_until', 'Удержание до (UTC)', 'date'),
      status(bookingStatuses),
      f('route_status', 'Статус рейса', 'text', { values: routeStatuses }),
      f('amount', 'Сумма, RUB', 'money'),
      f('currency', 'Валюта', 'text', { values: ['RUB'] }),
      f('payment_status', 'Платёж', 'text', { nullable: true, values: paymentStatuses }),
      f('refund_status', 'Возврат', 'text', { nullable: true, values: refundStatuses }),
      f('refund_required', 'Нужен возврат', 'boolean'),
      created,
    ],
  },
  payments: {
    title: 'Платежи',
    summary: ['status', 'amount', 'test_mode', 'review_reason'],
    filters: [
      filter('status', 'Статус', paymentStatuses),
      filter('review_required', 'Требует проверки', ['true', 'false']),
      filter('booking_id', 'Идентификатор брони'),
    ],
    fields: [
      id,
      ref('booking_id', 'Бронь', 'bookings'),
      ref('passenger_id', 'Пассажир', 'users'),
      f('external_id', 'Идентификатор у провайдера', 'text', { nullable: true }),
      status(paymentStatuses),
      f('amount', 'Сумма, RUB', 'money'),
      f('currency', 'Валюта', 'text', { values: ['RUB'] }),
      f('test_mode', 'Тестовый платёж', 'boolean'),
      f('review_reason', 'Причина проверки', 'text', { nullable: true }),
      f('last_error', 'Последняя ошибка', 'text', { nullable: true }),
      f('next_check_at', 'Следующая сверка (UTC)', 'date'),
      created,
    ],
  },
  'refund-cases': {
    title: 'Возвраты',
    summary: ['status', 'reason', 'resolution_reference'],
    filters: [filter('status', 'Статус', refundStatuses)],
    fields: [
      id,
      ref('payment_id', 'Платёж', 'payments'),
      f('reason', 'Причина'),
      status(refundStatuses),
      f('resolution_reference', 'Номер ручного возврата', 'text', { nullable: true }),
      time('resolved_at', 'Отмечен (UTC)'),
      f('resolved_by_user_id', 'Оператор', 'uuid', { nullable: true, link: 'users' }),
      created,
    ],
  },
  notifications: {
    title: 'Уведомления',
    summary: ['event_key', 'status', 'attempts', 'last_error'],
    filters: [
      filter('status', 'Статус', notificationStatuses),
      filter('booking_id', 'Идентификатор брони'),
    ],
    fields: [
      id,
      ref('booking_id', 'Бронь', 'bookings'),
      ref('recipient_id', 'Получатель', 'users'),
      f('event_key', 'Событие'),
      status(notificationStatuses),
      f('attempts', 'Попытки', 'integer'),
      f('retry_generation', 'Поколение повтора', 'integer'),
      f('next_attempt_at', 'Следующая попытка (UTC)', 'date'),
      time('lease_until', 'Обработка занята до (UTC)'),
      f('last_error', 'Последняя ошибка', 'text', { nullable: true }),
      time('sent_at', 'Отправлено (UTC)'),
      created,
    ],
  },
  audit: {
    title: 'Аудит',
    summary: ['action', 'entity_type', 'created_at'],
    filters: [
      filter('entity_id', 'Идентификатор объекта'),
      filter('actor_user_id', 'Идентификатор оператора'),
      { key: 'entity_type', label: 'Тип объекта', max: 50 },
      { key: 'action', label: 'Действие', max: 100 },
    ],
    fields: [
      id,
      f('actor_user_id', 'Оператор', 'uuid', { nullable: true, link: 'users' }),
      f('action', 'Действие'),
      f('entity_type', 'Тип объекта'),
      f('entity_id', 'Объект', 'uuid'),
      f('event_data', 'Данные события', 'json'),
      created,
    ],
  },
}
export const labels: Record<string, string> = {
  ACTIVE: 'Активен',
  BLOCKED: 'Заблокирован',
  PENDING: 'Ожидает обработки',
  PASSENGER: 'Пассажир',
  CARRIER: 'Перевозчик',
  ADMIN: 'Администратор',
  DRAFT: 'Черновик',
  DEPARTED: 'В пути',
  COMPLETED: 'Завершён',
  CANCELLED: 'Отменён',
  HELD: 'Место удерживается',
  PAID: 'Оплачено',
  EXPIRED: 'Срок истёк',
  SUCCEEDED: 'Платёж подтверждён',
  CANCELED: 'Платёж отменён',
  FAILED: 'Ошибка',
  SENT: 'Отправлено',
  OPEN: 'Открыта',
  REFUND_RECORDED: 'Возврат отмечен оператором',
  true: 'Да',
  false: 'Нет',
}
export const timestamp = (v: unknown): v is string =>
  typeof v === 'string' && /T.*(?:Z|[+-]\d{2}:\d{2})$/.test(v) && Number.isFinite(Date.parse(v))
export const nonnegative = (v: unknown): v is number =>
  Number.isSafeInteger(v) && (v as number) >= 0
export function readRecord(kind: string, value: unknown): AdminRecord {
  if (
    !Object.hasOwn(resources, kind) ||
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value)
  )
    throw new Error('Invalid admin record')
  const record = value as AdminRecord
  if (kind === 'routes') readOwnRoute(record)
  if (kind === 'bookings') readDetails(record)
  for (const field of resources[kind].fields) {
    const v = record[field.key]
    if (v === null && field.nullable) continue
    const valid =
      field.kind === 'uuid'
        ? isUuid(v)
        : field.kind === 'date'
          ? timestamp(v)
          : field.kind === 'integer'
            ? nonnegative(v)
            : field.kind === 'boolean'
              ? typeof v === 'boolean'
              : field.kind === 'money'
                ? typeof v === 'string' && exactPrice(v)
                : field.kind === 'json'
                  ? !!v && typeof v === 'object' && !Array.isArray(v)
                  : typeof v === 'string' &&
                    !!v.trim() &&
                    (!field.values || field.values.includes(v))
    if (!valid) throw new Error(`Invalid admin field: ${field.key}`)
  }
  if (
    kind === 'refund-cases' &&
    (record.status === 'REFUND_RECORDED'
      ? !record.resolution_reference || !record.resolved_at || !record.resolved_by_user_id
      : record.resolution_reference !== null ||
        record.resolved_at !== null ||
        record.resolved_by_user_id !== null)
  )
    throw new Error('Invalid refund resolution')
  // Only explicitly declared fields can reach presentation; extra API fields are not displayed.
  return Object.fromEntries(
    resources[kind].fields.map((field) => [field.key, record[field.key]]),
  ) as AdminRecord
}
