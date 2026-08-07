import type { ReactNode } from 'react'
import { Box, Stack, Typography } from '@mui/material'
import ReceiptLongRounded from '@mui/icons-material/ReceiptLongRounded'
import PaymentsRounded from '@mui/icons-material/PaymentsRounded'
import TaskAltRounded from '@mui/icons-material/TaskAltRounded'
import CancelRounded from '@mui/icons-material/CancelRounded'
import SendRounded from '@mui/icons-material/SendRounded'
import VisibilityRounded from '@mui/icons-material/VisibilityRounded'
import NotificationsActiveRounded from '@mui/icons-material/NotificationsActiveRounded'
import EventRepeatRounded from '@mui/icons-material/EventRepeatRounded'
import CurrencyExchangeRounded from '@mui/icons-material/CurrencyExchangeRounded'
import EventRounded from '@mui/icons-material/EventRounded'
import RuleRounded from '@mui/icons-material/RuleRounded'
import { MoneyText, SectionCard } from '../../../components'
import { useOrgDateFormatter } from '../../organization'
import type { FolioCancellationRequest, FolioEvent, FolioEventType, Fulfillment } from '../types'

const DATE_FMT: Intl.DateTimeFormatOptions = {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
}

// Functional color per event, icon-paired, NEVER teal: green = money in / cleared / seen,
// red = a sale dying, amber = chasing a debt, neutral ink = the rest of the story.
const EVENT_TONE: Record<FolioEventType, string> = {
  created: 'text.secondary',
  payment: 'success.main',
  payment_verified: 'success.main',
  transfer_rejected: 'error.main',
  tickets_sent: 'text.secondary',
  tickets_viewed: 'success.main',
  reminder_sent: 'warning.main',
  rescheduled: 'text.secondary',
  cancelled: 'error.main',
  refund_confirmed: 'success.main',
}

const EVENT_ICON: Record<FolioEventType, ReactNode> = {
  created: <ReceiptLongRounded fontSize="small" />,
  payment: <PaymentsRounded fontSize="small" />,
  payment_verified: <TaskAltRounded fontSize="small" />,
  transfer_rejected: <CancelRounded fontSize="small" />,
  tickets_sent: <SendRounded fontSize="small" />,
  tickets_viewed: <VisibilityRounded fontSize="small" />,
  reminder_sent: <NotificationsActiveRounded fontSize="small" />,
  rescheduled: <EventRepeatRounded fontSize="small" />,
  cancelled: <CancelRounded fontSize="small" />,
  refund_confirmed: <CurrencyExchangeRounded fontSize="small" />,
}

const METHOD_WORDS: Record<string, string> = {
  cash: 'efectivo',
  card: 'tarjeta',
  transfer: 'transferencia',
  link: 'enlace',
}

// Payloads are `Record<string, unknown>` on the wire; read defensively — a backfilled row may
// omit any key (a payment's `kind`, a created's `initial_status`).
const str = (p: Record<string, unknown> | null, key: string): string | undefined =>
  typeof p?.[key] === 'string' ? (p[key] as string) : undefined
const num = (p: Record<string, unknown> | null, key: string): number | undefined =>
  typeof p?.[key] === 'number' ? (p[key] as number) : undefined

