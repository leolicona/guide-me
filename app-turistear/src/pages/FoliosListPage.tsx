import { FolioListScreen } from '../features/folios'

// US-AG58 — route assembly only (`CLAUDE.md`: pages carry no business logic). The screen itself
// lives in `features/folios/components/FolioListScreen.tsx` and is shared with the seller's
// `/history`; this file exists to say which audience is asking.
export default function FoliosListPage() {
  return <FolioListScreen surface="admin" />
}
