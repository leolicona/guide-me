import { Chip } from '@mui/material'

// Below this many remaining spots a service reads as "close to capacity" (US-AG10).
const LOW_THRESHOLD = 5

interface AvailabilityChipProps {
  spots: number
}

// available / close-to-capacity / full hint, using the single accent palette
// sparingly (elegant-minimalist).
export function AvailabilityChip({ spots }: AvailabilityChipProps) {
  if (spots <= 0) {
    return <Chip size="small" variant="outlined" label="Full" />
  }
  if (spots <= LOW_THRESHOLD) {
    return (
      <Chip size="small" color="warning" variant="outlined" label={`${spots} left`} />
    )
  }
  return <Chip size="small" color="success" variant="outlined" label="Available" />
}
