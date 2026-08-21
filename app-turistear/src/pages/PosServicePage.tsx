import { useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import {
  Box,
  Button,
  Card,
  CardContent,
  CircularProgress,
  Alert,
  Fade,
  Snackbar,
} from '@mui/material'
import { usePosService } from '../features/pos/hooks'
import { ServiceSelectionPanel } from '../features/pos/components/ServiceSelectionPanel'
import { todayStr, posWindow, eachDay } from '../features/pos/dates'
import { usePosFilters } from '../store/posFilters'
import { ROUTES } from '../config/routes'

// US-AG31 — deep-link / fallback full-page view of a service. The primary path is the
// catalog Bottom Sheet (ServiceSheet); this page reuses the same ServiceSelectionPanel so
// the selection logic lives in exactly one place.
export default function PosServicePage() {
  const { id } = useParams<{ id: string }>()
  // US-AG30/AG33/AG35, BUG-032 — inherit the catalog's selection WHOLE, the same way the Bottom
  // Sheet does: a range keeps its `to`, a single-day pick collapses to that day, and no pick at
  // all means the contextual week. Reading only `selection.from` hid every departure after the
  // range's first day.
  const selection = usePosFilters((s) => s.selection)
  const today = todayStr()
  const win = posWindow(selection, today)
  const days = eachDay(win.from, win.to)
  const { data: service, isLoading, isError } = usePosService(id, win)
  const navigate = useNavigate()

  const [added, setAdded] = useState(false)

  return (
    <Fade in timeout={400}>
      <Box sx={{ maxWidth: 720, mx: 'auto' }}>
      {/*   <Box
          sx={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            mb: 2,
          }}
        >
          <Button component={RouterLink} to={ROUTES.POS} startIcon={<ArrowBackRounded />}>
            Servicios
          </Button>
          <Badge badgeContent={count} color="secondary">
            <Button
              variant="outlined"
              startIcon={<ShoppingCartRounded />}
              component={RouterLink}
              to={ROUTES.POS_CHECKOUT}
              disabled={count === 0}
            >
              Cart
            </Button>
          </Badge>
        </Box>
 */}
        {isLoading && (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
            <CircularProgress />
          </Box>
        )}

        {isError && (
          <Alert severity="error">No se pudo cargar este servicio. Por favor, inténtalo de nuevo.</Alert>
        )}

        {service && (
          <Card>
            <CardContent>
              <ServiceSelectionPanel
                service={service}
                days={days}
                today={today}
                onAdded={() => setAdded(true)}
              />
            </CardContent>
          </Card>
        )}

        <Snackbar
          open={added}
          autoHideDuration={2500}
          onClose={() => setAdded(false)}
          anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
        >
          <Alert
            severity="success"
            variant="filled"
            onClose={() => setAdded(false)}
            action={
              <Button
                color="inherit"
                size="small"
                onClick={() => navigate(ROUTES.POS_CHECKOUT)}
              >
                Ver carrito
              </Button>
            }
          >
            Agregado al carrito
          </Alert>
        </Snackbar>
      </Box>
    </Fade>
  )
}
