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
import { todayStr, addDays } from '../features/pos/dates'
import { usePosFilters } from '../store/posFilters'
import { ROUTES } from '../config/routes'

// US-AG31 — deep-link / fallback full-page view of a service. The primary path is the
// catalog Bottom Sheet (ServiceSheet); this page reuses the same ServiceSelectionPanel so
// the selection logic lives in exactly one place.
export default function PosServicePage() {
  const { id } = useParams<{ id: string }>()
  // US-AG30/AG33 — inherit the catalog's selected day. An explicit date stays a single day;
  // the "Hoy" anchor (null) expands to the 3-day window [today, today+2].
  const selectedDate = usePosFilters((s) => s.selectedDate)
  const today = todayStr()
  const days = selectedDate
    ? [selectedDate]
    : [today, addDays(today, 1), addDays(today, 2)]
  const range = { from: days[0], to: days[days.length - 1] }
  const { data: service, isLoading, isError } = usePosService(id, range)
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
