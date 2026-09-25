import { Navigate, Outlet, useLocation } from 'react-router'
import { Button, ButtonLink, Notice } from '../../shared/ui'
import { useSession } from './context'
import type { Role } from './types'

export function Protected({ role }: { role?: Role }) {
  const { session, status, user, message } = useSession()
  const location = useLocation()
  if (status === 'loading')
    return (
      <div className="container section">
        <Notice title="Проверяем сессию…" />
      </div>
    )
  if (status === 'unavailable')
    return (
      <div className="container section auth-unavailable">
        <Notice title="Не удалось проверить сессию" error>
          {message}
        </Notice>
        <Button onClick={() => void session.restore()}>Попробовать снова</Button>
      </div>
    )
  if (!user)
    return (
      <Navigate
        to={`/login?next=${encodeURIComponent(location.pathname + location.search)}`}
        replace
      />
    )
  if (role && user.role !== role)
    return (
      <div className="container section auth-unavailable">
        <h1>Нет доступа</h1>
        <p>Этот раздел доступен для другой роли аккаунта.</p>
        <ButtonLink to="/account">Мой профиль</ButtonLink>
      </div>
    )
  return <Outlet />
}
