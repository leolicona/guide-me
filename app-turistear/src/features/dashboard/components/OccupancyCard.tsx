import { Box, Divider, Stack, Typography } from '@mui/material'
import BlockRounded from '@mui/icons-material/BlockRounded'
import CheckCircleRounded from '@mui/icons-material/CheckCircleRounded'
import GroupsRounded from '@mui/icons-material/GroupsRounded'
import { SectionCard, StatusChip } from '../../../components'
import type { DashboardOccupancyRow } from '../../../services/dashboardService'

// D11 — the occupancy traffic light: green < 80 % booked · amber ≥ 80 % · red at booked ≥ BASE
// capacity, with the «+N extra» hint when a flexible service still has sellable margin. Computed
// here from the returned numbers; always icon-paired (state is never color-alone, Tokens §3).
type OccupancyLevel = 'available' | 'nearly_full' | 'full'

const occupancyLevel = (r: DashboardOccupancyRow): OccupancyLevel =>
  r.booked >= r.capacity ? 'full' : r.booked >= 0.8 * r.capacity ? 'nearly_full' : 'available'

function OccupancyChip({ row }: { row: DashboardOccupancyRow }) {
  const level = occupancyLevel(row)
  if (level === 'full') {
    return <StatusChip tone="error" icon={<BlockRounded />} label="Lleno" size="small" />
  }
  if (level === 'nearly_full') {
    return <StatusChip tone="warning" icon={<GroupsRounded />} label="Casi lleno" size="small" />
  }
  return <StatusChip tone="success" icon={<CheckCircleRounded />} label="Disponible" size="small" />
}

// "quedan N" is the datum the admin scans for, so it leads the line in ink while the sold/held
// detail stays secondary (hierarchy: emphasize the data, soften its context).
const seatsDetail = (r: DashboardOccupancyRow): string => {
  const parts: string[] = []
  if (r.vendidos > 0) parts.push(`${r.vendidos} vendidos`)
  if (r.apartados > 0) parts.push(`${r.apartados} apartados`)
  return parts.map((p) => ` · ${p}`).join('')
}

export function OccupancyCard({
  rows,
  loading,
}: {
  rows: DashboardOccupancyRow[]
  loading: boolean
}) {
  return (
    <SectionCard title="Salidas" padded={false}>
      {rows.length === 0 ? (
        <Box sx={{ p: 3 }}>
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
        <Stack divider={<Divider />} sx={{ px: 3, py: 1 }}>
          {/* Two-line row: the name owns the full width (390px screens truncated it against the
              chip), and the chip shares the second line with the seat numbers it qualifies. */}
          {rows.map((r) => (
            <Stack key={r.slot_id} spacing={0.75} sx={{ py: 1.5 }}>
              <Stack direction="row" spacing={2} sx={{ alignItems: 'baseline' }}>
                <Typography className="numeric" sx={{ fontWeight: 700, width: 52, flexShrink: 0 }}>
                  {r.start_time}
                </Typography>
                <Typography sx={{ fontWeight: 600, minWidth: 0 }} noWrap>
                  {r.service_name}
                </Typography>
              </Stack>
              <Stack
                direction="row"
                spacing={1}
                sx={{ alignItems: 'center', pl: '68px' /* 52px time column + 16px gap */ }}
              >
                <Typography
                  variant="body2"
                  color="text.secondary"
                  className="numeric"
                  noWrap
                  sx={{ flex: 1, minWidth: 0 }}
                >
                  <Box component="span" sx={{ color: 'text.primary', fontWeight: 600 }}>
                    quedan {r.remaining}
                  </Box>
                  {seatsDetail(r)}
                </Typography>
                {r.booked >= r.capacity && r.flex_extra > 0 && (
                  <Typography variant="caption" color="warning.main" className="numeric" noWrap>
                    +{r.flex_extra} extra
                  </Typography>
                )}
                <OccupancyChip row={r} />
              </Stack>
            </Stack>
          ))}
        </Stack>
      )}
    </SectionCard>
  )
}
