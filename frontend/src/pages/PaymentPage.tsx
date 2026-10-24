import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useParams, useSearchParams } from 'react-router'
import { useSession } from '../features/auth/context'
import { remainingSeconds } from '../features/bookings/booking'
import { JourneySummary, BookingSupport } from '../features/bookings/JourneySummary'
import {
  confirmationUrl,
  loadCheckout,
  paymentError,
  paymentKey,
  paymentMessage,
  savedPaymentKey,
} from '../features/payments/payment'
import { isUuid } from '../features/trips/trip'
import '../features/bookings/passenger.css'
import { Button, ButtonLink, Notice, Loading, PageHeading } from '../shared/ui'

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
        query.state.data?.booking.status === 'HELD' ||
        query.state.data?.booking.refund_status === 'OPEN')
        ? 5000
        : false,
  })
  const value = query.data
  const payment = value?.payment
  const active = value?.booking.status === 'HELD' && remainingSeconds(value, now) > 0
  const eligible =
    active &&
    !value?.booking.refund_status &&
    (!payment || (payment.status === 'PENDING' && !payment.review_reason))
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
        fresh.booking.refund_status !== null ||
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
      <PageHeading eyebrow="ОПЛАТА" title="Оплата поездки">
        Сумма, состояние платежа и подтверждение бронирования.
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
        <Loading title="Проверяем оплату…" />
      ) : (
        <div className="passenger-checkout payment-checkout">
          <JourneySummary journey={value.booking} />
          <section className="booking-panel checkout-action payment-panel">
            <div
              role="status"
              className="payment-result"
              data-confirmed={
                payment?.status === 'SUCCEEDED' &&
                !payment.review_reason &&
                !value.booking.refund_status &&
                ['PAID', 'COMPLETED'].includes(value.booking.status)
              }
            >
              <p className="journey-caption">Состояние оплаты</p>
              <h2>{message.title}</h2>
              <p>{message.text}</p>
            </div>
            {active && (
              <p className="payment-countdown">
                До окончания удержания:{' '}
                <span role="timer" aria-live="off">
                  {String(Math.floor(remainingSeconds(value, now) / 60)).padStart(2, '0')}:
                  {String(remainingSeconds(value, now) % 60).padStart(2, '0')}
                </span>
              </p>
            )}
            {eligible && (
              <p className="checkout-reassurance">
                {payment
                  ? 'Если уже оплатили, дождитесь подтверждения. Здесь сохраняется та же попытка оплаты; её состояние можно обновить кнопкой выше.'
                  : 'После подготовки появится ссылка на платёжную страницу. Возвращение на сайт не подтверждает списание — дождитесь результата сервиса.'}
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
              <Notice title="Попытка оплаты сохранена">
                Ожидаем результат. Для продолжения подготовки используйте браузер, в котором
                начинали оплату.
              </Notice>
            )}
            {error && (
              <Notice title="Результат запроса" error>
                {error}
              </Notice>
            )}
            <BookingSupport id={id} />
          </section>
        </div>
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
    <div className="container information-page passenger-page">
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
