import { useState } from 'react'
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
import { ExpressSalePanel } from './ExpressSalePanel'
import { todayStr } from '../dates'
import { useMyOrganization } from '../../organization'

interface ServiceSheetProps {
  /** The service to configure; `null` keeps the sheet closed. */
  serviceId: string | null
  /** US-AG33 — the catalog card's next available departure (bounded to the agent's selected
   * window). With no explicit date pick, the sheet opens its 3-day window here so the service's
   * upcoming schedule shows immediately. `null` (no in-window availability) falls back to today. */
  nextSlotDate?: string | null
  /** US-AG45 (D1) — ⚡ Venta Express: same sheet, second body. Express is same-day ONLY and
   * IGNORES the catalog's selected date (D5 — the customer is standing at the counter). */
  express?: boolean
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
  express = false,
  onClose,
  onAdded,
}: ServiceSheetProps) {
  // US-AG57 (D5) — the sheet OPENS on the catalog's filter → else the service's next departure
  // WITH ROOM (`nextSlotDate`, corrected by US-AG56) → else today. From there the seller navigates
  // freely inside the sheet's own calendar: the opening day is a starting point, not a restriction,
  // so a customer changing their mind at the counter no longer costs a close-refilter-reopen. The
  // global filter is never mutated (`today` stays real today).
  const anchor = usePosFilters((s) => s.selection?.from ?? null)
  const { data: org } = useMyOrganization()
  const today = todayStr(org?.timezone) // US-A66 — org-local "today"
  const opening = anchor ?? nextSlotDate ?? today
  const [selectedDate, setSelectedDate] = useState(opening)

  // Re-anchor whenever the sheet opens on a different service (the component stays mounted
  // across cards). Render-time "store previous prop" so it lands before paint.
  const [lastServiceId, setLastServiceId] = useState(serviceId)
  if (serviceId !== lastServiceId) {
    setLastServiceId(serviceId)
    setSelectedDate(opening)
  }

  // US-AG45 (D5) — Express is TODAY only, whatever the catalog is filtered to: a walk-up at the
  // counter must never be sold a ticket for the day the agent happened to be browsing.
  // US-AG57 (D2) — otherwise the sheet fetches ONE day at a time. The month's availability marks
  // come from the ~1 KB `/availability/days` read instead, so opening a card no longer has to
  // choose between a short window and a heavy payload.
  const range = express
    ? { from: today, to: today }
    : { from: selectedDate, to: selectedDate }
  const {
    data: service,
    isLoading,
    isFetching,
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

      {service &&
        (express ? (
          <ExpressSalePanel service={service} today={today} />
        ) : (
          <ServiceSelectionPanel
            service={service}
            selectedDate={selectedDate}
            onSelectDate={setSelectedDate}
            slotsLoading={isFetching}
            today={today}
            onAdded={onAdded}
          />
        ))}
    </SwipeableDrawer>
  )
}