// The one-line copy per event (spec D8 vocabulary — never "Reserva"). Money renders through
// MoneyText (D11): small, neutral semantic.
function eventPrimary(ev: FolioEvent): ReactNode {
  const p = ev.payload
  switch (ev.type) {
    case 'created': {
      if (str(p, 'sale_mode') === 'express') return 'Venta Express'
      const initial = str(p, 'initial_status')
      if (initial === 'booking') return 'Creado (apartado)'
      return initial ? 'Creado (pagado)' : 'Creado'
    }
    case 'payment': {
      const kind = str(p, 'kind')
      const label =
        kind === 'deposit'
          ? 'Abono'
          : kind === 'settlement'
            ? 'Saldo liquidado'
            : kind === 'full'
              ? 'Pago recibido'
              : 'Pago'
      const amount = num(p, 'amount')
      const method = METHOD_WORDS[str(p, 'method') ?? '']
      return (
        <>
          {label}
          {amount !== undefined && (
            <>
              {' '}
              <MoneyText cents={amount} variant="body2" srLabel={label} />
            </>
          )}
          {method ? ` en ${method}` : ''}
        </>
      )
    }
    case 'payment_verified':
      return 'Transferencia verificada'
    case 'transfer_rejected':
      return 'Transferencia rechazada — venta cancelada'
    case 'tickets_sent':
      return 'Boletos enviados'
    case 'tickets_viewed':
      return 'Visto por el cliente'
    case 'reminder_sent':
      return 'Recordatorio de saldo enviado'
    case 'rescheduled': {
      const from = [str(p, 'from_date'), str(p, 'from_time')].filter(Boolean).join(' ')
      const to = [str(p, 'to_date'), str(p, 'to_time')].filter(Boolean).join(' ')
      return `Reagendado: ${from} → ${to}`
    }
    case 'cancelled': {
      switch (str(p, 'source')) {
        case 'system_expiry':
          return 'Apartado vencido — cancelado por el sistema'
        case 'tourist_request':
          return 'Cancelado a solicitud del cliente'
        case 'admin':
          return 'Cancelado por administración'
        case 'agent':
          return str(p, 'kind') === 'express_void' ? 'Venta Express anulada' : 'Cancelado en mostrador'
        default:
          return 'Cancelado'
      }
    }
    case 'refund_confirmed': {
      const amount = num(p, 'amount')
      return (
        <>
          Reembolso entregado
          {amount !== undefined && (
            <>
              {' '}
              <MoneyText cents={amount} variant="body2" srLabel="Reembolso entregado" />
            </>
          )}
        </>
      )
    }
  }
}

interface TimelineRow {
  key: string
  icon: ReactNode
  color: string
  primary: ReactNode
  /** Secondary lines: a stated reason, the client's motivo, a resolution note. */
  details?: string[]
  caption: string
}

/** The subset of a folio line the Salida marker needs — shared by the admin and POS shapes. */
interface TimelineLine {
  slot_date?: string | null
  slot_start_time?: string | null
}

// D7 — the marker is DERIVED at read, never an event: the folio's earliest dated departure. The
// epoch is naive UTC against org-local date strings, so it can sit off by the org's UTC offset —
// which only shifts the marker's slot between same-day neighbours, never invents or loses a row.
function deriveSalida(lines: TimelineLine[] | undefined, fulfillment?: Fulfillment) {
  const dated = (lines ?? []).filter((l) => l.slot_date)
  if (dated.length === 0) return null
  const earliest = dated.reduce((a, b) =>
    `${b.slot_date} ${b.slot_start_time ?? ''}` < `${a.slot_date} ${a.slot_start_time ?? ''}` ? b : a,
  )
  const time = earliest.slot_start_time
  const suffix =
    fulfillment === 'no_show' ? ' — sin uso' : fulfillment === 'partial' ? ' — uso parcial' : ''
  return {
    epoch: Date.parse(`${earliest.slot_date}T${time || '00:00'}:00Z`) / 1000,
    primary: `Salida${suffix}`,
    caption: `${earliest.slot_date}${time ? ` · ${time}` : ''}`,
  }
}

export interface FolioTimelineProps {
  /** May be undefined on a cache entry that predates the events embed — treated as none. */
  events?: FolioEvent[]
  /** The folio's lines; the earliest dated departure derives the Salida marker (D7). */
  lines?: TimelineLine[]
  /** Folio-level fulfilment (US-A85) — the POS detail does not carry it, so the seller's marker
   * ships date-only. */
  fulfillment?: Fulfillment
  /** The folio's petitions (US-A84 rule 7). REJECTED ones interleave as derived rows — rejecting
   * left the folio untouched, so no event records it; approved ones already appear as their
   * `cancelled`/`rescheduled` events and get no second row. Supersedes the separate
   * "Historial de solicitudes" card. */
  requests?: FolioCancellationRequest[]
}

