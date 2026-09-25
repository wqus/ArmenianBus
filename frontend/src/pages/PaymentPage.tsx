import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useParams, useSearchParams } from 'react-router'
import { useSession } from '../features/auth/context'
import { remainingSeconds } from '../features/bookings/booking'
import {
  confirmationUrl,
  loadCheckout,
  paymentError,
  paymentKey,
  paymentMessage,
  savedPaymentKey,
} from '../features/payments/payment'
import { isUuid } from '../features/trips/trip'
import { formatPrice } from '../features/search/search'
import { Button, ButtonLink, Notice, PageHeading } from '../shared/ui'

function PaymentContent({ id }: { id: string }) {
  const { session, user } = useSession()
  const client = useQueryClient()
  const pending = useRef(false)
  const mounted = useRef(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [now, setNow] = useState(() => performance.now())
  useEffect(() => {
    mounted.current = true
    const timer = window.setInterval(() => setNow(performance.now()), 1000)
    return () => {
      mounted.current = false
      clearInterval(timer)
    }
  }, [])
  const query = useQuery({
    queryKey: ['payment', user?.id, id],
    queryFn: ({ signal }) => loadCheckout(session, id, signal),
    staleTime: 0,
    networkMode: 'always',
    refetchOnWindowFocus: 'always',
    refetchInterval: (query) =>
      !query.state.error &&
      (query.state.data?.payment?.status === 'PENDING' ||
        query.state.data?.booking.status === 'HELD')
        ? 5000
        : false,
  })
  const value = query.data
  const payment = value?.payment
  const active = value?.booking.status === 'HELD' && remainingSeconds(value, now) > 0
  const eligible = active && (!payment || (payment.status === 'PENDING' && !payment.review_reason))
  const url = eligible && payment ? confirmationUrl(payment.confirmation_url) : null
  let canRetry = !payment
  try {
    canRetry = canRetry || Boolean(user && savedPaymentKey(user.id, id))
  } catch {
    canRetry = false
  }

  async function start() {
    if (pending.current || !eligible || query.isFetching || query.isError || !user) return
    pending.current = true
    setBusy(true)
    setError('')
    try {
      // Recheck server state before every explicit attempt. Never POST on mount or redirect return.
      const current = await query.refetch()
      if (!current.data || current.isError) throw new Error('Cannot verify checkout')
      const fresh = current.data
      if (
        fresh.booking.status !== 'HELD' ||
        remainingSeconds(fresh, performance.now()) <= 0 ||
        (fresh.payment &&
          (fresh.payment.status !== 'PENDING' ||
            fresh.payment.review_reason ||
            fresh.payment.confirmation_url))
      )
        return
      let key: string
      try {
        key = await paymentKey(user.id, id, Boolean(fresh.payment))
      } catch {
        setError(
          'Не удалось восстановить или сохранить попытку оплаты. Проверьте статус. Для продолжения незавершённой попытки используйте тот же браузер с доступным хранилищем.',
        )
        return
      }
      if (!mounted.current || session.snapshot().user?.id !== user.id) return
      await session.request(`/bookings/${id}/pay`, {
        method: 'POST',
        headers: { 'Idempotency-Key': key },
      })
    } catch (error) {
      setError(paymentError(error))
    } finally {
      // Ignore POST payload as UI authority, reconcile both records even after a lost response.
      await query.refetch()
      void client.invalidateQueries({ queryKey: ['booking', user?.id, id] })
      void client.invalidateQueries({ queryKey: ['bookings'] })
      setBusy(false)
      pending.current = false
    }
  }
  const message = value && paymentMessage(value.payment, value.booking)
  return (
    <>
      <PageHeading eyebrow="ОПЛАТА" title="Оплата и результат">
        Проверяем платёж и бронирование по данным сервиса.
      </PageHeading>
      <div className="booking-actions">
        <Button
          variant="secondary"
          busy={query.isFetching}
          disabled={busy}
          onClick={() => void query.refetch()}
        >
          Обновить результат
        </Button>
        <ButtonLink secondary to={`/bookings/${id}`}>
          Открыть бронь
        </ButtonLink>
      </div>
      {query.isError ? (
        <Notice title="Не удалось проверить оплату" error>
          Обновите результат. До проверки не повторяйте оплату.
        </Notice>
      ) : !value || !message ? (
        <Notice title="Проверяем оплату…" />
      ) : (
        <section className="booking-panel">
          <div role="status">
            <h2>{message.title}</h2>
            <p>{message.text}</p>
          </div>
          <p>
            {value.booking.origin} → {value.booking.destination} · Место {value.booking.seat_number}
          </p>
          <p className="booking-amount">{formatPrice(value.booking.amount)}</p>
          {active && (
            <p>
              До окончания удержания:{' '}
              <span role="timer" aria-live="off">
                {String(Math.floor(remainingSeconds(value, now) / 60)).padStart(2, '0')}:
                {String(remainingSeconds(value, now) % 60).padStart(2, '0')}
              </span>
            </p>
          )}
          {eligible && !query.isFetching && !busy && url && (
            <a className="button button--primary" href={url} rel="noreferrer">
              Перейти на страницу ЮKassa
            </a>
          )}
          {eligible && !url && !payment?.confirmation_url && canRetry && (
            <Button busy={busy} disabled={query.isFetching} onClick={() => void start()}>
              {payment ? 'Повторить подготовку оплаты' : 'Подготовить оплату'}
            </Button>
          )}
          {eligible && payment?.confirmation_url && !url && (
            <Notice title="Ссылка оплаты недоступна" error>
              Не удалось проверить адрес платёжной страницы. Обновите результат или обратитесь в
              поддержку.
            </Notice>
          )}
          {eligible && payment && !payment.confirmation_url && !canRetry && (
            <Notice title="Платёж уже создан">
              Ожидаем результат. Для продолжения подготовки используйте браузер, в котором начинали
              оплату.
            </Notice>
          )}
          {error && (
            <Notice title="Результат запроса" error>
              {error}
            </Notice>
          )}
          <p className="booking-reference">Номер брони: {id}</p>
        </section>
      )}
      <div className="booking-actions">
        <ButtonLink secondary to="/bookings">
          Мои бронирования
        </ButtonLink>
      </div>
    </>
  )
}

export function PaymentPage({ result = false }: { result?: boolean }) {
  const { id: routeId } = useParams()
  const [params] = useSearchParams()
  const id = result
    ? params.getAll('booking').length === 1
      ? params.get('booking')
      : null
    : routeId
  return (
    <div className="container information-page">
      {isUuid(id) ? (
        <PaymentContent key={id.toLowerCase()} id={id.toLowerCase()} />
      ) : (
        <>
          <PageHeading eyebrow="ОПЛАТА" title="Выберите бронирование">
            Откройте свою бронь, чтобы проверить оплату. Параметры ссылки не подтверждают списание.
          </PageHeading>
          <ButtonLink to="/bookings">Мои бронирования</ButtonLink>
        </>
      )}
    </div>
  )
}
