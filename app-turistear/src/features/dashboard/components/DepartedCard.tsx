import { useState } from 'react'
import { Box, Collapse, Divider, IconButton, Stack, Typography } from '@mui/material'
import ExpandMoreRounded from '@mui/icons-material/ExpandMoreRounded'
import PersonOffRounded from '@mui/icons-material/PersonOffRounded'
import CheckCircleRounded from '@mui/icons-material/CheckCircleRounded'
import { SectionCard, StatusChip } from '../../../components'
import type { DashboardDepartedRow } from '../../../services/dashboardService'

// US-A90 / D9 — «Ya partieron»: today's departed slots report what happened instead of
// disappearing. Boarding derives from redeemed_count (US-A85 — never stored), so a passenger
// scanned late simply stops being a no-show on the next poll. Collapsed by default: what is
// still sellable stays on top.
export function DepartedCard({ rows }: { rows: DashboardDepartedRow[] }) {
  const [open, setOpen] = useState(false)
  if (rows.length === 0) return null
  const sinUsar = rows.reduce((n, r) => n + r.sin_usar, 0)

  return (
    <SectionCard
      title="Ya partieron"
      padded={false}
      action={
        <IconButton
          onClick={() => setOpen((v) => !v)}
          aria-label={open ? 'Ocultar salidas pasadas' : 'Mostrar salidas pasadas'}
          aria-expanded={open}
          sx={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 150ms' }}
        >
          <ExpandMoreRounded />
        </IconButton>
      }
    >
      <Box sx={{ px: 3, pb: open ? 0 : 2 }}>
        <Typography variant="body2" color="text.secondary" className="numeric">
          {rows.length === 1 ? '1 salida' : `${rows.length} salidas`}
          {sinUsar > 0 ? ` · ${sinUsar} asientos sin usar` : ' · todos abordaron'}
        </Typography>
      </Box>
      <Collapse in={open}>
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
                  {r.abordaron}/{r.vendidos} abordaron
                </Typography>
              </Box>
              {r.sin_usar > 0 ? (
                <StatusChip
                  tone="warning"
                  icon={<PersonOffRounded />}
                  label={`${r.sin_usar} sin usar`}
                  size="small"
                />
              ) : (
                <StatusChip
                  tone="success"
                  icon={<CheckCircleRounded />}
                  label="Completo"
                  size="small"
                />
              )}
            </Stack>
          ))}
        </Stack>
      </Collapse>
    </SectionCard>
  )
}
