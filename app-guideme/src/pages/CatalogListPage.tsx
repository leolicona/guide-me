import { useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import {
  Box,
  Typography,
  Button,
  CircularProgress,
  Alert,
  Fade,
  Snackbar,
} from '@mui/material'
import AddRounded from '@mui/icons-material/AddRounded'
import { useServices } from '../features/catalog/hooks/useServices'
import { ServiceList } from '../features/catalog/components/ServiceList'
import { ROUTES } from '../config/routes'

export default function CatalogListPage() {
  const { data: services, isLoading, isError } = useServices()
  const navigate = useNavigate()

  // US-A44 — the full-page wizard (/catalog/new) returns here with `serviceCreated` router
  // state on a fully-successful create; show the success toast once and clear the state so a
  // refresh or Back doesn't re-toast. (The partial-create path routes to the detail page
  // flagged `wizardPartial` instead — no list-page involvement.)
  const location = useLocation()
  const [created, setCreated] = useState(
    () => Boolean((location.state as { serviceCreated?: boolean } | null)?.serviceCreated),
  )
  useEffect(() => {
    if ((location.state as { serviceCreated?: boolean } | null)?.serviceCreated) {
      window.history.replaceState({}, '')
    }
  }, [location.state])

  return (
    <Fade in timeout={400}>
      <Box sx={{ maxWidth: 760, mx: 'auto' }}>
        {/* On mobile the shell's account avatar floats fixed at the top-right, so the header
            action can't sit beside the title there (US-UX03). Stack on xs (title, then a
            full-width action below the avatar zone); keep the side-by-side row from md up,
            where the avatar lives in the rail. */}
        <Box
          sx={{
            display: 'flex',
            flexDirection: { xs: 'column', md: 'row' },
            justifyContent: 'space-between',
            alignItems: { xs: 'stretch', md: 'center' },
            gap: 2,
            mb: 3,
          }}
        >
          <Typography variant="h4" component="h1">
            Catálogo
          </Typography>
          <Button
            variant="contained"
            disableElevation
            startIcon={<AddRounded />}
            onClick={() => navigate(ROUTES.CATALOG_NEW)}
            sx={{ flexShrink: 0, alignSelf: { xs: 'stretch', md: 'auto' } }}
          >
            Nuevo servicio
          </Button>
        </Box>

        {isLoading && (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
            <CircularProgress />
          </Box>
        )}

        {isError && (
          <Alert severity="error">No se pudieron cargar los servicios. Inténtalo de nuevo.</Alert>
        )}

        {services &&
          (services.length === 0 ? (
            <Typography color="text.secondary">
              Aún no hay servicios — crea tu primer tour.
            </Typography>
          ) : (
            <ServiceList services={services} />
          ))}

        <Snackbar
          open={created}
          autoHideDuration={3000}
          onClose={() => setCreated(false)}
          anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
        >
          <Alert severity="success" variant="filled" onClose={() => setCreated(false)}>
            Servicio creado
          </Alert>
        </Snackbar>
      </Box>
    </Fade>
  )
}
