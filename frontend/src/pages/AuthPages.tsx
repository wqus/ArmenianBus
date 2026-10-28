import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { Link, Navigate, useLocation, useNavigate, useSearchParams } from 'react-router'
import { Button, Field, Notice, PageHeading } from '../shared/ui'
import { apiRequest, ApiError } from '../shared/api/client'
import { useSession } from '../features/auth/context'
import { authMessage, safeReturnTo } from '../features/auth/types'
import '../features/auth/account.css'

function fieldErrors(error: unknown): Record<string, string> {
  if (!(error instanceof ApiError) || error.status !== 422 || !Array.isArray(error.problem.details))
    return {}
  const fields: Record<string, string> = {}
  for (const detail of error.problem.details) {
    if (typeof detail?.field !== 'string') continue
    const name = detail.field.split('.').at(-1)
    const messages: Record<string, string> = {
      email: 'Укажите корректную электронную почту.',
      password: 'Пароль должен содержать от 12 до 128 символов.',
      company_name: 'Укажите название компании (до 200 символов).',
      phone: 'Формат: + и от 8 до 15 цифр.',
    }
    if (messages[name]) fields[name] = messages[name]
  }
  return fields
}

export function AuthPage({ register = false }: { register?: boolean }) {
  const { session, status, user, message } = useSession()
  const [params] = useSearchParams()
  const next = safeReturnTo(params.get('next'))
  const navigate = useNavigate()
  const location = useLocation()
  const [role, setRole] = useState<'PASSENGER' | 'CARRIER'>(
    params.get('role') === 'carrier' ? 'CARRIER' : 'PASSENGER',
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [fields, setFields] = useState<Record<string, string>>({})
  const errorElement = useRef<HTMLDivElement>(null)
  const [showPassword, setShowPassword] = useState(false)
  const pending = useRef(false)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const registration = location.state as { registered?: boolean; email?: string } | null
  useEffect(() => {
    if (error) errorElement.current?.focus()
  }, [error])

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (pending.current) return
    pending.current = true
    const data = new FormData(event.currentTarget)
    setBusy(true)
    setError('')
    setFields({})
    const email = String(data.get('email')).trim()
    const password = String(data.get('password'))
    try {
      if (register) {
        await apiRequest('/auth/register', {
          method: 'POST',
          body: JSON.stringify({
            email,
            password,
            role,
            ...(role === 'CARRIER'
              ? {
                  company_name: String(data.get('company_name')).trim(),
                  phone: String(data.get('phone')).trim(),
                }
              : {}),
          }),
        })
        if (!mounted.current) return
        navigate(
          `/login?next=${encodeURIComponent(next)}${role === 'CARRIER' ? '&role=carrier' : ''}`,
          {
            replace: true,
            state: { registered: true, email },
          },
        )
      } else {
        await session.login({ email, password })
        if (mounted.current) navigate(next, { replace: true })
      }
    } catch (failure) {
      if (mounted.current) {
        setError(authMessage(failure))
        setFields(fieldErrors(failure))
      }
    } finally {
      pending.current = false
      if (mounted.current) setBusy(false)
    }
  }

  if (status === 'authenticated' && user) return <Navigate to={next} replace />
  return (
    <div className="container auth-layout calm-auth">
      <aside className="auth-aside">
        <span className="eyebrow">ARMATRANS · РОССИЯ ↔ АРМЕНИЯ</span>
        <h2>
          {register
            ? role === 'CARRIER'
              ? 'Рабочий кабинет перевозчика.'
              : 'Бронирования в одном месте.'
            : 'Вернуться к поездке.'}
        </h2>
        <p>
          {register && role === 'CARRIER'
            ? 'Автопарк, публикация рейсов и бронирования пассажиров — в кабинете компании.'
            : 'Сохранённые бронирования, состояние оплаты и история поездок в одном аккаунте.'}
        </p>
        <div className="auth-aside-note">
          <span aria-hidden="true">↔</span>
          <p>
            Россия и Армения.
            <br />
            Ближе друг к другу.
          </p>
        </div>
      </aside>
      <section className="auth-panel">
        <PageHeading
          eyebrow={register ? 'НОВЫЙ АККАУНТ' : 'ЛИЧНЫЙ КАБИНЕТ'}
          title={register ? 'Регистрация' : 'Вход'}
        >
          {register ? 'Выберите роль и заполните данные.' : 'Введите электронную почту и пароль.'}
        </PageHeading>
        {status === 'loading' && !busy ? (
          <Notice title="Проверяем сессию…" />
        ) : (
          <>
            {!register && registration?.registered && (
              <Notice title="Аккаунт создан">Войдите с указанной почтой и паролем.</Notice>
            )}
            {message && !error && <Notice title={message} error />}
            {error && (
              <div ref={errorElement} tabIndex={-1}>
                <Notice title={error} error />
              </div>
            )}
            <form onSubmit={submit} className="auth-form">
              <fieldset disabled={busy}>
                {register && (
                  <fieldset className="role-choice" aria-describedby="auth-role-hint">
                    <legend>Я регистрируюсь как</legend>
                    <label>
                      <input
                        type="radio"
                        name="role"
                        value="PASSENGER"
                        checked={role === 'PASSENGER'}
                        onChange={() => setRole('PASSENGER')}
                      />
                      Пассажир
                    </label>
                    <label>
                      <input
                        type="radio"
                        name="role"
                        value="CARRIER"
                        checked={role === 'CARRIER'}
                        onChange={() => setRole('CARRIER')}
                      />
                      Перевозчик
                    </label>
                  </fieldset>
                )}
                {register && (
                  <p id="auth-role-hint" className="auth-role-hint">
                    {role === 'PASSENGER'
                      ? 'Для поиска, бронирования и оплаты поездок выберите роль пассажира.'
                      : 'Для управления транспортом, публикации рейсов и просмотра бронирований пассажиров.'}
                  </p>
                )}
                {register && role === 'CARRIER' && (
                  <>
                    <Field
                      label="Название компании"
                      name="company_name"
                      required
                      maxLength={200}
                      autoComplete="organization"
                      error={fields.company_name}
                    />
                    <Field
                      label="Контактный телефон"
                      name="phone"
                      type="tel"
                      required
                      pattern="\+[1-9][0-9]{7,14}"
                      autoComplete="tel"
                      hint="Например, +37499123456"
                      error={fields.phone}
                    />
                    <Notice title="Проверка перевозчика">
                      После регистрации администратор проверит профиль. До активации публикация
                      рейсов недоступна.
                    </Notice>
                  </>
                )}
                <Field
                  label="Электронная почта"
                  name="email"
                  type="email"
                  required
                  autoComplete="username"
                  autoCapitalize="none"
                  spellCheck={false}
                  maxLength={320}
                  defaultValue={!register ? (registration?.email ?? '') : ''}
                  error={fields.email}
                />
                <div>
                  <Field
                    label="Пароль"
                    name="password"
                    type={showPassword ? 'text' : 'password'}
                    required
                    minLength={register ? 12 : undefined}
                    maxLength={128}
                    autoComplete={register ? 'new-password' : 'current-password'}
                    hint={
                      register
                        ? 'От 12 до 128 символов. Не используйте пароль от других сервисов.'
                        : undefined
                    }
                    error={fields.password}
                  />
                  <button
                    className="password-toggle"
                    type="button"
                    aria-pressed={showPassword}
                    onClick={() => setShowPassword(!showPassword)}
                  >
                    {showPassword ? 'Скрыть пароль' : 'Показать пароль'}
                  </button>
                </div>
                <Button type="submit" busy={busy}>
                  {register ? 'Создать аккаунт' : 'Войти'}
                </Button>
              </fieldset>
            </form>
            {!register && (
              <p className="auth-switch">
                <Link to="/forgot-password">Забыли пароль?</Link>
              </p>
            )}
            <p className="auth-switch">
              {register ? 'Уже есть аккаунт?' : 'Впервые здесь?'}{' '}
              <Link
                to={`${register ? '/login' : '/register'}?next=${encodeURIComponent(next)}${role === 'CARRIER' ? '&role=carrier' : ''}`}
              >
                {register ? 'Войти' : 'Зарегистрироваться'}
              </Link>
            </p>
            {register && (
              <p className="auth-switch auth-legal">
                Для ознакомления: <Link to="/terms">условия использования</Link> и{' '}
                <Link to="/privacy">конфиденциальность</Link>. Пока это черновики для тестирования.
              </p>
            )}
          </>
        )}
      </section>
    </div>
  )
}
