import { create } from 'zustand'
import type { UserPayload } from '../features/auth/types'

interface AuthState {
  user: UserPayload | null
  isAuthenticated: boolean
  setUser: (user: UserPayload) => void
  clear: () => void
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  isAuthenticated: false,
  setUser: (user) => set({ user, isAuthenticated: true }),
  clear: () => set({ user: null, isAuthenticated: false }),
}))
