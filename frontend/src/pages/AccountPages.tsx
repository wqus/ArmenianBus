import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router'
import { useSession } from '../features/auth/context'
import { authMessage, roleLabels } from '../features/auth/types'
import { Button, ButtonLink, Notice, PageHeading } from '../shared/ui'
import { readCarrier } from '../features/carrier/contracts'

export function AccountPage() {
  const { session, user } = useSession()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const navigate = useNavigate()
  if (!user) return null
  async function logout() {
    setBusy(true)
    setError('')
    try {
      await session.logout()
      navigate('/login', { replace: true })
    } catch (failure) {
      setError(`Не удалось выйти. ${authMessage(failure)}`)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="container information-page">
      <PageHeading eyebrow="ЛИЧНЫЙ КАБИНЕТ" title="Мой профиль">
        Данные вашего аккаунта в ArmeniaBus.
      </PageHeading>
      <section className="profile-card">
        <dl>
          <div>
            <dt>Электронная почта</dt>
            <dd>{user.email}</dd>
          </div>
          <div>
            <dt>Роль</dt>
            <dd>{roleLabels[user.role]}</dd>
          </div>
          <div>
            <dt>Аккаунт</dt>
            <dd>Активен</dd>
          </div>
        </dl>
        <div className="profile-actions">
          {user.role === 'PASSENGER' && <ButtonLink to="/bookings">Мои бронирования</ButtonLink>}
          {user.role === 'CARRIER' && <ButtonLink to="/carrier">Профиль перевозчика</ButtonLink>}
          {user.role === 'ADMIN' && <ButtonLink to="/admin">Кабинет администратора</ButtonLink>}
          <Button variant="secondary" busy={busy} onClick={() => void logout()}>
            Выйти из аккаунта
          </Button>
        </div>
        {error && <Notice title={error} error />}
      </section>
    </div>
  )
}

export function CarrierProfilePage() {
  const { session, user } = useSession()
  const profile = useQuery({
    queryKey: ['carrier-profile', user?.id],
    queryFn: async ({ signal }) => readCarrier(await session.request('/carriers/me', { signal })),
  })
  const labels = {
    PENDING: 'Ожидает проверки',
    ACTIVE: 'Профиль активирован',
    BLOCKED: 'Профиль заблокирован',
  }
  return (
    <div className="container information-page">
      <PageHeading eyebrow="ПЕРЕВОЗЧИКУ" title="Профиль компании">
        Контактные данные и результат проверки профиля.
      </PageHeading>
      {profile.isPending ? (
        <Notice title="Загружаем профиль…" />
      ) : profile.isError ? (
        <div className="auth-unavailable">
          <Notice title={authMessage(profile.error)} error />
          <Button onClick={() => void profile.refetch()}>Попробовать снова</Button>
        </div>
      ) : (
        <section className="profile-card">
          <dl>
            <div>
              <dt>Компания</dt>
              <dd>{profile.data.company_name}</dd>
            </div>
            <div>
              <dt>Телефон</dt>
              <dd>{profile.data.phone}</dd>
            </div>
          </dl>
          <Notice title={labels[profile.data.status]} error={profile.data.status === 'BLOCKED'}>
            {profile.data.status === 'PENDING'
              ? 'Администратор проверяет данные. После активации вы сможете публиковать рейсы.'
              : profile.data.status === 'BLOCKED'
                ? 'Операции перевозчика приостановлены. Обратитесь к администратору.'
                : 'Данные компании прошли проверку.'}
          </Notice>
          {profile.data.status === 'ACTIVE' && (
            <div className="profile-actions">
              <ButtonLink to="/carrier/buses">Автобусы</ButtonLink>
              <ButtonLink to="/carrier/routes">Рейсы</ButtonLink>
              <ButtonLink to="/carrier/bookings">Бронирования</ButtonLink>
            </div>
          )}
        </section>
      )}
      <div className="page-back">
        <ButtonLink to="/account" secondary>
          Мой профиль
        </ButtonLink>
      </div>
    </div>
  )
}
