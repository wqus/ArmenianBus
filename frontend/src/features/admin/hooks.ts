import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useSession } from '../auth/context'
import { adminError } from './operations'

export function useAdminRead<T>(path: string, read: (v: unknown) => T, enabled = true) {
  const { session, user } = useSession()
  return useQuery({
    queryKey: ['admin', user?.id, path],
    queryFn: async ({ signal }) => read(await session.request(`/admin${path}`, { signal })),
    enabled,
    staleTime: 0,
    refetchOnWindowFocus: 'always',
    networkMode: 'always',
  })
}
export function useAdminWrite() {
  const { session, user } = useSession(),
    client = useQueryClient()
  const mounted = useRef(true),
    pending = useRef(false)
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [done, setDone] = useState(false)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  async function run(action: () => Promise<unknown>) {
    if (pending.current) return
    pending.current = true
    setBusy(true)
    setError('')
    setDone(false)
    try {
      await action()
      if (mounted.current && session.snapshot().user?.id === user?.id) setDone(true)
    } catch (error) {
      if (mounted.current) setError(adminError(error, true))
    } finally {
      await client.invalidateQueries({ queryKey: ['admin'] })
      for (const key of ['carrier-profile', 'carrier-data', 'public-trip', 'public-routes'])
        void client.invalidateQueries({ queryKey: [key] })
      pending.current = false
      if (mounted.current) setBusy(false)
    }
  }
  return { session, run, busy, error, done }
}
