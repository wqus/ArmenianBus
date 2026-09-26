import { timestamp, nonnegative } from './resources'
export const workerLabels = {
  holds: 'Истечение удержаний',
  payments: 'Сверка платежей',
  notifications: 'Доставка уведомлений',
}
export const stateLabels = {
  OK: 'Работает',
  DISABLED: 'Выключен',
  MISSING: 'Нет данных',
  STALE: 'Данные устарели',
  ERROR: 'Ошибка',
}
export const queueLabels = {
  expired_holds: 'Просроченные удержания',
  payments_due: 'Платежи к сверке',
  payments_for_review: 'Платежи на проверке',
  open_refunds: 'Открытые возвраты',
  failed_notifications: 'Ошибки уведомлений',
  notifications_due: 'Уведомления к отправке',
}
type Worker = {
  name: keyof typeof workerLabels
  state: keyof typeof stateLabels
  last_seen_at: string | null
  last_success_at: string | null
  last_error: string | null
  last_count: number | null
}
export type Health = {
  checked_at: string
  workers: Worker[]
  queues: Record<keyof typeof queueLabels, number> & { oldest_notification_due_at: string | null }
}
export function readHealth(value: unknown): Health {
  const h = value as Health | null
  const nullableTime = (v: unknown) => v === null || timestamp(v)
  if (
    !h ||
    !timestamp(h.checked_at) ||
    !h.queues ||
    !Array.isArray(h.workers) ||
    h.workers.length !== 3 ||
    new Set(h.workers.map((w) => w?.name)).size !== 3 ||
    h.workers.some(
      (w) =>
        !w ||
        !Object.hasOwn(workerLabels, w.name) ||
        !Object.hasOwn(stateLabels, w.state) ||
        !nullableTime(w.last_seen_at) ||
        !nullableTime(w.last_success_at) ||
        !(w.last_error === null || typeof w.last_error === 'string') ||
        !(w.last_count === null || nonnegative(w.last_count)),
    ) ||
    Object.keys(queueLabels).some((k) => !nonnegative(h.queues[k as keyof typeof queueLabels])) ||
    !nullableTime(h.queues.oldest_notification_due_at)
  )
    throw new Error('Invalid operations health')
  return h
}
