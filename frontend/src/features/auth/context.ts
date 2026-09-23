import { createContext, useContext, useSyncExternalStore } from 'react'
import type { Session } from './session'

export const SessionContext = createContext<Session | null>(null)
export function useSession() {
  const session = useContext(SessionContext)
  if (!session) throw new Error('Missing SessionProvider')
  const state = useSyncExternalStore(session.subscribe, session.snapshot)
  return { session, ...state }
}
