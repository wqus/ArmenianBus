import { CityInput } from '../features/cities/CityInput'
import { cityName } from '../features/cities/catalog'
import { useEffect, useRef, useState } from 'react'
import './concepts.css'
import './calm.css'
import khorVirap from './assets/armenia-khor-virap-1920.webp'
import khorVirapSmall from './assets/armenia-khor-virap-960.webp'
import garni from './assets/armenia-garni-1920.webp'
import garniSmall from './assets/armenia-garni-960.webp'

const concepts = {
  calm: {
    number: '04',
    name: 'Просто о поездке',
    subtitle: 'К новым местам и близким людям.',
    description:
      'Переработанный спокойный вариант: поиск на первом экране, обычная типографика, самостоятельные фотографии и конкретные тексты. Без текста поверх фото и рекламных слоганов.',
    heading: (
      <>
        Автобусные рейсы
        <br />
        Россия — Армения
      </>
    ),
    detail: 'Выберите направление и дату отправления. Затем можно сравнить рейсы и выбрать место.',
    motif: 'Дорога к близким',
  },
  transit: {
    number: '01',
    name: 'Маршрут',
    subtitle: 'Точная навигация. Ясные решения.',
    description:
      'Графит, сигнальный лайм, крупные цифры. Вдохновение — транспортная навигация и табло отправлений. Самое функциональное направление.',
    heading: (
      <>
        Ближе.
        <br />
        По дороге.
      </>
    ),
    detail: 'Москва → Ереван. Найдите рейс, выберите место и отправляйтесь к своим.',
    motif: 'Линия, которая соединяет',
  },
  editorial: {
    number: '02',
    name: 'Тёплый путь',
    subtitle: 'У каждой дороги — своя история.',
    description:
      'Бумажные оттенки, терракота, выразительная антиква. Редакционная композиция и контур гор вместо привычного набора карточек.',
    heading: (
      <>
        Есть дороги,
        <br />
        <em>которые сближают.</em>
      </>
    ),
    detail: 'К родным, новым местам и важным встречам. Ваша следующая поездка начинается здесь.',
    motif: 'За поворотом — встреча',
  },
  ticket: {
    number: '03',
    name: 'Следующая остановка',
    subtitle: 'Всё важное — на одном билете.',
    description:
      'Кобальтовый синий, белые поверхности и билетная сетка. Маршрут становится главным графическим элементом, бронирование — понятной последовательностью.',
    heading: (
      <>
        Ваше место.
        <br />
        Ваше направление.
      </>
    ),
    detail: 'Рейсы между Россией и Арменией. От поиска до подтверждения — один понятный маршрут.',
    motif: 'Планы становятся поездкой',
  },
}
type Concept = keyof typeof concepts
type Screen = 'home' | 'search' | 'booking'
const screens: [Screen, string][] = [
  ['home', 'Главная'],
  ['search', 'Поиск'],
  ['booking', 'Бронирование'],
]
const routes = [
  { time: '15:40', price: '8 500', seats: 12, bus: 'Автобус A', company: 'Демо-перевозчик A' },
  { time: '19:00', price: '9 200', seats: 8, bus: 'Автобус B', company: 'Демо-перевозчик B' },
]

