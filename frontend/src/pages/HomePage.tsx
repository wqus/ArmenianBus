import { useEffect } from 'react'
import { Arrow, ButtonLink } from '../shared/ui'
import { MountainRoad } from '../shared/ui/MountainRoad'
import { SearchForm } from '../features/search/SearchForm'

const steps = [
  {
    number: '01',
    title: 'Выберите свой рейс',
    text: 'Город отправления, направление и дата. Сравните время, стоимость и доступные места.',
  },
  {
    number: '02',
    title: 'Забронируйте место',
    text: 'Выберите конкретное место в автобусе. Оно временно закрепляется за вами на время оплаты.',
  },
  {
    number: '03',
    title: 'Сохраните поездку',
    text: 'После подтверждения оплаты информация о бронировании останется в личном кабинете.',
  },
]

export function HomePage() {
  useEffect(() => {
    document.title = 'armatrans — автобусные рейсы Россия — Армения'
  }, [])
  return (
    <>
      <section className="container hero">
        <div className="hero-copy">
          <span className="eyebrow">
            <span className="small-dot" /> АВТОБУСНЫЕ ПОЕЗДКИ · РОССИЯ ↔ АРМЕНИЯ
          </span>
          <h1>
            Дорога, которая
            <br />
            <span>сближает.</span>
          </h1>
          <p className="hero-description">
            К родным, новым местам и важным встречам.
            <br className="desktop-break" /> Поездки между Россией и Арменией —
            <br className="desktop-break" /> с вниманием к каждому шагу.
          </p>
          <div className="hero-actions">
            <a className="button button--primary" href="#search">
              Найти поездку <Arrow />
            </a>
            <a className="button button--secondary" href="#journey">
              Как устроена поездка <Arrow />
            </a>
          </div>
          <div className="hero-note">
            <span className="note-icon" aria-hidden="true">
              ↔
            </span>
            <span>
              Два направления.
              <br />
              <strong>Много поводов встретиться.</strong>
            </span>
          </div>
        </div>
        <div className="hero-art">
          <MountainRoad />
          <div className="scene-label">
            <span className="small-dot" /> ВПЕРЕДИ — ВАША ИСТОРИЯ
          </div>
          <div className="scene-caption">
            <span>Россия</span>
            <span className="route-line" aria-hidden="true">
              ○ ─────── ○
            </span>
            <span>Армения</span>
          </div>
        </div>
      </section>
      <section className="container home-search" id="search" aria-labelledby="search-title">
        <h2 id="search-title">Куда отправимся?</h2>
        <SearchForm />
      </section>
      <div className="container">
        <div className="principles">
          <span>
            <span aria-hidden="true">◎</span> Конкретное место в автобусе
          </span>
          <span>
            <span aria-hidden="true">◇</span> Стоимость до оплаты
          </span>
          <span>
            <span aria-hidden="true">↗</span> Поездки в одном кабинете
          </span>
        </div>
      </div>
      <section className="container section" id="journey">
        <div className="section-heading">
          <div>
            <span className="eyebrow">ОТ ПЛАНОВ — К ПОЕЗДКЕ</span>
            <h2>Всё начинается с трёх шагов</h2>
          </div>
          <p>
            Понятный путь от выбора рейса
            <br />
            до подтверждённого бронирования.
          </p>
        </div>
        <div className="step-grid">
          {steps.map((step) => (
            <article className="step-card" key={step.number}>
              <span className="step-number">{step.number}</span>
              <h3>{step.title}</h3>
              <p>{step.text}</p>
            </article>
          ))}
        </div>
      </section>
      <section className="container bottom-section">
        <div className="carrier-banner">
          <div>
            <span className="eyebrow">ДЛЯ ПЕРЕВОЗЧИКОВ</span>
            <h2>Ваши рейсы. Новые пассажиры.</h2>
            <p>Управляйте автобусами, местами и поездками в armatrans.</p>
          </div>
          <ButtonLink to="/carriers" secondary>
            О работе с сервисом <Arrow />
          </ButtonLink>
        </div>
      </section>
    </>
  )
}
