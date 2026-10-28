import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { apiRequest, ApiError } from '../shared/api/client'
import { Button, ButtonLink, Field, Notice, PageHeading } from '../shared/ui'
import { useSession } from '../features/auth/context'
import { authMessage } from '../features/auth/types'
import { actionLinkToken } from '../features/auth/action-link'
import '../features/auth/account.css'

export function RecoveryPage({ mode }: { mode: 'request' | 'reset' | 'verify' }) {
  const location = useLocation()
  const [seen, setSeen] = useState({ hash: location.hash, version: 0 })
  // A new email link can arrive as same-document hash navigation. Remount the form
  // for that explicit new link, but retain its state when we remove the fragment.
  if (seen.hash !== location.hash)
    setSeen({ hash: location.hash, version: seen.version + (location.hash ? 1 : 0) })
  return (
    <RecoveryContent
      key={`${mode}:${seen.version}`}
      mode={mode}
      initialToken={actionLinkToken(location.hash)}
    />
  )
}

function RecoveryContent({
  mode,
  initialToken,
}: {
  mode: 'request' | 'reset' | 'verify'
  initialToken: string | null
}) {
  const location = useLocation()
  const navigate = useNavigate()
  const { session } = useSession()
  const [token, setToken] = useState(initialToken)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)
  const [uncertain, setUncertain] = useState(false)
  const [invalid, setInvalid] = useState(false)
  const [error, setError] = useState('')
  const pending = useRef(false)
  const mounted = useRef(true)
  const errorFocus = useRef<HTMLDivElement>(null)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  useEffect(() => {
    // Capture once in memory; strip the capability from browser history before any POST.
    if (location.hash || (mode !== 'request' && location.search))
      navigate(location.pathname, { replace: true })
  }, [location.hash, location.pathname, location.search, mode, navigate])
  useEffect(() => {
    if (error) errorFocus.current?.focus()
  }, [error])
  const request = mode === 'request'
  const reset = mode === 'reset'
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (pending.current || done || uncertain || invalid || (!request && !token)) return
    const data = new FormData(event.currentTarget)
    const password = String(data.get('password') ?? '')
    if (
      reset &&
      (password.length < 12 || password.length > 128 || password !== data.get('confirmation'))
    ) {
      setError('Введите одинаковые пароли длиной от 12 до 128 символов.')
      return
    }
    pending.current = true
    setBusy(true)
    setError('')
    try {
      await apiRequest(
        request
          ? '/auth/forgot-password'
          : reset
            ? '/auth/web/reset-password'
            : '/auth/verify-email',
        {
          method: 'POST',
          ...(reset ? { credentials: 'same-origin', headers: { 'X-ArmeniaBus-Web': '1' } } : {}),
          body: JSON.stringify(
            request
              ? { email: String(data.get('email')).trim() }
              : reset
                ? { token, password }
                : { token },
          ),
        },
      )
      if (reset) session.forget()
      if (!mounted.current) return
      setDone(true)
      setToken(null)
      if (mode === 'verify') {
        try {
          await session.reloadUser()
        } catch {
          /* Email is verified even if profile refresh fails. */
        }
      }
    } catch (error) {
      if (!mounted.current) return
      if (!request && (!(error instanceof ApiError) || error.status === 0 || error.status >= 500)) {
        setUncertain(true)
        setToken(null)
        setError(
          reset
            ? 'Ответ не получен, но пароль мог измениться. Попробуйте войти с новым паролем; если не получится, запросите новую ссылку.'
            : 'Ответ не получен, но почта могла подтвердиться. Проверьте профиль или запросите новое письмо.',
        )
      } else {
        setError(authMessage(error))
        if (error instanceof ApiError && error.problem.code === 'ACTION_LINK_INVALID') {
          setInvalid(true)
          setToken(null)
        }
      }
    } finally {
      pending.current = false
      if (mounted.current) setBusy(false)
    }
  }
  return (
    <div className="container auth-layout calm-auth recovery-layout">
      <aside className="auth-aside">
        <span className="eyebrow">ARMATRANS · ВАШ АККАУНТ</span>
        <h2>Снова к вашим поездкам.</h2>
        <p>Доступ к бронированиям и письмам о поездке. Никому не пересылайте ссылки из писем.</p>
      </aside>
      <section className="auth-panel">
        <PageHeading
          eyebrow="ДОСТУП К АККАУНТУ"
          title={request ? 'Забыли пароль?' : reset ? 'Новый пароль' : 'Подтверждение почты'}
        >
          {request
            ? 'Укажите почту, которую использовали при регистрации.'
            : reset
              ? 'Придумайте новый пароль. После смены потребуется войти заново.'
              : 'Подтвердите адрес нажатием кнопки ниже.'}
        </PageHeading>
        {error && (
          <div ref={errorFocus} tabIndex={-1}>
            <Notice title={error} error />
          </div>
        )}
        {done ? (
          <Notice
            title={request ? 'Проверьте почту' : reset ? 'Пароль изменён' : 'Почта подтверждена'}
          >
            {request
              ? 'Если аккаунт с таким адресом доступен, письмо будет отправлено. Проверьте «Входящие» и «Спам». Ссылка действует 30 минут.'
              : reset
                ? 'Старые сессии завершены. Войдите с новым паролем.'
                : 'Теперь этот адрес отмечен как подтверждённый. Можно вернуться в профиль.'}
          </Notice>
        ) : !request && !token && !error ? (
          <Notice title="Ссылка недоступна" error>
            Откройте полную ссылку из письма или запросите новое письмо.
          </Notice>
        ) : !uncertain && !invalid && (request || token) ? (
          <form className="auth-form" onSubmit={(event) => void submit(event)}>
            <fieldset disabled={busy}>
              {request && (
                <Field
                  name="email"
                  label="Электронная почта"
                  type="email"
                  autoComplete="username"
                  autoCapitalize="none"
                  spellCheck={false}
                  required
                  maxLength={320}
                />
              )}
              {reset && (
                <>
                  <Field
                    name="password"
                    label="Новый пароль"
                    type="password"
                    autoComplete="new-password"
                    minLength={12}
                    maxLength={128}
                    required
                    hint="От 12 до 128 символов."
                  />
                  <Field
                    name="confirmation"
                    label="Повторите новый пароль"
                    type="password"
                    autoComplete="new-password"
                    minLength={12}
                    maxLength={128}
                    required
                  />
                </>
              )}
              <Button type="submit" busy={busy}>
                {request
                  ? 'Получить ссылку'
                  : reset
                    ? 'Сохранить новый пароль'
                    : 'Подтвердить почту'}
              </Button>
            </fieldset>
          </form>
        ) : null}
        <div className="profile-actions">
          {request && done && (
            <Button
              variant="secondary"
              onClick={() => {
                setDone(false)
                setError('')
              }}
            >
              Указать другой адрес
            </Button>
          )}
          <ButtonLink secondary to="/login">
            Войти в аккаунт
          </ButtonLink>
          {!request && (
            <ButtonLink secondary to={reset ? '/forgot-password' : '/account'}>
              {reset ? 'Запросить новую ссылку' : 'Мой профиль'}
            </ButtonLink>
          )}
        </div>
        <p className="auth-switch">
          Нет доступа к почте? <a href="mailto:support@mathbot.site">Напишите в поддержку</a>.
        </p>
      </section>
    </div>
  )
}
