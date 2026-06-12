import { useState } from 'react'
import { useParams, useNavigate, Link as RouterLink } from 'react-router-dom'
import {
  Box,
  Button,
  Card,
  CardContent,
  CircularProgress,
  Alert,
  Fade,
  Badge,
  Snackbar,
} from '@mui/material'
import ArrowBackRounded from '@mui/icons-material/ArrowBackRounded'
import ShoppingCartRounded from '@mui/icons-material/ShoppingCartRounded'
import { usePosService } from '../features/pos/hooks'
import { ServiceSelectionPanel } from '../features/pos/components/ServiceSelectionPanel'
import { usePosCart, cartCount } from '../store/posCart'
import { usePosFilters } from '../store/posFilters'
import { ROUTES } from '../config/routes'

// US-AG31 — deep-link / fallback full-page view of a service. The primary path is the
// catalog Bottom Sheet (ServiceSheet); this page reuses the same ServiceSelectionPanel so
// the selection logic lives in exactly one place.
export default function PosServicePage() {
  const { id } = useParams<{ id: string }>()
  // US-AG30 — inherit the catalog's selected day: an explicit date scopes the slot list to
  // that day; the "Hoy" anchor (null) shows today onward (the default, unregressed).
  const selectedDate = usePosFilters((s) => s.selectedDate)
  const range = selectedDate
    ? { from: selectedDate, to: selectedDate }
    : undefined
  const { data: service, isLoading, isError } = usePosService(id, range)
  const navigate = useNavigate()

  const count = usePosCart((s) => cartCount(s.lines))
  const [added, setAdded] = useState(false)

  return (
    <Fade in timeout={400}>
      <Box>
        <Box
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
              <ServiceSelectionPanel service={service} onAdded={() => setAdded(true)} />
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
