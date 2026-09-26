import { isUuid } from '../trips/trip'
import { resources } from './resources'
export function readAdminFilters(kind: string, params: URLSearchParams): URLSearchParams | null {
  if (!Object.hasOwn(resources, kind)) return null
  const fields = resources[kind].filters
  if (
    [...params.keys()].some(
      (key) =>
        (key !== 'offset' && !fields.some((f) => f.key === key)) || params.getAll(key).length !== 1,
    )
  )
    return null
  const offset = params.get('offset') ?? '0'
  if (!/^(?:0|[1-9]\d{0,4})$/.test(offset) || Number(offset) > 10000 || Number(offset) % 20 !== 0)
    return null
  const clean = new URLSearchParams()
  for (const field of fields) {
    const v = params.get(field.key)
    if (v === null || v === '') continue
    if (
      v !== v.trim() ||
      (field.uuid && !isUuid(v)) ||
      (field.values && !field.values.includes(v)) ||
      v.length > (field.max ?? 100)
    )
      return null
    clean.set(field.key, v)
  }
  if (Number(offset)) clean.set('offset', offset)
  return clean
}
export function adminReturnTo(value: string): string | null {
  if (!value.startsWith('/admin/') || value.includes('#') || value.split('?').length > 2)
    return null
  const [path, query = ''] = value.split('?'),
    parts = path.split('/')
  if (parts.length === 3 && Object.hasOwn(resources, parts[2])) {
    const clean = readAdminFilters(parts[2], new URLSearchParams(query))
    return clean ? path + (clean.size ? `?${clean}` : '') : null
  }
  if (
    parts.length === 4 &&
    parts[2] !== 'audit' &&
    Object.hasOwn(resources, parts[2]) &&
    isUuid(parts[3]) &&
    !query
  )
    return path
  return null
}
