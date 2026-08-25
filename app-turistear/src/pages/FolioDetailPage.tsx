import { FolioDetailScreen } from '../features/folios'

// US-A21/US-A93 — route assembly only (`CLAUDE.md`: pages carry no business logic). The screen is
// shared with the seller's `/history/:id`; this file says which audience is asking.
export default function FolioDetailPage() {
  return <FolioDetailScreen surface="admin" />
}
