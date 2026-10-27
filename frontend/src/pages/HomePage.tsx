import { useEffect } from 'react'
import { Link } from 'react-router'
import { SearchForm } from '../features/search/SearchForm'
import khorVirap from '../shared/assets/armenia-khor-virap-1920.webp'
import khorVirapSmall from '../shared/assets/armenia-khor-virap-960.webp'

export function HomePage() {
  useEffect(() => {
    document.title = 'armatrans — автобусные рейсы Россия — Армения'
  }, [])
  return (
    <>
      <section className="travel-hero" aria-labelledby="travel-title">
        <img
          className="travel-hero-photo"
          src={khorVirap}
          srcSet={`${khorVirapSmall} 960w, ${khorVirap} 1920w`}
          sizes="100vw"
          alt="Монастырь Хор Вирап в Армении на фоне Арарата"
          width="1920"
          height="1276"
          fetchPriority="high"
        />
        <div className="container travel-hero-copy">
          <p className="travel-place" lang="hy">
            Հայաստան
          </p>
          <h1 id="travel-title">
            Автобусные рейсы
            <br />
            Россия — Армения
          </h1>
          <p className="travel-intro">
            К близким, по делам или навстречу новым местам. Выберите свой рейс между Россией и
            Арменией.
          </p>
          <a className="travel-search-link" href="#search">
            Найти свою поездку <span aria-hidden="true">↓</span>
          </a>
        </div>
      </section>
      <p className="container travel-photo-credit">
        Хор Вирап, Армения ·{' '}
        <a href="https://commons.wikimedia.org/wiki/File:Mount_Ararat_and_Khor_Virap_Monastery,_Ararat_Plain,_Armenia.jpg">
          Фото: Vyacheslav Argenberg
        </a>
        {' · '}
        <a href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a>
        {' · '}кадрировано, затемнено
      </p>
      <section className="container home-search" id="search" aria-labelledby="search-title">
        <h2 id="search-title">Куда отправимся?</h2>
        <p className="home-search-intro">Выберите города и дату — покажем подходящие рейсы.</p>
        <SearchForm />
      </section>
      <section className="container travel-help" id="journey" aria-labelledby="journey-title">
        <div>
          <h2 id="journey-title">Перед бронированием</h2>
          <p>
            Сравните время и стоимость, выберите свободное место. Детали бронирования останутся в
            личном кабинете.
          </p>
        </div>
        <div className="travel-questions">
          <details>
            <summary>Какое время указано в расписании?</summary>
            <p>
              Дата и время указаны по городу отправления. Перед поездкой проверьте точный адрес
              посадки в своей брони.
            </p>
          </details>
          <details>
            <summary>Когда место закрепляется за мной?</summary>
            <p>
              После подтверждения бронирования место удерживается на 10 минут. Чтобы подтвердить
              поездку, завершите оплату до окончания этого срока.
            </p>
          </details>
          <Link className="travel-info-link" to="/help">
            Все вопросы о поездке
          </Link>
        </div>
      </section>
      <section className="container travel-carriers" aria-labelledby="travel-carriers-title">
        <div>
          <h2 id="travel-carriers-title">Для перевозчиков</h2>
          <p>Автобусы, расписание и бронирования ваших пассажиров в одном кабинете.</p>
        </div>
        <Link className="travel-info-link" to="/carriers">
          О работе с armatrans
        </Link>
      </section>
    </>
  )
}
