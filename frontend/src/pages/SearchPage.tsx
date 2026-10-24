import { useEffect, useRef } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useSearchParams } from 'react-router'
import { Button, ButtonLink, Notice, Loading, PageHeading } from '../shared/ui'
import { SearchForm } from '../features/search/SearchForm'
import {
  departureDate,
  departureTime,
  formatPrice,
  MAX_OFFSET,
  PAGE_SIZE,
  readSearch,
  searchError,
  searchRoutes,
  searchUrl,
} from '../features/search/search'
import type { SearchInput, SearchRoute } from '../features/search/search'
import { tripUrl } from '../features/trips/trip'

const countries = { RU: 'Россия', AM: 'Армения' }

function RouteCard({ route, search }: { route: SearchRoute; search: string }) {
  const departure = new Date(route.departure_at)
  return (
    <article
      className="trip-card"
      aria-label={`${route.origin} — ${route.destination}, ${departureTime.format(departure)} UTC`}
    >
      <div className="trip-main">
        <div className="trip-departure">
          <span className="trip-caption">Отправление</span>
          <time dateTime={route.departure_at}>
            <strong>{departureTime.format(departure)}</strong> UTC
          </time>
          <span>{departureDate.format(departure)}</span>
        </div>
        <div className="trip-direction">
          <h3>
            {route.origin} <span aria-hidden="true">→</span> {route.destination}
          </h3>
          <p>{route.company_name}</p>
        </div>
        <div className="trip-price">
          <strong>{formatPrice(route.price)}</strong>
          <span>за одного пассажира</span>
          <span className={`seat-availability ${route.free_seats === 0 ? 'is-sold-out' : ''}`}>
            {route.free_seats === 0 ? 'Свободных мест нет' : `Свободных мест: ${route.free_seats}`}
          </span>
          <ButtonLink to={tripUrl(route.id, search)}>Рейс и места</ButtonLink>
        </div>
      </div>
      <details className="trip-details">
        <summary>Информация о рейсе</summary>
        <dl>
          <div>
            <dt>Направление</dt>
            <dd>
              {countries[route.origin_country]} → {countries[route.destination_country]}
            </dd>
          </div>
          <div>
            <dt>Автобус</dt>
            <dd>{route.bus_name}</dd>
          </div>
          <div>
            <dt>Мест в автобусе</dt>
            <dd>{route.capacity}</dd>
          </div>
        </dl>
      </details>
    </article>
  )
}

function Results({ input, params }: { input: SearchInput; params: URLSearchParams }) {
  const heading = useRef<HTMLHeadingElement>(null)
  const query = useQuery({
    queryKey: ['public-routes', input],
    queryFn: ({ signal }) => searchRoutes(input, signal),
    staleTime: 0,
    networkMode: 'always',
  })
  useEffect(() => {
    heading.current?.focus()
  }, [input.origin, input.destination, input.date, input.offset])
  const data = query.data
  return (
    <>
      <SearchForm
        key={params.toString()}
        initial={params}
        onRepeat={() => {
          void query.refetch()
        }}
      />
      <section className="search-results" aria-labelledby="results-title">
        <div className="results-heading">
          <div>
            <h2 id="results-title" ref={heading} tabIndex={-1}>
              Рейсы по вашему направлению
            </h2>
            <p>По времени отправления · UTC</p>
          </div>
          <Button
            variant="secondary"
            busy={query.isFetching}
            onClick={() => {
              void query.refetch()
            }}
          >
            Обновить рейсы
          </Button>
        </div>
        <div aria-live="polite" className="sr-only">
          {query.isFetching
            ? 'Ищем рейсы'
            : query.isError
              ? 'Ошибка поиска'
              : `Рейсов на странице: ${data?.items.length ?? 0}`}
        </div>
        {query.isFetching ? (
          <Loading title="Ищем рейсы…">Проверяем расписание и свободные места.</Loading>
        ) : query.isError ? (
          <Notice title="Не удалось загрузить рейсы" error>
            {searchError(query.error)}
          </Notice>
        ) : (
          data && (
            <>
              {data.items.length === 0 ? (
                <Notice
                  title={input.offset ? 'На этой странице рейсов больше нет' : 'Рейсов не найдено'}
                >
                  Попробуйте другую дату или выберите города из подсказок. Доступны русские,
                  английские и армянские названия.
                </Notice>
              ) : (
                <>
                  <p className="availability-note">
                    Места и цены могут измениться. Поиск не закрепляет место за вами.
                  </p>
                  <div className="trip-list">
                    {data.items.map((route) => (
                      <RouteCard key={route.id} route={route} search={params.toString()} />
                    ))}
                  </div>
                </>
              )}
              {(input.offset > 0 || data.hasNext) && (
                <nav className="search-pagination" aria-label="Страницы результатов">
                  {input.offset > 0 && (
                    <ButtonLink
                      secondary
                      to={searchUrl({ ...input, offset: input.offset - PAGE_SIZE })}
                    >
                      Предыдущая страница
                    </ButtonLink>
                  )}
                  <span>Страница {input.offset / PAGE_SIZE + 1}</span>
                  {data.hasNext && input.offset < MAX_OFFSET && (
                    <ButtonLink
                      secondary
                      to={searchUrl({ ...input, offset: input.offset + PAGE_SIZE })}
                    >
                      Следующая страница
                    </ButtonLink>
                  )}
                </nav>
              )}
              {data.hasNext && input.offset === MAX_OFFSET && (
                <Notice title="Достигнут предел выдачи">
                  Уточните направление или выберите другую дату.
                </Notice>
              )}
            </>
          )
        )}
      </section>
    </>
  )
}

export function SearchPage() {
  const [params] = useSearchParams()
  const input = readSearch(params)
  return (
    <div className="container search-page">
      <PageHeading eyebrow="РОССИЯ ↔ АРМЕНИЯ" title="Найдите свою поездку">
        Выберите направление и дату. Сравните рейсы по времени, цене и свободным местам.
      </PageHeading>
      {input ? (
        <Results input={input} params={params} />
      ) : (
        <>
          <SearchForm key={params.toString()} initial={params} />
          <Notice title={params.size ? 'Проверьте параметры поиска' : 'Куда отправимся?'}>
            Укажите город отправления, город прибытия и дату.
          </Notice>
        </>
      )}
    </div>
  )
}
