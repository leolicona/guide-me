import type { ReactElement } from 'react'
import HistoryEduRounded from '@mui/icons-material/HistoryEduRounded'
import TaskAltRounded from '@mui/icons-material/TaskAltRounded'
import TimerRounded from '@mui/icons-material/TimerRounded'
import ReportProblemRounded from '@mui/icons-material/ReportProblemRounded'
import GavelRounded from '@mui/icons-material/GavelRounded'
import type { AckState } from '../types'
import type { StatusTone } from '../../../components'
import { StatusChip } from '../../../components'

// Presentation for the acknowledgment lifecycle (US-AG27/AG28). Quiet by design: terminal states
// are neutral; only the contested state carries colour. `not_required` renders nothing — most
// drops never owe a signature.
//
// `pending` is NEUTRAL on purpose, though it is the one actionable state here. The obligation
// already shouts once, correctly, at the top of the page: `PendingAcknowledgments` renders it as a
// warning AlertCard with the Firmar / Disputar buttons. Repeating it as a second amber pill beside
// the drop's own green «Confirmado» made one row state two things at once — a design review read it
// as contradictory (`.design/balance/DESIGN_REVIEW.md`, Should Fix 12). One obligation, one call to
// action; the row keeps the fact, not the alarm.
const ACK: Record<
  Exclude<AckState, 'not_required'>,
  { tone: StatusTone; icon: ReactElement; label: string }
> = {
  pending: { tone: 'neutral', icon: <HistoryEduRounded />, label: 'Por firmar' },
  signed: { tone: 'neutral', icon: <TaskAltRounded />, label: 'Firmado' },
  auto_signed: { tone: 'neutral', icon: <TimerRounded />, label: 'Auto-firmado' },
  disputed: { tone: 'error', icon: <ReportProblemRounded />, label: 'En disputa' },
  resolved: { tone: 'neutral', icon: <GavelRounded />, label: 'Disputa resuelta' },
}

export function AckChip({ state, size = 'small' }: { state: AckState; size?: 'small' | 'medium' }) {
  if (state === 'not_required') return null
  const { tone, icon, label } = ACK[state]
  return <StatusChip tone={tone} icon={icon} label={label} size={size} />
}
