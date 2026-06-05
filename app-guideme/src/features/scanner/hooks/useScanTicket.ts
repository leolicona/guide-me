import { useMutation } from '@tanstack/react-query'
import { scanTicket } from '../../../services/ticketsService'
import { ServiceError } from '../../../services/authService'

// US-AG19 — distinguish "couldn't reach the server" from "server returned an error".
// `request` throws a ServiceError for any HTTP response; a network failure (offline,
// DNS/TCP) makes `fetch` throw a TypeError instead. So: offline iff the browser reports
// offline, or the error is not a ServiceError (i.e. the request never got a response).
export const isOffline = (error: unknown): boolean =>
  !navigator.onLine || !(error instanceof ServiceError)

// US-AG15 — scan + redeem. No cache to invalidate (a redemption is a fire-and-display
// action); `reset` clears the last result so the scanner can re-arm for the next code.
export const useScanTicket = () => useMutation({ mutationFn: scanTicket })
