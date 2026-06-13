import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
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
import { ServiceWizard } from '../features/catalog/components/wizard/ServiceWizard'
import { ROUTES } from '../config/routes'

export default function CatalogListPage() {
  const { data: services, isLoading, isError } = useServices()
  const navigate = useNavigate()
  const [creating, setCreating] = useState(false)
  const [created, setCreated] = useState(false)

  // US-A44 — on a fully-successful create show a success toast; on a partial create (service
  // saved but a schedule/extra failed) route to the detail page so the operator finishes the
  // few that didn't land, flagged by router state the detail page reads.
  const handleCreated = (serviceId: string, failures: number) => {
    setCreating(false)
    if (failures === 0) {
      setCreated(true)
    } else {
      navigate(ROUTES.CATALOG_DETAIL.replace(':id', serviceId), {
        state: { wizardPartial: true },
      })
    }
  }

  return (
    <Fade in timeout={400}>
      <Box>
        <Box
          sx={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
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
            onClick={() => setCreating(true)}
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

        <ServiceWizard
          open={creating}
          onClose={() => setCreating(false)}
          onCreated={handleCreated}
        />

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