function RouteArt({ theme }: { theme: Concept }) {
  return (
    <div className="dc-art" aria-hidden="true">
      <svg viewBox="0 0 600 410" fill="none">
        {theme === 'editorial' ? (
          <>
            <circle cx="405" cy="110" r="65" className="dc-sun" />
            <path d="M0 310 140 135 220 235 340 65 600 365V410H0Z" className="dc-mountain-back" />
            <path d="m0 370 175-145 80 70 100-115 245 230H0Z" className="dc-mountain-front" />
            <path d="M290 410c175-110-140-90 50-210" className="dc-road" />
            <path d="m315 100 25-35 38 43-37-12Z" className="dc-snow" />
          </>
        ) : theme === 'transit' ? (
          <>
            <path
              d="M80 80h195a55 55 0 0 1 55 55v130a55 55 0 0 0 55 55h135"
              className="dc-track-shadow"
            />
            <path d="M80 80h195a55 55 0 0 1 55 55v130a55 55 0 0 0 55 55h135" className="dc-track" />
            <circle cx="80" cy="80" r="15" className="dc-station" />
            <circle cx="520" cy="320" r="15" className="dc-station" />
            <circle cx="330" cy="205" r="9" className="dc-midpoint" />
            <text x="65" y="45">
              МОСКВА
            </text>
            <text x="405" y="370">
              ЕРЕВАН
            </text>
            <text x="363" y="211" className="dc-small-art-text">
              ВАШ МАРШРУТ
            </text>
          </>
        ) : (
          <>
            <path d="M30 280 170 150 270 210 390 70 570 180" className="dc-map-line" />
            <path
              d="M30 330h150l90-70 100 20 200-60M80 40v350M250 40v350M420 40v350"
              className="dc-map-grid"
            />
            <path d="M100 115v110a55 55 0 0 0 55 55h285" className="dc-ticket-path" />
            <circle cx="100" cy="115" r="14" className="dc-station" />
            <circle cx="440" cy="280" r="14" className="dc-station" />
            <text x="130" y="122">
              МОСКВА
            </text>
            <text x="375" y="330">
              ЕРЕВАН
            </text>
          </>
        )}
      </svg>
      <div className="dc-art-caption">
        <span>RU → AM</span>
        <span>{concepts[theme].motif}</span>
      </div>
    </div>
  )
}

