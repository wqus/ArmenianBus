import { NavLink } from 'react-router'

export function CarrierNavigation() {
  return (
    <nav className="carrier-nav" aria-label="Кабинет перевозчика">
      <NavLink to="/carrier" end>
        Компания
      </NavLink>
      <NavLink to="/carrier/buses">Автобусы</NavLink>
      <NavLink to="/carrier/routes">Рейсы</NavLink>
      <NavLink to="/carrier/bookings">Бронирования</NavLink>
    </nav>
  )
}
