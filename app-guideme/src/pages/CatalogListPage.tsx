import { useState } from 'react'
import {
  Box,
  Typography,
  Button,
  CircularProgress,
  Alert,
  Fade,
} from '@mui/material'
import AddRounded from '@mui/icons-material/AddRounded'
import { useServices } from '../features/catalog/hooks/useServices'
import { ServiceList } from '../features/catalog/components/ServiceList'
import { ServiceFormDialog } from '../features/catalog/components/ServiceFormDialog'

export default function CatalogListPage() {
  const { data: services, isLoading, isError } = useServices()
  const [creating, setCreating] = useState(false)

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

        <ServiceFormDialog
          service={null}
          open={creating}
          onClose={() => setCreating(false)}
        />
      </Box>
    </Fade>
  )
}