// US-A24 / US-AG53 — the sale as a story (docs/folios/folio-timeline.spec.md D8): a plain
// oldest-first list inside `Historial`. Events arrive already sorted server-side; the ONLY
// reordering here is inserting the derived Salida marker at its chronological slot. Admin and
// seller render the identical component (D6) — no role variants.
export function FolioTimeline({ events, lines, fulfillment, requests }: FolioTimelineProps) {
  const formatDate = useOrgDateFormatter(DATE_FMT) // US-A66 — org-local audit timestamps

  const eventRows: TimelineRow[] = (events ?? []).map((ev) => {
    // D10 — actor NULL is the system's sweep, except the Visto beacon, which only the tourist fires.
    const who = ev.actor?.name ?? (ev.type === 'tickets_viewed' ? 'Cliente' : 'Sistema')
    const op = ev.operator_name ? ` (op. ${ev.operator_name})` : ''
    let caption = `${who}${op} · ${formatDate(ev.at)}`
    const reference = str(ev.payload, 'reference')
    if (ev.type === 'payment_verified' && reference) caption += ` · ref. ${reference}`
    const via = str(ev.payload, 'via')
    if (ev.type === 'refund_confirmed' && via)
      caption += via === 'override' ? ' · con nota de anulación' : ' · con PIN'
    const reason =
      ev.type === 'transfer_rejected' || ev.type === 'cancelled'
        ? str(ev.payload, 'reason')
        : undefined
    return {
      key: ev.id,
      icon: EVENT_ICON[ev.type],
      color: EVENT_TONE[ev.type],
      primary: eventPrimary(ev),
      details: reason ? [reason] : undefined,
      caption,
    }
  })

  // Derived rows (the D7 pattern): never events. The Salida marker, and the REJECTED petitions —
  // rejecting one left the folio untouched, so no event records it and this is now its only
  // surface. Approved petitions already appear as their `cancelled`/`rescheduled` events.
  const derived: { epoch: number; row: TimelineRow }[] = []

  const salida = deriveSalida(lines, fulfillment)
  if (salida) {
    derived.push({
      epoch: salida.epoch,
      row: {
        key: 'salida',
        icon: <EventRounded fontSize="small" />,
        color: 'text.secondary',
        primary: salida.primary,
        caption: salida.caption,
      },
    })
  }

  for (const r of requests ?? []) {
    if (r.status !== 'rejected') continue
    const at = r.resolved_at ?? r.created_at
    const isReschedule = r.kind === 'reschedule'
    derived.push({
      epoch: at,
      row: {
        key: `request-${r.id}`,
        icon: <RuleRounded fontSize="small" />,
        // A rejected petition changed nothing on the sale — history, not an alert: neutral ink.
        color: 'text.secondary',
        primary: isReschedule
          ? 'Solicitud de reagenda rechazada'
          : 'Solicitud de cancelación rechazada',
        details: [
          isReschedule && r.to_slot_date
            ? `Horario solicitado: ${r.to_slot_date}${r.to_slot_start_time ? ` ${r.to_slot_start_time}` : ''}`
            : null,
          r.reason ? `Motivo del cliente: ${r.reason}` : null,
          r.resolution_note ? `Resolución: ${r.resolution_note}` : null,
        ].filter((d): d is string => d !== null),
        caption: formatDate(at),
      },
    })
  }

  // Stable merge: event order is the server's, untouched; each derived row slots before the
  // first strictly-later event (ties land after the equal-timestamp event, as the marker always did).
  derived.sort((a, b) => a.epoch - b.epoch)
  const rows: TimelineRow[] = []
  let di = 0
  ;(events ?? []).forEach((ev, i) => {
    while (di < derived.length && derived[di].epoch < ev.at) rows.push(derived[di++].row)
    rows.push(eventRows[i])
  })
  while (di < derived.length) rows.push(derived[di++].row)

  return (
    <SectionCard title="Historial">
      {rows.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          Sin historial
        </Typography>
      ) : (
        <Stack spacing={2}>
          {rows.map((row) => (
            <Stack key={row.key} direction="row" spacing={1.5} sx={{ alignItems: 'flex-start' }}>
              <Box sx={{ color: row.color, display: 'flex', mt: '2px' }}>{row.icon}</Box>
              <Box sx={{ minWidth: 0 }}>
                <Typography variant="body2" sx={{ fontWeight: 600 }}>
                  {row.primary}
                </Typography>
                {row.details?.map((detail) => (
                  <Typography
                    key={detail}
                    variant="caption"
                    color="text.secondary"
                    sx={{ display: 'block' }}
                  >
                    {detail}
                  </Typography>
                ))}
                <Typography variant="caption" color="text.secondary">
                  {row.caption}
                </Typography>
              </Box>
            </Stack>
          ))}
        </Stack>
      )}
    </SectionCard>
  )
}
