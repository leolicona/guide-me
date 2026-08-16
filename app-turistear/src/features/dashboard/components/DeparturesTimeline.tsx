import { useMemo, useState } from 'react'
import { Box, ButtonBase, Collapse, Typography } from '@mui/material'
import BlockRounded from '@mui/icons-material/BlockRounded'
import CheckCircleRounded from '@mui/icons-material/CheckCircleRounded'
import ExpandMoreRounded from '@mui/icons-material/ExpandMoreRounded'
import GroupsRounded from '@mui/icons-material/GroupsRounded'
import PersonOffRounded from '@mui/icons-material/PersonOffRounded'
import RemoveCircleOutlineRounded from '@mui/icons-material/RemoveCircleOutlineRounded'
import { SectionCard, StatusChip } from '../../../components'
import type { DashboardDay } from '../../../services/dashboardService'
import { useOrgClock } from '../hooks/useOrgClock'
import { hasDeparted, timelineItems, type TimelineItem } from '../timeline'

// D20 — the rail IS the time column: ONE absolutely-positioned hairline at the column's right
// edge (see the relative wrapper in DeparturesTimeline), so the spine is a single unbroken stroke
// that runs through the «Ahora» node instead of restarting per row. Costs zero horizontal space,
// which is the whole point — the service names keep every pixel PR #104 won them.
const TIME_COL = 52

// D11 (unchanged) — the traffic light for what is still sellable · D19 — and its deliberate
// absence once a slot has left: a departed service may never claim "Disponible", so a row that
// crossed the marker between polls carries NO chip until its boarding numbers arrive.
function RowChip({ item, past }: { item: TimelineItem; past: boolean }) {
  if (past) {
    if (!item.boarding) return null
    const { sin_usar, vendidos } = item.boarding
    if (sin_usar > 0) {
      return (
        <StatusChip
          tone="warning"
          icon={<PersonOffRounded />}
          label={sin_usar === 1 ? '1 sin usar' : `${sin_usar} sin usar`}
          size="small"
        />
      )
    }
    // A departed slot with nothing sold (e.g. fully cancelled) must not read "Completo".
    if (vendidos === 0) {
      return (
        <StatusChip
          tone="neutral"
          icon={<RemoveCircleOutlineRounded />}
          label="Sin ventas"
          size="small"
        />
      )
    }
    return <StatusChip tone="success" icon={<CheckCircleRounded />} label="Completo" size="small" />
  }

  if (!item.seats) return null
  const { booked, capacity } = item.seats
  if (booked >= capacity) {
    return <StatusChip tone="error" icon={<BlockRounded />} label="Lleno" size="small" />
  }
  if (booked >= 0.8 * capacity) {
    return <StatusChip tone="warning" icon={<GroupsRounded />} label="Casi lleno" size="small" />
  }
  return <StatusChip tone="success" icon={<CheckCircleRounded />} label="Disponible" size="small" />
}

// "quedan N" is the datum the admin scans for, so it leads the line in ink while the sold/held
// detail stays secondary. A row that has left reports boarding instead — or, for the ≤60 s before
// the poll catches up, keeps its seat line (greyed, and stripped of its chip above).
function RowDetail({ item, past }: { item: TimelineItem; past: boolean }) {
  if (item.boarding) {
    return (
      <>
        {item.boarding.abordaron}/{item.boarding.vendidos} abordaron
      </>
    )
  }
  if (!item.seats) return null
  const parts: string[] = []
  if (item.seats.vendidos > 0) parts.push(`${item.seats.vendidos} vendidos`)
  if (item.seats.apartados > 0) parts.push(`${item.seats.apartados} apartados`)
  return (
    <>
      <Box
        component="span"
        sx={{ color: past ? 'inherit' : 'text.primary', fontWeight: past ? 400 : 600 }}
      >
        quedan {item.seats.remaining}
      </Box>
      {parts.map((p) => ` · ${p}`).join('')}
    </>
  )
}

// The two-line row PR #104 settled: full-width name, then data + chip. NOTHING truncates. D19 —
// "past" is expressed by de-emphasising the row's own text; the chips keep full strength, because
// an unnoticed no-show is the one thing on a finished departure still worth acting on.
function TimelineRow({ item, past }: { item: TimelineItem; past: boolean }) {
  const ink = past ? 'text.secondary' : 'text.primary'
  return (
    <Box sx={{ display: 'flex' }}>
      <Box sx={{ width: TIME_COL, flexShrink: 0, pt: 1.5 }}>
        <Typography className="numeric" sx={{ fontWeight: 700, color: ink }}>
          {item.start_time}
        </Typography>
      </Box>
      {/* No border here — the shared rail behind these rows is drawn once by the parent (D20). */}
      <Box sx={{ flex: 1, minWidth: 0, pl: 2, py: 1.5 }}>
        <Typography sx={{ fontWeight: 600, color: ink }}>{item.service_name}</Typography>
        <Box
          sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 1, mt: 0.75 }}
        >
          <Typography
            variant="body2"
            color="text.secondary"
            className="numeric"
            sx={{ flex: '1 1 auto' }}
          >
            <RowDetail item={item} past={past} />
          </Typography>
          {!past && item.seats && item.seats.booked >= item.seats.capacity && item.seats.flex_extra > 0 && (
            <Typography variant="caption" color="warning.main" className="numeric" noWrap>
              +{item.seats.flex_extra} extra
            </Typography>
          )}
          <RowChip item={item} past={past} />
        </Box>
      </Box>
    </Box>
  )
}

