import { create } from 'zustand'
import { persist } from 'zustand/middleware'

interface PosPreferencesState {
  hideSoldOut: boolean
  setHideSoldOut: (v: boolean) => void
}

export const usePosPreferences = create<PosPreferencesState>()(
  persist(
    (set) => ({
      hideSoldOut: true,
      setHideSoldOut: (v) => set({ hideSoldOut: v }),
    }),
    { name: 'pos-preferences' },
  ),
)
