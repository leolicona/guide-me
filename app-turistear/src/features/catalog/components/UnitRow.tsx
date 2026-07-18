import type { ReactNode } from 'react'
import { Box, Stack, Typography, Chip } from '@mui/material'
import { MoneyText, StatusChip } from '../../../components'
import { amenityLabel } from '../lodging'

export interface UnitRowData {
  name: string
  unit_type?: string | null
  /** v2 — rooms of this type in inventory (1 = boutique/unique). */
  inventory_count?: number
  beds: number
  base_occupancy: number
  max_capacity: number
  /** Lowest nightly rate (minor units) — "Desde $X / noche". */
  from_rate: number
  amenities: string[]
  /** Omit in the wizard (drafts are always active until saved). */
  status?: 'active' | 'inactive'
}

interface UnitRowProps {
  unit: UnitRowData
  /** Right/below action buttons (Editar / Temporadas / Bloqueos / …). */
  actions?: ReactNode
}

// A bordered list item (not a nested card): name leads, "Desde $X/noche" reads first among the
// figures, capacity + amenity chips support, a StatusChip on the right. Inactive rows render muted.
export function UnitRow({ unit, actions }: UnitRowProps) {
  const inactive = unit.status === 'inactive'
  const shownAmenities = unit.amenities.slice(0, 3)
  const extra = unit.amenities.length - shownAmenities.length

  return (
    <Box
      sx={{
        border: '1px solid var(--slate-200, #E2E8F0)',
        borderRadius: 'var(--radius-md, 12px)',
        p: 2,
        opacity: inactive ? 0.6 : 1,
      }}
    >
      <Stack direction="row" sx={{ justifyContent: 'space-between', alignItems: 'flex-start', gap: 1 }}>
        <Box sx={{ minWidth: 0 }}>
          <Typography sx={{ fontSize: 18, fontWeight: 600 }} noWrap>
            {unit.name}
          </Typography>
          <Typography variant="body2" color="text.secondary">
            {unit.unit_type ? `${unit.unit_type} · ` : ''}
            {unit.inventory_count != null
              ? `${unit.inventory_count} ${unit.inventory_count === 1 ? 'habitación' : 'habitaciones'} · `
              : ''}
            {unit.beds} {unit.beds === 1 ? 'cama' : 'camas'} · {unit.base_occupancy}–
            {unit.max_capacity} personas
          </Typography>
        </Box>
        {unit.status && (
          <StatusChip
            status={unit.status === 'active' ? 'active' : 'suspended'}
            label={unit.status === 'active' ? 'Activa' : 'Inactiva'}
          />
        )}
      </Stack>

      <MoneyText
        cents={unit.from_rate}
        variant="subtitle1"
        srLabel="Desde, por noche"
        sx={{ mt: 1, display: 'block' }}
      />
      <Typography variant="caption" color="text.secondary">
        Desde, por noche
      </Typography>

      {unit.amenities.length > 0 && (
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, mt: 1 }}>
          {shownAmenities.map((a) => (
            <Chip
              key={a}
              size="small"
              label={amenityLabel(a)}
              sx={{ borderRadius: 'var(--radius-full, 9999px)' }}
            />
          ))}
          {extra > 0 && (
            <Chip
              size="small"
              label={`+${extra}`}
              sx={{ borderRadius: 'var(--radius-full, 9999px)' }}
            />
          )}
        </Box>
      )}

      {actions && (
        <Stack
          direction="row"
          spacing={1}
          sx={{
            mt: 1.5,
            flexWrap: 'wrap',
            gap: 1,
            // Hierarchy (one-confident-accent law): repeated per-row utilities are neutral —
            // teal is reserved for the section's single primary CTA. Buttons with an explicit
            // semantic color (e.g. color="error") are untouched.
            '& .MuiButton-text.MuiButton-colorPrimary, & .MuiButton-text.MuiButton-colorSecondary, & .MuiButton-text.MuiButton-colorInherit':
              {
                color: 'text.secondary',
              },
          }}
        >
          {actions}
        </Stack>
      )}
    </Box>
  )
}
