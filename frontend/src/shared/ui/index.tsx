import { useEffect, useId, useSyncExternalStore } from 'react'
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from 'react'
import { Link } from 'react-router'

export function Button({
  children,
  variant = 'primary',
  busy = false,
  disabled,
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary'
  busy?: boolean
}) {
  return (
    <button
      className={`button button--${variant} ${className}`}
      disabled={disabled || busy}
      aria-busy={busy}
      {...props}
    >
      {busy && <span className="button-spinner" aria-hidden="true" />}
      {children}
    </button>
  )
}

export function ButtonLink({
  to,
  children,
  secondary = false,
}: {
  to: string
  children: ReactNode
  secondary?: boolean
}) {
  return (
    <Link className={`button button--${secondary ? 'secondary' : 'primary'}`} to={to}>
      {children}
    </Link>
  )
}

export function Field({
  label,
  error,
  hint,
  id,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { label: string; error?: string; hint?: string }) {
  const generated = useId()
  const inputId = id ?? generated
  const description = error ?? hint
  return (
    <div className="field">
      <label htmlFor={inputId}>{label}</label>
      <input
        id={inputId}
        aria-invalid={error ? true : undefined}
        aria-describedby={description ? `${inputId}-description` : undefined}
        {...props}
      />
      {description && (
        <span id={`${inputId}-description`} className={error ? 'field-error' : 'field-hint'}>
          {description}
        </span>
      )}
    </div>
  )
}

export function Notice({
  title,
  children,
  error = false,
}: {
  title: string
  children?: ReactNode
  error?: boolean
}) {
  return (
    <div className={`notice ${error ? 'notice--error' : ''}`} role={error ? 'alert' : 'status'}>
      <strong>{title}</strong>
      {children && <p>{children}</p>}
    </div>
  )
}

export function Loading({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="loading-block">
      <div role="status">
        <strong>{title}</strong>
        {children && <p>{children}</p>}
      </div>
      <div className="loading-lines" aria-hidden="true">
        <div className="skeleton" />
        <div className="skeleton" />
      </div>
    </div>
  )
}

function subscribeConnection(callback: () => void) {
  window.addEventListener('online', callback)
  window.addEventListener('offline', callback)
  return () => {
    window.removeEventListener('online', callback)
    window.removeEventListener('offline', callback)
  }
}
export function ConnectionStatus() {
  const online = useSyncExternalStore(
    subscribeConnection,
    () => navigator.onLine,
    () => true,
  )
  return online ? null : (
    <div className="connection-status" role="status">
      Нет соединения с сетью. Показанные данные могут устареть. После восстановления сети проверьте
      результат операции перед повторной попыткой.
    </div>
  )
}

export function Arrow() {
  return (
    <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none">
      <path
        d="M5 12h14m-5-5 5 5-5 5"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export function Brand() {
  return (
    <Link className="brand" to="/" aria-label="armatrans — главная">
      <span>armatrans</span>
    </Link>
  )
}

export function PageHeading({
  eyebrow,
  title,
  children,
}: {
  eyebrow: string
  title: string
  children: ReactNode
}) {
  useEffect(() => {
    document.title = `${title} — armatrans`
  }, [title])
  return (
    <div className="page-heading">
      <span className="eyebrow">{eyebrow}</span>
      <h1>{title}</h1>
      <p>{children}</p>
    </div>
  )
}

export function BackHome() {
  return <ButtonLink to="/">На главную</ButtonLink>
}
