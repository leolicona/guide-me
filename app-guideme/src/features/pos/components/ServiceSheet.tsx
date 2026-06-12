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

interface ServiceSheetProps {
  /** The service to configure; `null` keeps the sheet closed. */
  serviceId: string | null
  onClose: () => void
  /** Bubbled up from the panel after a line is staged — the catalog closes + snackbars. */
  onAdded: () => void
}

// US-AG31 — the Bottom Sheet: an animated panel that slides up over the catalog (overlay +
// slide-up via the drawer backdrop/transition) carrying the sale-configuration interface,
// without navigating away. Loads the service detail scoped by the catalog's inherited day
// context (US-AG30), so the slot matrix matches the date the agent filtered to.
export function ServiceSheet({ serviceId, onClose, onAdded }: ServiceSheetProps) {
  // US-AG30 — inherit the catalog's selected day: an explicit date scopes the slot list to
  // that day; the "Hoy" anchor (null) shows today onward (the default, unregressed).
  const selectedDate = usePosFilters((s) => s.selectedDate)
  const range = selectedDate
    ? { from: selectedDate, to: selectedDate }
    : undefined
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
            borderTopLeftRadius: 16,
            borderTopRightRadius: 16,
            maxHeight: '85vh',
          },
        },
      }}
    >
      {/* Grab puller + close affordance (elegant-minimalist). */}
      <Box sx={{ position: 'relative', pt: 1.5 }}>
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

      <Box sx={{ px: 3, pt: 2, pb: 4, overflowY: 'auto' }}>
        {isLoading && (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
            <CircularProgress />
          </Box>
        )}

        {isError && (
          <Alert severity="error">
            No se pudo cargar este servicio. Por favor, inténtalo de nuevo.
          </Alert>
        )}

        {service && <ServiceSelectionPanel service={service} onAdded={onAdded} />}
      </Box>
    </SwipeableDrawer>
  )
}
