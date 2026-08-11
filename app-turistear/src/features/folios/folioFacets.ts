// US-A84 (docs/oversight/folio-lifecycle-unification.spec.md) — the facet model: what the folio
// list can be filtered by, how those choices live in the URL, and how a folio is matched.
//
// The organising rule is D3: THREE SECTIONS, each one real axis of the data.
//   Pago     = `folios.status`        (what happened to the money)
//   Entrega  = the delivery axis      (whether the customer got their tickets)
//   Pendiente= work                   (whether someone still has to act)
//
// OR within a section, AND between sections. That is not a UI preference — it is what the data is:
// a folio genuinely is *cancelled* AND *refund pending* at once, and *booking* AND *overdue* at
// once. The exclusive toggle this replaces asserted a mutual exclusion that never existed, which is
// why "cancelled folios I have already paid back" could not be asked.

import { deliveryState } from '../pos/delivery'
import type { FolioListItem } from './types'

export type FacetSection = 'pago' | 'entrega' | 'pendiente'

export type FacetKey =
  // Pago
  | 'pagado'
  | 'reserva'
  | 'cancelado'
  // Entrega
  | 'sin_enviar'
  | 'enviado'
  | 'visto'
  // Pendiente
  | 'por_verificar'
  | 'solicitud'
  | 'reembolso'
  | 'vencido'
  | 'sin_usar'
  | 'con_solicitud'

interface FacetDef {
  key: FacetKey
  section: FacetSection
  label: string
  match: (f: FolioListItem) => boolean
}

// The section is DEDUCED from the key, which is why the URL never has to encode it (D4). Keys are
// globally unique; encoding the section too would be a second copy that can disagree with the first.
// US-A89 (line-autonomy D15) — the Pago facets are ANY-LINE: the facet answers "is there work of
// this kind here?", and a mixed folio genuinely has both kinds — it appears under every facet one
// of its lines earns (S-12). A folio whose lines carry no marks (legacy row, no allocations)
// answers by its roll-up status, exactly like the server's filter.
const anyLine = (f: FolioListItem, state: 'paid' | 'booking' | 'cancelled'): boolean => {
  const marks = (f.lines ?? []).map((l) => l.money_state).filter(Boolean)
  if (marks.length === 0) return f.status === state
  return marks.includes(state)
}

export const FACETS: FacetDef[] = [
  { key: 'pagado', section: 'pago', label: 'Pagado', match: (f) => anyLine(f, 'paid') },
  { key: 'reserva', section: 'pago', label: 'Apartado', match: (f) => anyLine(f, 'booking') },
  { key: 'cancelado', section: 'pago', label: 'Cancelado', match: (f) => anyLine(f, 'cancelled') },

  {
    key: 'sin_enviar',
    section: 'entrega',
    label: 'Sin enviar',
    match: (f) => deliveryState(f) === 'pending',
  },
  { key: 'enviado', section: 'entrega', label: 'Enviado', match: (f) => deliveryState(f) === 'sent' },
  { key: 'visto', section: 'entrega', label: 'Visto', match: (f) => deliveryState(f) === 'viewed' },

  {
    key: 'por_verificar',
    section: 'pendiente',
    label: 'Por verificar',
    // Same predicate US-A67's queue used: a rejected payment cancels the folio and leaves its stale
    // 'pending' flag behind, so a cancelled folio is not work.
    match: (f) => f.payment_verification === 'pending' && f.status !== 'cancelled',
  },
  {
    key: 'solicitud',
    section: 'pendiente',
    label: 'Solicitud',
    match: (f) => f.cancellation_request === 'pending',
  },
  {
    key: 'reembolso',
    section: 'pendiente',
    label: 'Reembolso',
    match: (f) => f.refund_status === 'pending',
  },
  { key: 'vencido', section: 'pendiente', label: 'Vencido', match: (f) => f.overdue === true },
  {
    // US-A85 — the wasted seat, findable. Deliberately in `pendiente` even though nothing can be
    // DONE about a departed seat: the section is where an admin looks for what needs their
    // attention, and a tour that left with empty paid-for seats is exactly that — just as
    // information rather than as a verb.
    key: 'sin_usar',
    section: 'pendiente',
    label: 'Sin usar',
    match: (f) => f.fulfillment === 'no_show' || f.fulfillment === 'partial',
  },
  {
    key: 'con_solicitud',
    section: 'pendiente',
    label: 'Con solicitud',
    // Deliberately ANY request, live or resolved. This is what survives of the absorbed tab's
    // history (D2): a rejected request left the folio untouched, so without this facet the folios
    // it happened to are unreachable except one id at a time.
    match: (f) => f.cancellation_request != null,
  },
]

const BY_KEY = new Map(FACETS.map((f) => [f.key, f]))

export const facetsOf = (section: FacetSection): FacetDef[] =>
  FACETS.filter((f) => f.section === section)

export const SECTION_LABEL: Record<FacetSection, string> = {
  pago: 'Pago',
  entrega: 'Entrega',
  pendiente: 'Pendiente',
}

// --- The URL contract (D4) -----------------------------------------------------------------------

/** Parse `?estado=` into the active set. Unknown values are IGNORED, not rejected (rule 8) —
 *  matching how the server has always treated an unknown `status`. A URL that 400s on a typo is a
 *  URL that breaks when a facet is renamed. */
export const parseFacets = (raw: string | null): FacetKey[] => {
  if (!raw) return []
  const seen = new Set<FacetKey>()
  for (const part of raw.split(',')) {
    const key = part.trim() as FacetKey
    if (BY_KEY.has(key)) seen.add(key)
  }
  return [...seen]
}

/** Serialize back, in the canonical FACETS order so the URL of a given selection is stable no
 *  matter which pill the user tapped first. */
export const serializeFacets = (active: FacetKey[]): string =>
  FACETS.filter((f) => active.includes(f.key))
    .map((f) => f.key)
    .join(',')

// --- Matching (rule 8, D3) -----------------------------------------------------------------------

/**
 * Does this folio satisfy the active facets? OR within a section, AND between sections.
 *
 * A section with nothing active imposes nothing — that is what makes the sections compose instead
 * of collapsing to "everything must be chosen".
 */
export const matchesFacets = (folio: FolioListItem, active: FacetKey[]): boolean => {
  if (active.length === 0) return true
  const sections = new Set(active.map((k) => BY_KEY.get(k)!.section))
  for (const section of sections) {
    const inSection = active.filter((k) => BY_KEY.get(k)!.section === section)
    if (!inSection.some((k) => BY_KEY.get(k)!.match(folio))) return false
  }
  return true
}

/** The pill's own label: the facet when exactly one is on, a count when several, the bare noun when
 *  none — so the strip states the filter without the user opening the sheet to find out. */
export const facetPillLabel = (active: FacetKey[]): string => {
  if (active.length === 0) return 'Estado'
  if (active.length === 1) return BY_KEY.get(active[0])!.label
  return `Estado · ${active.length}`
}

/** The names of the active facets, for the empty state — an empty list must say what it filtered
 *  by, or it reads as "there are no sales". */
export const facetLabels = (active: FacetKey[]): string[] =>
  FACETS.filter((f) => active.includes(f.key)).map((f) => f.label)
