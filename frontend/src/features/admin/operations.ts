import type { AdminRecord } from './resources'
import { isUuid } from '../trips/trip'
import { ApiError } from '../../shared/api/client'
export type Operation = {
  key: string
  label: string
  description: string
  input?: 'reason' | 'reference' | 'external_id'
  method: 'PATCH' | 'POST'
  suffix: string
  fixed: Record<string, unknown>
}
export function operations(kind: string, record: AdminRecord): Operation[] {
  if (kind === 'users' && record.role !== 'ADMIN')
    return [
      {
        key: 'status',
        label: record.status === 'ACTIVE' ? 'Заблокировать аккаунт' : 'Разблокировать аккаунт',
        description:
          record.status === 'ACTIVE'
            ? 'Вход и запросы пользователя будут запрещены, refresh-сессии отозваны. Рейсы автоматически не отменяются.'
            : 'Доступ аккаунта восстановится. Профиль перевозчика активируется отдельно.',
        input: 'reason',
        method: 'PATCH',
        suffix: 'status',
        fixed: { status: record.status === 'ACTIVE' ? 'BLOCKED' : 'ACTIVE' },
      },
    ]
  if (kind === 'carriers')
    return [
      {
        key: 'status',
        label:
          record.status === 'ACTIVE' ? 'Заблокировать перевозчика' : 'Активировать перевозчика',
        description:
          record.status === 'ACTIVE'
            ? 'Операции и новые бронирования рейсов перевозчика будут приостановлены. Существующие рейсы автоматически не отменяются.'
            : 'Компания получит доступ к автобусам и публикации рейсов. Блокировка её аккаунта снимается отдельно.',
        method: 'PATCH',
        suffix: 'status',
        fixed: { status: record.status === 'ACTIVE' ? 'BLOCKED' : 'ACTIVE' },
      },
    ]
  if (kind === 'routes' && record.status === 'ACTIVE')
    return [
      {
        key: 'cancel',
        label: 'Отменить рейс',
        description:
          'Удержания и оплаченные брони будут отменены. Для оплаченных билетов создаются заявки на ручной возврат. Деньги автоматически не перечисляются.',
        input: 'reason',
        method: 'POST',
        suffix: 'cancel',
        fixed: {},
      },
    ]
  if (kind === 'payments')
    return [
      {
        key: 'verify',
        label: 'Проверить у провайдера',
        description:
          'Выполняется запрос текущего состояния платежа. Новое списание не создаётся. Нужны настроенный магазин и включённые платежи.',
        ...(record.external_id === null ? { input: 'external_id' as const } : {}),
        method: 'POST',
        suffix: 'verify',
        fixed: {},
      },
    ]
  if (kind === 'refund-cases' && record.status === 'OPEN')
    return [
      {
        key: 'record',
        label: 'Записать ручной возврат',
        description:
          'Подтверждаю, что полный возврат уже выполнен вне armatrans. Будет сохранена только отметка оператора и номер операции. Сервис не перечисляет деньги и не проверяет зачисление.',
        input: 'reference',
        method: 'POST',
        suffix: 'record',
        fixed: {},
      },
    ]
  if (kind === 'notifications' && record.status === 'FAILED')
    return [
      {
        key: 'retry',
        label: 'Повторить доставку',
        description:
          'Уведомление вернётся в очередь с новым поколением. Worker отправит его при включённом SMTP. Повторная доставка может привести к дубликату письма.',
        input: 'reason',
        method: 'POST',
        suffix: 'retry',
        fixed: { expected_generation: record.retry_generation },
      },
    ]
  return []
}
export function operationBody(operation: Operation, value: string): Record<string, unknown> | null {
  const clean = value.trim()
  if (operation.input === 'reason' && (!clean || clean.length > 500)) return null
  if (operation.input === 'reference' && !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/.test(clean))
    return null
  if (operation.input === 'external_id' && !isUuid(clean)) return null
  return { ...operation.fixed, ...(operation.input ? { [operation.input]: clean } : {}) }
}
export function adminError(error: unknown, writing = false) {
  if (error instanceof ApiError) {
    const messages: Record<string, string> = {
      ADMIN_ACCOUNT_PROTECTED: 'Административные аккаунты защищены от изменения.',
      PAYMENTS_DISABLED: 'Проверка недоступна: платежи выключены в конфигурации сервера.',
      EXTERNAL_ID_REQUIRED: 'Укажите идентификатор из кабинета провайдера.',
      PAYMENT_EXTERNAL_ID_CONFLICT: 'У платежа уже сохранён другой идентификатор провайдера.',
      PROVIDER_CONFIGURATION_CHANGED:
        'Для сверки нужны исходные настройки магазина и режима платежа.',
      REFUND_NOT_RECORDABLE:
        'Перед записью возврата отмените оплаченную бронь через отмену рейса или разрешённый пассажиру сценарий.',
      REFUND_REFERENCE_USED: 'Этот номер возврата уже использован другой заявкой.',
      REFUND_ALREADY_RECORDED: 'Для заявки уже сохранён другой номер возврата.',
      NOTIFICATION_NOT_RETRYABLE:
        'Уведомление уже изменилось или обрабатывается. Обновите его состояние.',
      ROUTE_NOT_CANCELLABLE: 'Отменять можно только активный рейс.',
    }
    if (messages[error.problem.code]) return messages[error.problem.code]
    if (error.status === 403) return 'Недостаточно прав. Требуется активный аккаунт администратора.'
    if (error.status === 404) return 'Запись не найдена или недоступна.'
    if (error.status === 401) return 'Проверьте вход и повторите действие явно.'
    if (error.status === 422) return 'Проверьте заполненные поля.'
    if (error.status === 409) return 'Состояние изменилось или действие запрещено. Обновите запись.'
    if (error.status === 429) return 'Слишком много запросов. Подождите перед следующей попыткой.'
  }
  return writing
    ? 'Результат не подтверждён. Действие могло выполниться. Обновите запись и проверьте аудит перед повторной попыткой.'
    : 'Не удалось загрузить актуальные данные. Повторите запрос.'
}
