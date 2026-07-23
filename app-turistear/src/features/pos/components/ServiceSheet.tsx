import {
  SwipeableDrawer,
  Box,
  CircularProgress,
  Alert,
  IconButton,
} from '@mui/material'
import CloseRounded from '@mui/icons-material/CloseRounded'
import { usePosService } from '../hooks'
import { usePosFilters } from '../../../store/posFilters'
import { ServiceSelectionPanel } from './ServiceSelectionPanel'
import { todayStr, addDays } from '../dates'
import { useMyOrganization } from '../../organization'

interface ServiceSheetProps {
  /** The service to configure; `null` keeps the sheet closed. */
  serviceId: string | null
  /** US-AG33 — the catalog card's next available departure (bounded to the agent's selected
   * window). With no explicit date pick, the sheet opens its 3-day window here so the service's
   * upcoming schedule shows immediately. `null` (no in-window availability) falls back to today. */
  nextSlotDate?: string | null
  onClose: () => void
  /** Bubbled up from the panel after a line is staged — the catalog closes + snackbars. */
  onAdded: () => void
}

// US-AG31 — the Bottom Sheet: an animated panel that slides up over the catalog (overlay +
// slide-up via the drawer backdrop/transition) carrying the sale-configuration interface,
// without navigating away. Loads the service detail scoped by the catalog's inherited day
// context (US-AG30), so the slot matrix matches the date the agent filtered to.
export function ServiceSheet({
  serviceId,
  nextSlotDate,
  onClose,
  onAdded,
}: ServiceSheetProps) {
  // US-AG30/AG33 — inherit the catalog's selected day. An explicit date stays a single day
  // (a hyper-specific search shouldn't get extra noise). With no explicit pick, the sheet opens
  // on the service's next available departure (`nextSlotDate`) rather than blindly on today, so a
  // service that doesn't run today still surfaces its upcoming schedule immediately — then a
  // rolling 3-day window [start, start+2] from there. Falls back to today when the card reported
  // no in-window availability. The global filter is never mutated (`today` stays real today).
  const anchor = usePosFilters((s) => s.selection?.from ?? null)
  const { data: org } = useMyOrganization()
  const today = todayStr(org?.timezone) // US-A66 — org-local "today"
  const start = anchor ?? nextSlotDate ?? today
  const days = anchor
    ? [anchor]
    : [start, addDays(start, 1), addDays(start, 2)]
  const range = { from: days[0], to: days[days.length - 1] }
  const {
    data: service,
    isLoading,
    isError,
  } = usePosService(serviceId ?? undefined, range)

  return (
    <SwipeableDrawer
      anchor="bottom"
      open={serviceId !== null}
      onClose={onClose}
      onOpen={() => {}}
      disableSwipeToOpen
      slotProps={{
        paper: {
          sx: {
            borderTopLeftRadius: 'var(--radius-xl, 20px)',
            borderTopRightRadius: 'var(--radius-xl, 20px)',
            // The sheet grows upward from the base as content is added; the matrix inside
            // scrolls once it would exceed this cap. The footer stays pinned to the base.
            maxHeight: '85vh',
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
            // Structure-first: a solid white sheet that casts a real upward shadow (overlays
            // are the one place the system uses elevation). Mirrors the shared BottomSheet.
            backgroundColor: '#FFFFFF',
            boxShadow: 'var(--shadow-sheet, 0 -8px 30px rgba(15,23,42,0.12))',
          },
        },
      }}
    >
      {/* Grab puller + close affordance (elegant-minimalist) — fixed. */}
      <Box sx={{ position: 'relative', pt: 1.5, pb: 0.5, flexShrink: 0 }}>
        <Box
          sx={{
            width: 36,
            height: 4,
            borderRadius: 2,
            bgcolor: 'divider',
            mx: 'auto',
          }}
        />
        <IconButton
          size="small"
          aria-label="Cerrar"
          onClick={onClose}
          sx={{ position: 'absolute', top: 4, right: 8 }}
        >
          <CloseRounded fontSize="small" />
        </IconButton>
      </Box>

      {isLoading && (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
          <CircularProgress />
        </Box>
      )}

      {isError && (
        <Box sx={{ px: 3, py: 3 }}>
          <Alert severity="error">
            No se pudo cargar este servicio. Por favor, inténtalo de nuevo.
          </Alert>
        </Box>
      )}

      {service && (
        <ServiceSelectionPanel
          service={service}
          days={days}
          today={today}
          onAdded={onAdded}
        />
      )}
    </SwipeableDrawer>
  )
}
