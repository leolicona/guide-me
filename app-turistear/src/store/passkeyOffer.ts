import { create } from 'zustand'

// passkey-auth FR-007, SC-008 — the offer to create a llave de acceso follows every email-code
// sign-in. The sign-in raises this flag just before it navigates into the app, and AppLayout's
// PasskeyOffer reads it: the sign-in screen and the shell never mount together, so the flag is
// how one hands the moment to the other. "Ahora no" lowers it; it is never forced.
interface PasskeyOfferState {
  pending: boolean
  request: () => void
  dismiss: () => void
}

export const usePasskeyOffer = create<PasskeyOfferState>()((set) => ({
  pending: false,
  request: () => set({ pending: true }),
  dismiss: () => set({ pending: false }),
}))
