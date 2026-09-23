import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { SessionContext } from './context'
import { Session } from './session'

export function SessionProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient()
  const [session] = useState(() => new Session(() => queryClient.clear()))
  useEffect(() => {
    const disconnect = session.connect()
    void session.restore()
    return disconnect
  }, [session])
  return <SessionContext.Provider value={session}>{children}</SessionContext.Provider>
}
