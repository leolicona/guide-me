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
import { ListPageHeader } from '../components'
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
        <ListPageHeader
          title="Catálogo"
          action={
            <Button
              variant="contained"
              disableElevation
              startIcon={<AddRounded />}
              onClick={() => navigate(ROUTES.CATALOG_NEW)}
            >
              Nuevo servicio
            </Button>
          }
        />

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
