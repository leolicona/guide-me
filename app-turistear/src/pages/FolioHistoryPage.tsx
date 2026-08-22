import { FolioListScreen } from '../features/folios'

// US-AG20/US-AG58 — the seller's own sales. The same screen the admin reads, minus the verbs they
// may not press: no pending-work bar (US-AG50 stands), no admin action on any card. The 102-line
// page this replaces filtered with an exclusive five-tab toggle, kept its state outside the URL and
// had no search — see `FolioListScreen` for why that mattered.
export default function FolioHistoryPage() {
  return <FolioListScreen surface="seller" />
}
