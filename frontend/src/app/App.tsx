import { Component, lazy, Suspense, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter, NavLink, Outlet, Route, Routes, useLocation } from 'react-router'
import { Brand, Button, Notice } from '../shared/ui'
import { HomePage } from '../pages/HomePage'
import { SearchPage } from '../pages/SearchPage'
import { TripPage } from '../pages/TripPage'
import { BookingPage, BookingsPage, CreateBookingPage } from '../pages/BookingPages'
import { PaymentPage } from '../pages/PaymentPage'
import { CarriersPage, HelpPage, NotFoundPage } from '../pages/InformationPages'
import { SessionProvider } from '../features/auth/SessionProvider'
import { useSession } from '../features/auth/context'
import { Protected } from '../features/auth/Protected'
import { AuthPage } from '../pages/AuthPages'
import { AccountPage, AdminProfilePage, CarrierProfilePage } from '../pages/AccountPages'

const DesignSystemPage = import.meta.env.DEV
  ? lazy(() => import('../pages/DesignSystemPage'))
  : null

class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  render() {
    if (this.state.failed)
      return (
        <main className="container error-page">
          <h1>Не удалось открыть страницу</h1>
          <p>Попробуйте обновить её. Ваши поездки сохраняются в сервисе.</p>
          <Button onClick={() => window.location.reload()}>Обновить страницу</Button>
        </main>
      )
    return this.props.children
  }
}

function Shell() {
  const { status } = useSession()
  const [menuOpen, setMenuOpen] = useState(false)
  const menuButton = useRef<HTMLButtonElement>(null)
  const location = useLocation()
  useEffect(() => {
    document.getElementById('main-content')?.focus({ preventScroll: true })
    window.scrollTo({ top: 0 })
  }, [location.pathname])
  useEffect(() => {
    if (!menuOpen) return
    function escape(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setMenuOpen(false)
        menuButton.current?.focus()
      }
    }
    document.addEventListener('keydown', escape)
    return () => document.removeEventListener('keydown', escape)
  }, [menuOpen])

  return (
    <>
      <a className="skip-link" href="#main-content">
        Перейти к содержимому
      </a>
      <header className="site-header">
        <div className="container header-inner">
          <Brand />
          <button
            className="menu-toggle"
            ref={menuButton}
            aria-controls="main-navigation"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen(!menuOpen)}
          >
            {menuOpen ? 'Закрыть' : 'Меню'}
            <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24">
              <path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" strokeWidth="1.5" />
            </svg>
          </button>
          <nav
            id="main-navigation"
            className={`main-nav ${menuOpen ? 'is-open' : ''}`}
            aria-label="Основная навигация"
          >
            <NavLink to="/" end onClick={() => setMenuOpen(false)}>
              Пассажирам
            </NavLink>
            <NavLink to="/carriers" onClick={() => setMenuOpen(false)}>
              Перевозчикам
            </NavLink>
            <NavLink to="/help" onClick={() => setMenuOpen(false)}>
              Помощь
            </NavLink>
            <NavLink
              to={status === 'anonymous' ? '/login' : '/account'}
              onClick={() => setMenuOpen(false)}
            >
              {status === 'anonymous' ? 'Войти' : 'Аккаунт'}
            </NavLink>
          </nav>
          <span className="header-caption">
            Россия <span aria-hidden="true">↔</span> Армения
          </span>
        </div>
      </header>
      <main id="main-content" tabIndex={-1}>
        <Suspense
          fallback={
            <div className="container section">
              <Notice title="Открываем страницу…" />
            </div>
          }
        >
          <Outlet />
        </Suspense>
      </main>
      <footer className="site-footer">
        <div className="container footer-inner">
          <div>
            <Brand />
            <p>Между городами. Ближе друг к другу.</p>
          </div>
          <div className="footer-links">
            <NavLink to="/help">О бронировании</NavLink>
            <NavLink to="/carriers">Для перевозчиков</NavLink>
          </div>
          <span className="footer-mark">РОССИЯ ↔ АРМЕНИЯ</span>
        </div>
      </footer>
    </>
  )
}

export function App() {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { staleTime: 30_000, retry: false, refetchOnWindowFocus: false },
          mutations: { retry: false },
        },
      }),
  )
  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <SessionProvider>
          <BrowserRouter>
            <Routes>
              <Route element={<Shell />}>
                <Route index element={<HomePage />} />
                <Route path="search" element={<SearchPage />} />
                <Route path="trips/:id" element={<TripPage />} />
                <Route path="carriers" element={<CarriersPage />} />
                <Route path="help" element={<HelpPage />} />
                <Route path="login" element={<AuthPage key="login" />} />
                <Route path="register" element={<AuthPage key="register" register />} />
                <Route element={<Protected />}>
                  <Route path="account" element={<AccountPage />} />
                </Route>
                <Route element={<Protected role="CARRIER" />}>
                  <Route path="carrier" element={<CarrierProfilePage />} />
                </Route>
                <Route element={<Protected role="PASSENGER" />}>
                  <Route path="trips/:id/book" element={<CreateBookingPage />} />
                  <Route path="bookings" element={<BookingsPage />} />
                  <Route path="bookings/:id" element={<BookingPage />} />
                  <Route path="bookings/:id/payment" element={<PaymentPage />} />
                  <Route path="payment/result" element={<PaymentPage result />} />
                </Route>
                <Route element={<Protected role="ADMIN" />}>
                  <Route path="admin" element={<AdminProfilePage />} />
                </Route>
                {DesignSystemPage && <Route path="design-system" element={<DesignSystemPage />} />}
                <Route path="*" element={<NotFoundPage />} />
              </Route>
            </Routes>
          </BrowserRouter>
        </SessionProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  )
}