export default function DesignConceptsPage() {
  const previewOnly = new URLSearchParams(window.location.search).get('preview') === '1'
  const [theme, setTheme] = useState<Concept>('calm')
  const [screen, setScreen] = useState<Screen>('home')
  const [origin, setOrigin] = useState('Москва')
  const [destination, setDestination] = useState('Ереван')
  const [date, setDate] = useState('2026-11-12')
  const [selectedRoute, setSelectedRoute] = useState(0)
  const [seat, setSeat] = useState<number | null>(null)
  const [confirmed, setConfirmed] = useState(false)
  const heading = useRef<HTMLHeadingElement>(null)
  const concept = concepts[theme]
  const route = routes[selectedRoute]
  useEffect(() => {
    document.title = 'armatrans · варианты дизайна'
  }, [])
  function navigate(next: Screen) {
    setScreen(next)
    setConfirmed(false)
    setSeat(null)
    requestAnimationFrame(() => heading.current?.focus({ preventScroll: true }))
  }
  const dateValue = new Date(`${date}T12:00:00Z`)
  const formattedDate = Number.isFinite(dateValue.getTime())
    ? new Intl.DateTimeFormat('ru-RU', {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
        timeZone: 'UTC',
      }).format(dateValue)
    : 'Укажите дату'
  function renderSearchForm() {
    return (
      <form
        className="dc-search-form"
        onSubmit={(event) => {
          event.preventDefault()
          navigate('search')
        }}
      >
        <CityInput label="Откуда" name="origin" value={origin} onChange={setOrigin} />
        <button
          type="button"
          className="dc-swap"
          aria-label="Поменять города местами"
          onClick={() => {
            setOrigin(destination)
            setDestination(origin)
          }}
        >
          ⇄
        </button>
        <CityInput label="Куда" name="destination" value={destination} onChange={setDestination} />
        <label className="dc-date">
          Дата · UTC
          <input
            name="date"
            type="date"
            value={date}
            onChange={(event) => setDate(event.target.value)}
            required
            min="2026-10-25"
            max="9999-12-30"
          />
        </label>
        <button className="dc-primary" type="submit">
          Найти рейсы <span aria-hidden="true">↗</span>
        </button>
      </form>
    )
  }
  return (
    <div className={`designlab dc-${theme}${previewOnly ? ' dc-preview-only' : ''}`}>
      <a className="dc-skip" href="#dc-preview">
        К макету
      </a>
      <header className="dc-labbar">
        <div className="dc-lab-title">
          <strong>
            armatrans <span>/ дизайн-студия</span>
          </strong>
          <a href="/">Открыть приложение ↗</a>
        </div>
        <div className="dc-directions" role="group" aria-label="Визуальная концепция">
          {(Object.keys(concepts) as Concept[]).map((key) => (
            <button key={key} aria-pressed={theme === key} onClick={() => setTheme(key)}>
              <span>{concepts[key].number}</span>
              {concepts[key].name}
            </button>
          ))}
        </div>
        <div className="dc-lab-bottom">
          <p>{concept.description}</p>
          <nav aria-label="Экраны концепции">
            {screens.map(([key, label]) => (
              <button
                key={key}
                aria-current={screen === key ? 'page' : undefined}
                onClick={() => navigate(key)}
              >
                {label}
              </button>
            ))}
          </nav>
        </div>
      </header>
      <div className="dc-prototype-note">
        Интерактивный макет · Все рейсы и цены демонстрационные. Бронирования, платежи и письма не
        создаются.
      </div>
      <main id="dc-preview">
        <header className="dc-site-header">
          <button
            className="dc-brand"
            onClick={() => navigate('home')}
            aria-label="armatrans — главная"
          >
            <span className="dc-brand-mark" aria-hidden="true">
              {theme === 'calm' ? (
                <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
                  <rect
                    x="5"
                    y="4"
                    width="18"
                    height="18"
                    rx="4"
                    stroke="currentColor"
                    strokeWidth="1.5"
                  />
                  <path d="M5 14h18M9 22v3m10-3v3M10 8h8" stroke="currentColor" strokeWidth="1.5" />
                  <circle cx="9" cy="18" r="1.3" fill="currentColor" />
                  <circle cx="19" cy="18" r="1.3" fill="currentColor" />
                </svg>
              ) : (
                '↗'
              )}
            </span>
            armatrans<span className="dc-brand-dot">.</span>
          </button>
          <span className="dc-brand-caption">Россия ↔ Армения</span>
          <button className="dc-text-button" onClick={() => navigate('search')}>
            Расписание
          </button>
        </header>
        {screen === 'home' ? (
          <>
            {theme === 'calm' ? (
              <section className="dc-calm-start" aria-label="Поиск автобусного рейса">
                <div className="dc-calm-start-copy">
                  <h1 ref={heading} tabIndex={-1}>
                    {concept.heading}
                  </h1>
                  <p className="dc-description">{concept.detail}</p>
                  <section id="dc-search" aria-label="Поиск поездки">
                    {renderSearchForm()}
                    <p className="dc-fine">Дата и время отправления указаны по UTC.</p>
                  </section>
                </div>
                <figure className="dc-calm-main-photo">
                  <img
                    src={khorVirap}
                    srcSet={`${khorVirapSmall} 960w, ${khorVirap} 1920w`}
                    sizes="(max-width: 800px) 100vw, 48vw"
                    alt="Монастырь Хор Вирап в Армении на фоне Арарата"
                    width="1920"
                    height="1276"
                    fetchPriority="high"
                  />
                  <figcaption>
                    Хор Вирап, Армения{' '}
                    <a href="https://commons.wikimedia.org/wiki/File:Mount_Ararat_and_Khor_Virap_Monastery,_Ararat_Plain,_Armenia.jpg">
                      Фото: Vyacheslav Argenberg
                    </a>{' '}
                    · <a href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a> ·
                    кадрировано
                  </figcaption>
                </figure>
              </section>
            ) : (
              <>
                <section className="dc-hero">
                  <div className="dc-hero-copy">
                    <p className="dc-kicker">ПОЕЗДКИ МЕЖДУ РОССИЕЙ И АРМЕНИЕЙ</p>
                    <h1 ref={heading} tabIndex={-1}>
                      {concept.heading}
                    </h1>
                    <p className="dc-description">{concept.detail}</p>
                    <a className="dc-hero-link" href="#dc-search">
                      Выбрать направление <span aria-hidden="true">↓</span>
                    </a>
                  </div>
                  <RouteArt theme={theme} />
                </section>
                <section className="dc-search-section" id="dc-search" aria-label="Поиск поездки">
                  <div className="dc-section-label">
                    <span>01 / ВАША ПОЕЗДКА</span>
                    <span>Начнём с направления</span>
                  </div>
                  {renderSearchForm()}
                  <p className="dc-fine">
                    Время отправления указано по UTC. Данные в этом макете — примеры.
                  </p>
                </section>
              </>
            )}
            {theme === 'calm' && (
              <section className="dc-calm-help" aria-labelledby="dc-calm-help-title">
                <div>
                  <h2 id="dc-calm-help-title">Перед бронированием</h2>
                  <p>
                    Сравните время и стоимость, выберите свободное место. Детали бронирования
                    останутся в личном кабинете.
                  </p>
                  <details>
                    <summary>Какое время указано в расписании?</summary>
                    <p>
                      В этом макете и текущем приложении время отправления указано по UTC. Перед
                      поездкой проверьте его с учётом своего часового пояса.
                    </p>
                  </details>
                  <details>
                    <summary>Когда место закрепляется за мной?</summary>
                    <p>
                      Выбор номера ещё не создаёт бронь. В приложении место удерживается на 10 минут
                      после подтверждения бронирования. Этот прототип не создаёт удержаний.
                    </p>
                  </details>
                </div>
                <figure>
                  <img
                    src={garni}
                    srcSet={`${garniSmall} 960w, ${garni} 1920w`}
                    sizes="(max-width: 800px) 100vw, 45vw"
                    alt="Храм Гарни в Армении"
                    width="1920"
                    height="1276"
                    loading="lazy"
                  />
                  <figcaption>
                    Гарни, Армения{' '}
                    <a href="https://commons.wikimedia.org/wiki/File:Garni_Temple,_Armenia.jpg">
                      Фото: Vyacheslav Argenberg
                    </a>{' '}
                    · <a href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a> ·
                    кадрировано
                  </figcaption>
                </figure>
              </section>
            )}
            {theme !== 'calm' && (
              <section className="dc-journey">
                <div>
                  <p className="dc-kicker">ОТ ПЛАНОВ К ВСТРЕЧЕ</p>
                  <h2>
                    Понятно на
                    <br />
                    <em>каждом шаге.</em>
                  </h2>
                </div>
                <ol>
                  {[
                    ['Найдите свой рейс', 'Сравните время отправления, цену и доступные места.'],
                    ['Выберите место', 'Проверьте рейс перед созданием бронирования.'],
                    ['Подтвердите поездку', 'На оплату удержанного места — 10 минут.'],
                  ].map(([title, text], index) => (
                    <li key={title}>
                      <span>0{index + 1}</span>
                      <div>
                        <h3>{title}</h3>
                        <p>{text}</p>
                      </div>
                    </li>
                  ))}
                </ol>
              </section>
            )}
          </>
        ) : screen === 'search' ? (
          <section className="dc-results dc-content">
            <div className="dc-section-label">
              <span>{theme === 'calm' ? 'Расписание' : '01 / ПОИСК РЕЙСОВ'}</span>
              <button className="dc-text-button" onClick={() => navigate('home')}>
                ← На главную
              </button>
            </div>
            <h1 ref={heading} tabIndex={-1}>
              {cityName(origin)} <span className="dc-arrow">→</span> {cityName(destination)}
            </h1>
            <p className="dc-description">{formattedDate} · Отправление по UTC</p>
            {renderSearchForm()}
            <div className="dc-results-heading">
              <h2>Выберите отправление</h2>
              <span>2 демонстрационных рейса</span>
            </div>
            <div className="dc-route-list">
              {routes.map((item, index) => (
                <article
                  className="dc-route"
                  key={item.time}
                  aria-label={`Демонстрационный рейс ${item.time}`}
                >
                  <div className="dc-route-time">
                    <span>{theme === 'calm' ? 'Отправление · UTC' : 'ОТПРАВЛЕНИЕ · UTC'}</span>
                    <strong>{item.time}</strong>
                    <span>{formattedDate}</span>
                  </div>
                  <div className="dc-route-direction">
                    <h3>
                      {cityName(origin)} <span aria-hidden="true">→</span> {cityName(destination)}
                    </h3>
                    <p>
                      {item.company} · {item.bus}
                    </p>
                    <span className="dc-availability">
                      <span aria-hidden="true">●</span> Свободных мест: {item.seats}
                    </span>
                  </div>
                  <div className="dc-route-price">
                    <span>За одно место</span>
                    <strong>{item.price} ₽</strong>
                    <button
                      className="dc-primary"
                      onClick={() => {
                        setSelectedRoute(index)
                        navigate('booking')
                      }}
                    >
                      Выбрать место
                    </button>
                  </div>
                </article>
              ))}
            </div>
            <p className="dc-fine">
              Поиск не закрепляет место. Цена и доступность проверяются при бронировании.
            </p>
          </section>
        ) : (
          <section className="dc-booking dc-content">
            <div className="dc-section-label">
              <span>{theme === 'calm' ? 'Выбор места' : '02 / ВЫБОР МЕСТА'}</span>
              <button className="dc-text-button" onClick={() => navigate('search')}>
                ← К рейсам
              </button>
            </div>
            <h1 ref={heading} tabIndex={-1}>
              Выберите место
            </h1>
            <p className="dc-description">
              {cityName(origin)} → {cityName(destination)} · {formattedDate}, {route.time} UTC
            </p>
            <div className="dc-booking-grid">
              <section className="dc-seat-panel">
                <div className="dc-results-heading">
                  <h2>Выберите номер места</h2>
                  <span>Демо-автобус · 16 мест</span>
                </div>
                <p className="dc-fine">
                  Номера мест без схемы салона: фактическое расположение не задано.
                </p>
                <div className="dc-seats" role="group" aria-label="Места демонстрационного рейса">
                  {Array.from({ length: 16 }, (_, i) => i + 1).map((number) => (
                    <button
                      key={number}
                      disabled={[3, 7, 11, 12].includes(number) || confirmed}
                      aria-label={`Место ${number}${[3, 7, 11, 12].includes(number) ? ', занято' : ''}`}
                      aria-pressed={seat === number}
                      onClick={() => setSeat(number)}
                    >
                      {number}
                    </button>
                  ))}
                </div>
                <div className="dc-seat-legend">
                  <span>□ Свободно</span>
                  <span>▧ Занято</span>
                  <span>● Ваш выбор</span>
                </div>
              </section>
              <aside className="dc-summary">
                <h2 className="dc-summary-title">Ваша поездка</h2>
                <div className="dc-ticket-route">
                  <strong>{cityName(origin)}</strong>
                  <span aria-hidden="true">↓</span>
                  <strong>{cityName(destination)}</strong>
                </div>
                <dl>
                  <div>
                    <dt>Отправление · UTC</dt>
                    <dd>
                      {formattedDate}
                      <br />
                      {route.time}
                    </dd>
                  </div>
                  <div>
                    <dt>Перевозчик</dt>
                    <dd>{route.company}</dd>
                  </div>
                  <div>
                    <dt>Место</dt>
                    <dd aria-live="polite">{seat ?? 'Не выбрано'}</dd>
                  </div>
                </dl>
                <div className="dc-total">
                  <span>За одно место</span>
                  <strong>{route.price} ₽</strong>
                </div>
                <p className="dc-fine">
                  В приложении место удерживается 10 минут после создания брони. Здесь удержание не
                  запускается.
                </p>
                <button
                  className="dc-primary"
                  disabled={!seat || confirmed}
                  onClick={() => setConfirmed(true)}
                >
                  Проверить выбор <span aria-hidden="true">↗</span>
                </button>
                {confirmed && (
                  <p role="status" className="dc-confirmed">
                    Выбрано место {seat}. Это макет: бронь не создана, перехода к оплате нет.
                  </p>
                )}
              </aside>
            </div>
          </section>
        )}
        <footer className="dc-footer">
          <span>
            {theme === 'calm'
              ? 'armatrans. Автобусные поездки.'
              : `armatrans · ${concept.subtitle}`}
          </span>
          <span>Концепция {concept.number} / 04 · Локальный просмотр</span>
        </footer>
      </main>
    </div>
  )
}
