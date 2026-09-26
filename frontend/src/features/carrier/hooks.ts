import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useSession } from '../auth/context'
import { ApiError } from '../../shared/api/client'
import { carrierError } from './contracts'

export function useCarrierRead<T>(path: string, read: (value: unknown) => T, enabled = true) {
  const { session, user } = useSession()
  return useQuery({
    queryKey: ['carrier-data', user?.id, path],
    queryFn: async ({ signal }) => read(await session.request(path, { signal })),
    enabled,
    staleTime: 0,
    networkMode: 'always',
    refetchOnWindowFocus: 'always',
  })
}
export function useCarrierWrite() {
  const { session, user } = useSession()
  const client = useQueryClient()
  const pending = useRef(false)
  const mounted = useRef(true)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [uncertain, setUncertain] = useState(false)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  async function run<T>(action: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false }> {
    if (pending.current) return { ok: false }
    pending.current = true
    setBusy(true)
    setMessage('')
    setUncertain(false)
    try {
      const value = await action()
      return mounted.current && session.snapshot().user?.id === user?.id
        ? { ok: true, value }
        : { ok: false }
    } catch (error) {
      if (mounted.current) {
        setMessage(carrierError(error, true))
        setUncertain(
          !(
            error instanceof ApiError &&
            [400, 401, 403, 404, 409, 410, 422, 429].includes(error.status)
          ),
        )
      }
      if (error instanceof ApiError && error.status === 403)
        void client.invalidateQueries({ queryKey: ['carrier-profile'] })
      return { ok: false }
    } finally {
      void client.invalidateQueries({ queryKey: ['carrier-data'] })
      void client.invalidateQueries({ queryKey: ['public-trip'] })
      void client.invalidateQueries({ queryKey: ['public-routes'] })
      if (mounted.current) setBusy(false)
      pending.current = false
    }
  }
  return { run, busy, message, uncertain, session }
}
