import { useMemo, useState } from 'react'
import { Box, ButtonBase, Collapse, Typography } from '@mui/material'
import ExpandMoreRounded from '@mui/icons-material/ExpandMoreRounded'
import { SectionCard } from '../../../components'
import type { DashboardDay } from '../../../services/dashboardService'
import { useOrgClock } from '../hooks/useOrgClock'
import { hasDeparted, timelineItems, type TimelineItem } from '../timeline'

/**
 * D23 — the row's whole job: how full is this departure, and afterwards, how many showed up.
 *
 * This replaces the five-branch semáforo chip (D11, retired). The chip and the number said the
 * same thing — "0 disponibles" IS «Lleno» — and the number says it without color, without an
 * icon, and without a legend to learn.
 *
 * The two readings this must produce:
 *   · upcoming — «60 disponibles · 90 vendidos»
 *   · departed — «85 asistentes de 90 vendidos»
 *
 * The data (see `TimelineItem`):
 *   item.seats    — { capacity, booked, remaining, vendidos, apartados, flex_extra } | null
 *   item.boarding — { vendidos, abordaron, sin_usar } | null   (mutually exclusive with seats)
 *   `past`        — this row sits in the collapsed «ya salieron» segment
 *
 * D24 — the sold figure for an upcoming row is `booked`, NOT `vendidos`: held seats count as sold
 * here, so `remaining + booked === capacity` always holds and the admin never sees seats go
 * missing without explanation. (`apartados` stays in the payload for the future detail view.)
 *
 * D25 — `flex_extra` is the overbooking margin left on a flexible service; it is only meaningful
 * once the slot is full, and it is the one fact a plain "0 disponibles" would hide.
 */
const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

// The figure the admin came for, in ink at 600 while the rest of the line stays secondary. Which
// figure that is depends on tense: before departure it is what is still sellable, after it is who
// actually showed up.
const Lead = ({ children }: { children: string }) => (
  <Box component="span" sx={{ color: 'text.primary', fontWeight: 600 }}>
    {children}
  </Box>
)

function RowDetail({ item, past }: { item: TimelineItem; past: boolean }) {
  // Departed, with the scan counted: the reading this whole card exists for.
  if (item.boarding) {
    const { abordaron, vendidos } = item.boarding
    // A departure that sold nothing has no attendance to report — «0 asistentes de 0 vendidos» is
    // true and tells the admin nothing. Same reason the summary suppresses its aggregate.
    if (vendidos === 0) return <>Sin ventas</>
    return (
      <>
        <Lead>{count(abordaron, 'asistente', 'asistentes')}</Lead>
        {` de ${count(vendidos, 'vendido', 'vendidos')}`}
      </>
    )
  }

  if (!item.seats) return null
  const { remaining, booked, capacity, flex_extra } = item.seats

  // D23 — the ≤60 s window where the client's clock has moved a row past its hour but the poll has
  // not yet returned its boarding numbers. "N disponibles" would be a lie here: the service has
  // left, those seats are not for sale. We report only what is still true and let the next poll
  // fill in the attendance.
  if (past) {
    return (
      <>
        {count(booked, 'vendido', 'vendidos')}
        {' · asistencia en conteo'}
      </>
    )
  }

  return (
    <>
      <Lead>{count(remaining, 'disponible', 'disponibles')}</Lead>
      {` · ${count(booked, 'vendido', 'vendidos')}`}
      {/* D25 — only meaningful once the slot is full, and the one fact "0 disponibles" would hide:
          a flexible service can still take N more. */}
      {booked >= capacity && flex_extra > 0 && ` · +${flex_extra} extra`}
    </>
  )
}

/**
 * D26 — the time axis is **implicit**. Rows are chronological, so the order IS the timeline; the
 * drawn rail (D20, retired) and the «Ahora» node (D18's marker, retired) added no information the
 * sequence did not already carry. The hour leads the row inline instead of holding a fixed column,
 * which hands the full card width back to the service name.
 *
 * Grouping is done by whitespace alone: 4px between a row's two lines against 24px between rows,
 * a 6:1 ratio that reads as "two lines, one row" without a divider, a rail, or a box.
 */
function TimelineRow({ item, past }: { item: TimelineItem; past: boolean }) {
  const ink = past ? 'text.secondary' : 'text.primary'
  return (
    <Box sx={{ py: 1.5 }}>
      <Typography sx={{ fontWeight: 600, color: ink }}>
        <Box component="span" className="numeric">
          {item.start_time}
        </Box>
        {' · '}
        {item.service_name}
      </Typography>
      <Typography variant="body2" color="text.secondary" className="numeric" sx={{ mt: 0.5 }}>
        <RowDetail item={item} past={past} />
      </Typography>
    </Box>
  )
}

