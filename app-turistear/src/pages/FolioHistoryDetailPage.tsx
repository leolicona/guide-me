import { FolioDetailScreen } from '../features/folios'

// US-AG21/US-A93 — the seller's read-only view of their own sale. The same screen the admin reads,
// minus the verbs they may not press: no cancel, no line cancel, no payment verification, no refund
// confirmation. What they keep is delivery, the booking actions on a live apartado, and the QR they
// show the customer across the counter.
export default function FolioHistoryDetailPage() {
  return <FolioDetailScreen surface="seller" />
}
