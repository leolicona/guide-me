import { Chip } from '@mui/material'

interface AvailabilityChipProps {
  /** US-AG30 — the catalog read returns a windowed boolean, not a count. */
  available: boolean
}

// Available / sold-out hint for a catalog card, using the single accent palette
// sparingly (elegant-minimalist). The per-slot remaining count lives on the detail
// screen — the catalog payload is intentionally count-free (US-AG30).
export function AvailabilityChip({ available }: AvailabilityChipProps) {
  return available ? (
    <Chip size="small" color="success" variant="outlined" label="Disponible" />
  ) : (
    <Chip size="small" variant="outlined" label="Agotado" />
  )
}
