import { useEffect, useRef, useState } from 'react'
import { useSession } from './context'
import { authMessage } from './types'
import { Button, Notice } from '../../shared/ui'

export function EmailVerification() {
  const { session, user } = useSession()
  const [busy, setBusy] = useState(false)
  const [sent, setSent] = useState(false)
  const [error, setError] = useState('')
  const pending = useRef(false)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  async function send() {
    if (pending.current) return
    pending.current = true
    setBusy(true)
    setError('')
    try {
      await session.request('/auth/verification/request', { method: 'POST' })
      if (mounted.current) setSent(true)
    } catch (error) {
      if (mounted.current) setError(authMessage(error))
    } finally {
      pending.current = false
      if (mounted.current) setBusy(false)
    }
  }
  return (
    <section className="account-verification" aria-label="Подтверждение электронной почты">
      <h2>Электронная почта</h2>
      {user?.email_verified_at ? (
        <p>Адрес подтверждён.</p>
      ) : (
        <>
          <p>
            Адрес ещё не подтверждён. Подтвердите его, чтобы проверить, что письма о поездке доходят
            до вас.
          </p>
          {sent ? (
            <Notice title="Проверьте почту">
              Если подтверждение ещё нужно, письмо поставлено в очередь. Проверьте также папку
              «Спам». Ссылка действует 24 часа.
            </Notice>
          ) : (
            <Button variant="secondary" busy={busy} onClick={() => void send()}>
              Подтвердить электронную почту
            </Button>
          )}
          {error && <Notice title={error} error />}
        </>
      )}
    </section>
  )
}
