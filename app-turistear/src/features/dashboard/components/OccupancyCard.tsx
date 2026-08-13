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

const seatsLine = (r: DashboardOccupancyRow): string => {
  const parts = [`${r.vendidos} vendidos`]
  if (r.apartados > 0) parts.push(`${r.apartados} apartados`)
  parts.push(`quedan ${r.remaining}`)
  return parts.join(' · ')
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
          {rows.map((r) => (
            <Stack
              key={r.slot_id}
              direction="row"
              spacing={2}
              sx={{ alignItems: 'center', py: 1.5 }}
            >
              <Typography className="numeric" sx={{ fontWeight: 700, width: 52, flexShrink: 0 }}>
                {r.start_time}
              </Typography>
              <Box sx={{ minWidth: 0, flex: 1 }}>
                <Typography sx={{ fontWeight: 600 }} noWrap>
                  {r.service_name}
                </Typography>
                <Typography variant="body2" color="text.secondary" className="numeric">
                  {seatsLine(r)}
                </Typography>
              </Box>
              <Stack sx={{ alignItems: 'flex-end', flexShrink: 0 }} spacing={0.5}>
                <OccupancyChip row={r} />
                {r.booked >= r.capacity && r.flex_extra > 0 && (
                  <Typography variant="caption" color="warning.main" className="numeric">
                    +{r.flex_extra} extra
                  </Typography>
                )}
              </Stack>
            </Stack>
          ))}
        </Stack>
      )}
    </SectionCard>
  )
}
