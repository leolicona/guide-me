import { Chip } from '@mui/material'
import type { AckState } from '../types'

// Presentation for the acknowledgment lifecycle (US-AG27/AG28). Quiet by design: terminal
// states are neutral; only the actionable (pending) and contested (disputed) states carry
// color. `not_required` renders nothing — most drops never owe a signature.
const ACK_PRESENTATION: Record<
  Exclude<AckState, 'not_required'>,
  { label: string; color: 'warning' | 'error' | 'default' }
> = {
  pending: { label: 'Por firmar', color: 'warning' },
  signed: { label: 'Firmado', color: 'default' },
  auto_signed: { label: 'Auto-firmado', color: 'default' },
  disputed: { label: 'En disputa', color: 'error' },
  resolved: { label: 'Disputa resuelta', color: 'default' },
}

export function AckChip({ state, size = 'small' }: { state: AckState; size?: 'small' | 'medium' }) {
  if (state === 'not_required') return null
  const { label, color } = ACK_PRESENTATION[state]
  return <Chip size={size} variant="outlined" color={color} label={label} />
}
