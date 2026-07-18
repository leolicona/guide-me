import type { DropSource } from '../types'

// Non-component presentation helpers for the acknowledgment lifecycle (US-AG27/AG28).
// Kept out of AckChip.tsx so that file stays component-only (react-refresh rule).

export const SOURCE_LABEL: Record<DropSource, string> = {
  agent: 'Entrega del agente',
  admin: 'Cobro directo',
}

// Human countdown to the auto-sign instant ("Se confirma automáticamente en 23 h").
export function ackCountdown(ackDueAt: number | null): string | null {
  if (ackDueAt == null) return null
  const seconds = ackDueAt - Math.floor(Date.now() / 1000)
  if (seconds <= 0) return null
  const hours = Math.floor(seconds / 3600)
  if (hours >= 1) return `Se confirma automáticamente en ${hours} h`
  return `Se confirma automáticamente en ${Math.max(1, Math.floor(seconds / 60))} min`
}
