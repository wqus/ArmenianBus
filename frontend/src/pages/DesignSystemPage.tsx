import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { apiRequest } from '../shared/api/client'
import { Button, Field, Notice, PageHeading } from '../shared/ui'

export default function DesignSystemPage() {
  const [value, setValue] = useState('')
  const health = useQuery({
    queryKey: ['readiness'],
    queryFn: ({ signal }) => apiRequest<{ status: string }>('/health/ready', { signal }),
    staleTime: 0,
  })
  return (
    <div className="container information-page">
      <PageHeading eyebrow="ТОЛЬКО В РЕЖИМЕ РАЗРАБОТКИ" title="Дизайн-система">
        Компоненты F1 и проверка подключения к локальному API.
      </PageHeading>
      <div className="showcase-grid">
        <section className="step-card">
          <h2>Кнопки</h2>
          <div className="showcase-stack">
            <Button>Продолжить</Button>
            <Button variant="secondary">Назад</Button>
            <Button busy>Ожидание</Button>
            <Button disabled>Недоступно</Button>
          </div>
        </section>
        <section className="step-card">
          <h2>Поля</h2>
          <div className="showcase-stack">
            <Field
              label="Город отправления"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              hint="Введите название города"
            />
            <Field
              label="Электронная почта"
              type="email"
              error="Укажите корректный адрес"
              defaultValue="example"
            />
            <Field label="Дата поездки" type="date" />
          </div>
        </section>
        <section className="step-card">
          <h2>Состояния</h2>
          <div className="showcase-stack">
            <Notice title="Здесь пока нет поездок">
              После бронирования поездка появится в этом разделе.
            </Notice>
            <div className="skeleton" aria-label="Загрузка данных" role="status" />
            <Notice title="Место уже занято" error>
              Выберите другое свободное место.
            </Notice>
          </div>
        </section>
      </div>
      <section className="information-note">
        <h2>Подключение API</h2>
        {health.isPending ? (
          <Notice title="Проверяем соединение…" />
        ) : health.isError ? (
          <Notice title="API недоступен" error>
            {health.error.message}
          </Notice>
        ) : (
          <Notice title="API подключён">Readiness: {health.data.status}</Notice>
        )}
        <Button variant="secondary" busy={health.isFetching} onClick={() => void health.refetch()}>
          Проверить снова
        </Button>
      </section>
    </div>
  )
}
