import { useQuery } from '@tanstack/react-query'
import { NavLink, Outlet } from 'react-router'
import { useSession } from '../auth/context'
import { carrierError, readCarrier } from './contracts'
import { Button, ButtonLink, Notice } from '../../shared/ui'

export function CarrierLayout() {
  const { session, user } = useSession()
  const profile = useQuery({
    queryKey: ['carrier-profile', user?.id],
    queryFn: async ({ signal }) => readCarrier(await session.request('/carriers/me', { signal })),
    staleTime: 0,
    networkMode: 'always',
    refetchOnWindowFocus: 'always',
    refetchInterval: 15000,
  })
  return (
    <div className="container information-page">
      <nav className="carrier-nav" aria-label="Кабинет перевозчика">
        <NavLink to="/carrier" end>
          Компания
        </NavLink>
        <NavLink to="/carrier/buses">Автобусы</NavLink>
        <NavLink to="/carrier/routes">Рейсы</NavLink>
        <NavLink to="/carrier/bookings">Бронирования</NavLink>
      </nav>
      {profile.isError ? (
        <Notice title="Не удалось проверить профиль" error>
          {carrierError(profile.error)}
        </Notice>
      ) : !profile.data ? (
        <Notice title="Проверяем профиль…" />
      ) : profile.data.status !== 'ACTIVE' ? (
        <Notice
          title={
            profile.data.status === 'PENDING' ? 'Ожидается активация' : 'Операции приостановлены'
          }
        >
          Управление доступно после активации профиля администратором.
        </Notice>
      ) : (
        <Outlet />
      )}
      {(profile.isError || profile.data?.status !== 'ACTIVE') && (
        <div className="booking-actions">
          <Button busy={profile.isFetching} onClick={() => void profile.refetch()}>
            Проверить активацию
          </Button>
          <ButtonLink secondary to="/carrier">
            Профиль компании
          </ButtonLink>
        </div>
      )}
    </div>
  )
}