// D18/D20-rev — «Ahora» is a NODE on the spine, not a bar across the card: a small ink dot
// centered exactly on the rail's 1px stroke, the org-local clock bold in the same column as every
// other time, and a hairline whisper to the right edge. The bold time + solid dot carry the
// marker; the heavy 2px crossbar it replaces was the loudest stroke on the page.
function NowMarker({ now }: { now: string }) {
  return (
    <Box
      role="separator"
      aria-label={`Ahora, ${now}`}
      sx={{ display: 'flex', alignItems: 'center', py: 0.5 }}
    >
      <Typography
        className="numeric"
        sx={{ width: TIME_COL, flexShrink: 0, fontWeight: 700, color: 'text.primary' }}
      >
        {now}
      </Typography>
      {/* 9px dot at ml:-4px → its center lands on the rail's x (TIME_COL) + half the 1px stroke. */}
      <Box
        sx={{
          position: 'relative',
          width: 9,
          height: 9,
          borderRadius: '50%',
          bgcolor: 'text.primary',
          ml: '-4px',
          flexShrink: 0,
        }}
      />
      <Box sx={{ flex: 1, height: '1px', bgcolor: 'grey.200', ml: 1.5 }} />
    </Box>
  )
}

// D21 — collapsed, the past segment is the ONLY thing standing between the admin and today's
// no-shows, so the summary carries the count and the miss itself (icon-paired amber, never colour
// alone). Rows that have not been re-polled yet contribute no boarding claim: with none known we
// say nothing rather than "todos abordaron".
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
  const sinUsar = known.reduce((n, i) => n + (i.boarding?.sin_usar ?? 0), 0)

  return (
    <ButtonBase
      onClick={onToggle}
      aria-expanded={open}
      aria-label={open ? 'Ocultar las salidas que ya partieron' : 'Mostrar las salidas que ya partieron'}
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
        {items.length === 1 ? '1 ya partió' : `${items.length} ya partieron`}
      </Typography>
      {known.length > 0 &&
        (sinUsar > 0 ? (
          <Box
            sx={{
              display: 'flex',
              alignItems: 'center',
              gap: 0.5,
              color: 'var(--color-warning-fg, #92400E)',
            }}
          >
            <Typography variant="body2" color="text.secondary" sx={{ mr: 0.5 }}>
              ·
            </Typography>
            <PersonOffRounded sx={{ fontSize: 18 }} />
            <Typography variant="body2" className="numeric" sx={{ fontWeight: 600 }}>
              {sinUsar === 1 ? '1 sin usar' : `${sinUsar} sin usar`}
            </Typography>
          </Box>
        ) : (
          <Typography variant="body2" color="text.secondary">
            · todos abordaron
          </Typography>
        ))}
    </ButtonBase>
  )
}

/**
 * US-A14/A90 — the day's departures as ONE chronological timeline (D9 amended). «Ya partieron» is
 * no longer a second card but the segment above the «Ahora» marker, which is why peeking at a
 * future day can no longer leak today's departures onto tomorrow's list: on a future day nothing
 * has departed *by construction*, so there is no state left to get wrong.
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

  // D22 — the title is day-agnostic: the day strip already says which day this is, and a title
  // that changes under the user's thumb as they tap through it is noise, not confirmation.
  return (
    <SectionCard title="Salidas" padded={false}>
      {items.length === 0 ? (
        <Box sx={{ px: 3, pb: 3 }}>
          <Typography color="text.secondary">
            {loading ? 'Cargando…' : 'Sin salidas este día.'}
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
            {/* D20 — the spine, drawn ONCE: a single hairline the rows share and the «Ahora» dot
                sits on. Per-row borders would restart it at every row and leave a hole at the
                marker — one continuous stroke is both fewer lines and truer to what it depicts. */}
            <Box sx={{ position: 'relative' }}>
              <Box
                aria-hidden
                sx={{
                  position: 'absolute',
                  left: TIME_COL,
                  top: 8,
                  bottom: 8,
                  width: '1px',
                  bgcolor: 'grey.200',
                }}
              />
              <Collapse in={open}>
                <Box>
                  {departed.map((i) => (
                    <TimelineRow key={i.slot_id} item={i} past />
                  ))}
                </Box>
              </Collapse>
              {isToday && <NowMarker now={now} />}
              {upcoming.map((i) => (
                <TimelineRow key={i.slot_id} item={i} past={false} />
              ))}
              {isToday && upcoming.length === 0 && (
                <Typography variant="body2" color="text.secondary" sx={{ pl: `${TIME_COL + 16}px`, py: 1.5 }}>
                  Ya no queda ninguna salida hoy.
                </Typography>
              )}
            </Box>
          </Box>
        </>
      )}
    </SectionCard>
  )
}