// D21-rev — collapsed, the past segment is the only thing standing between the admin and today's
// attendance, so the summary carries the same reading the rows do, aggregated: «170 de 180
// asistieron». The amber "sin usar" call-out is gone with the chips (D23) — the shortfall is the
// subtraction, and stating it twice in two vocabularies was the noise, not the signal.
// Rows not yet re-polled contribute no boarding claim: with none known we say nothing at all
// rather than imply a full house.
function PastSummary({
  items,
  open,
  onToggle,
}: {
  items: TimelineItem[]
  open: boolean
  onToggle: () => void
}) {
  const known = items.filter((i) => i.boarding)
  const asistieron = known.reduce((n, i) => n + (i.boarding?.abordaron ?? 0), 0)
  const vendidos = known.reduce((n, i) => n + (i.boarding?.vendidos ?? 0), 0)

  return (
    <ButtonBase
      onClick={onToggle}
      aria-expanded={open}
      aria-label={open ? 'Ocultar los servicios que ya salieron' : 'Mostrar los servicios que ya salieron'}
      sx={{
        width: '100%',
        minHeight: 48,
        px: 3,
        gap: 1,
        justifyContent: 'flex-start',
        borderRadius: 0,
        textAlign: 'left',
      }}
    >
      <ExpandMoreRounded
        fontSize="small"
        sx={{
          color: 'text.secondary',
          transform: open ? 'rotate(180deg)' : 'none',
          transition: 'transform 150ms',
        }}
      />
      <Typography variant="body2" color="text.secondary" className="numeric">
        {items.length === 1 ? '1 ya salió' : `${items.length} ya salieron`}
      </Typography>
      {/* `vendidos > 0`, not `known.length > 0`: departures that sold nothing produce a truthful
          but useless «0 de 0 asistieron». Nothing was sold, so there is no attendance to report. */}
      {vendidos > 0 && (
        <Typography variant="body2" color="text.secondary" className="numeric">
          · {asistieron} de {vendidos} asistieron
        </Typography>
      )}
    </ButtonBase>
  )
}

/**
 * US-A14/A90 — the day's occupancy: every departure in chronological order, reading how full it is
 * and, once it has left, how many actually showed up.
 *
 * D27 — titled «Ocupación», not «Salidas». The card is not an inventory of departures; it answers
 * one question the admin asks all day — *how full are we* — in both tenses, and «Ocupación» is the
 * only word that survives a slot crossing from "60 disponibles" to "85 asistentes". It stays
 * day-agnostic (D22): the strip above already says which day.
 *
 * «Ya salieron» is not a second card but the collapsed segment at the top, which is why peeking at
 * a future day cannot leak today's departures: on a future day nothing has departed *by
 * construction* (D18's `hasDeparted`), so there is no state left to get wrong.
 */
export function DeparturesTimeline({
  day,
  isToday,
  tz,
  loading,
}: {
  day?: DashboardDay
  isToday: boolean
  tz?: string
  loading: boolean
}) {
  // D18 survives the marker it used to draw: the org clock still owns the past/upcoming split, and
  // still re-renders on the wall-clock minute so a slot crossing its hour drops into the collapsed
  // segment on its own. It is simply no longer displayed.
  const now = useOrgClock(tz)
  const items = useMemo(() => timelineItems(day), [day])
  const departed = useMemo(
    () => items.filter((i) => hasDeparted(i, now, isToday)),
    [items, now, isToday],
  )
  const upcoming = useMemo(
    () => items.filter((i) => !hasDeparted(i, now, isToday)),
    [items, now, isToday],
  )

  // null = the admin has not chosen; the default then follows the data (D21).
  const [override, setOverride] = useState<boolean | null>(null)
  const open = override ?? (upcoming.length === 0 && departed.length > 0)

  return (
    <SectionCard title="Ocupación" padded={false}>
      {items.length === 0 ? (
        <Box sx={{ px: 3, pb: 3 }}>
          <Typography color="text.secondary">
            {loading ? 'Cargando…' : 'Sin servicios este día.'}
          </Typography>
          {!loading && (
            // D6 — the named exclusion: lodging has no departures, so it does not appear here yet.
            <Typography variant="caption" color="text.secondary">
              Solo servicios con horario; hospedaje aún no aparece aquí.
            </Typography>
          )}
        </Box>
      ) : (
        <>
          {departed.length > 0 && (
            <PastSummary items={departed} open={open} onToggle={() => setOverride(!open)} />
          )}
          {/* pb 1.5 + the last row's 12px = a 24px card bottom, matching the padded cards. */}
          <Box sx={{ px: 3, pb: 1.5 }}>
            <Collapse in={open}>
              <Box>
                {departed.map((i) => (
                  <TimelineRow key={i.slot_id} item={i} past />
                ))}
              </Box>
            </Collapse>
            {upcoming.map((i) => (
              <TimelineRow key={i.slot_id} item={i} past={false} />
            ))}
            {isToday && upcoming.length === 0 && (
              <Typography variant="body2" color="text.secondary" sx={{ py: 1.5 }}>
                Ya no queda ningún servicio por salir hoy.
              </Typography>
            )}
          </Box>
        </>
      )}
    </SectionCard>
  )
}
