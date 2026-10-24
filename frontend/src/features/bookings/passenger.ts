export type Passenger = {
  passenger_first_name: string
  passenger_last_name: string
  passenger_phone: string
}

export const emptyPassenger: Passenger = {
  passenger_first_name: '',
  passenger_last_name: '',
  passenger_phone: '',
}

export function normalizePassenger(value: Passenger): Passenger {
  return {
    passenger_first_name: value.passenger_first_name.normalize('NFC').trim(),
    passenger_last_name: value.passenger_last_name.normalize('NFC').trim(),
    passenger_phone: value.passenger_phone.trim().replace(/[ ()-]/g, ''),
  }
}

export function passengerErrors(value: Passenger): Partial<Record<keyof Passenger, string>> {
  const normalized = normalizePassenger(value)
  const errors: Partial<Record<keyof Passenger, string>> = {}
  for (const key of ['passenger_first_name', 'passenger_last_name'] as const) {
    const name = normalized[key]
    if (!/\p{L}/u.test(name) || /\p{C}/u.test(name) || [...name].length > 100)
      errors[key] = 'Укажите имя или фамилию, до 100 символов.'
  }
  if (value.passenger_phone.length > 40 || !/^\+[1-9][0-9]{7,14}$/.test(normalized.passenger_phone))
    errors.passenger_phone = 'Укажите телефон с кодом страны: +7… или +374…'
  return errors
}
