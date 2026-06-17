import { Box } from '@mui/material'
import { alpha } from '@mui/material/styles'

interface AvailabilityChipProps {
  /** US-AG30 — the catalog read returns a windowed boolean, not a count. */
  available: boolean
}

// Available / sold-out hint for a catalog card (Luminous SaaS): a low-saturation status
// pill — a soft tinted background with a small status dot and an uppercase, wide-tracked
// label. Green = availability (functional accent), neutral = sold out. The per-slot
// remaining count lives on the detail screen — the catalog payload is count-free (US-AG30).
export function AvailabilityChip({ available }: AvailabilityChipProps) {
  return (
    <Box
      sx={(t) => ({
        flexShrink: 0,
        display: 'inline-flex',
        alignItems: 'center',
        gap: 0.75,
        px: 1,
        py: 0.375,
        borderRadius: 1,
        bgcolor: available
          ? alpha(t.palette.success.main, 0.12)
          : alpha(t.palette.text.primary, 0.06),
      })}
    >
      <Box
        sx={(t) => ({
          width: 6,
          height: 6,
          borderRadius: '50%',
          bgcolor: available ? t.palette.success.main : t.palette.text.disabled,
        })}
      />
      <Box
        component="span"
        sx={(t) => ({
          fontSize: 10,
          fontWeight: 600,
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
          lineHeight: 1.2,
          color: available ? t.palette.success.dark : t.palette.text.secondary,
        })}
      >
        {available ? 'Disponible' : 'Agotado'}
      </Box>
    </Box>
  )
}
