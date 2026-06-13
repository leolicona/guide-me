import { useState } from 'react'
import { useParams, useLocation, Link as RouterLink } from 'react-router-dom'
import {
  Box,
  Typography,
  Button,
  Chip,
  Card,
  CardContent,
  CircularProgress,
  Alert,
  Fade,
  Stack,
} from '@mui/material'
import ArrowBackRounded from '@mui/icons-material/ArrowBackRounded'
import EditRounded from '@mui/icons-material/EditRounded'
import { useService } from '../features/catalog/hooks/useService'
import { ExtrasPanel } from '../features/catalog/components/ExtrasPanel'
import { ServiceFormDialog } from '../features/catalog/components/ServiceFormDialog'
import { SchedulesSection } from '../features/schedules/components/SchedulesSection'
import { formatMoney } from '../features/catalog/types'
import { ROUTES } from '../config/routes'

export default function CatalogDetailPage() {
  const { id } = useParams<{ id: string }>()
  const { data: service, isLoading, isError } = useService(id)
  const [editing, setEditing] = useState(false)
  // US-A44 — the Wizard routes here when the service saved but some schedules/extras failed.
  const location = useLocation()
  const partial = (location.state as { wizardPartial?: boolean } | null)?.wizardPartial
  const [showPartial, setShowPartial] = useState(!!partial)

  return (
    <Fade in timeout={400}>
      <Box>
        <Button
          component={RouterLink}
          to={ROUTES.CATALOG}
          startIcon={<ArrowBackRounded />}
          sx={{ mb: 2 }}
        >
          Catálogo
        </Button>

        {showPartial && (
          <Alert
            severity="warning"
            onClose={() => setShowPartial(false)}
            sx={{ mb: 2 }}
          >
            Servicio creado, pero algunos horarios o extras no se guardaron. Revísalos y agrégalos
            aquí abajo.
          </Alert>
        )}

        {isLoading && (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
            <CircularProgress />
          </Box>
        )}

        {isError && (
          <Alert severity="error">No se pudo cargar este servicio. Inténtalo de nuevo.</Alert>
        )}

        {service && (
          <Stack spacing={3}>
            <Card>
              <CardContent>
                <Box
                  sx={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'flex-start',
                    gap: 2,
                  }}
                >
                  <Box sx={{ minWidth: 0 }}>
                    <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center' }}>
                      <Typography variant="h5" component="h1">
                        {service.name}
                      </Typography>
                      <Chip
                        size="small"
                        variant="outlined"
                        color={service.status === 'inactive' ? 'default' : 'success'}
                        label={service.status === 'inactive' ? 'Inactivo' : 'Activo'}
                      />
                    </Stack>
                    {service.description && (
                      <Typography color="text.secondary" sx={{ mt: 1 }}>
                        {service.description}
                      </Typography>
                    )}
                    <Typography variant="body2" color="text.secondary" sx={{ mt: 1.5 }}>
                      {formatMoney(service.base_price)} · mín{' '}
                      {formatMoney(service.minimum_price)} · cap.{' '}
                      {service.default_capacity}
                      {service.commission_value > 0 && (
                        <>
                          {' · comisión '}
                          {service.commission_type === 'fixed'
                            ? `${formatMoney(service.commission_value)} por lugar`
                            : `${service.commission_value / 100}%`}
                        </>
                      )}
                    </Typography>
                  </Box>
                  <Button
                    startIcon={<EditRounded />}
                    onClick={() => setEditing(true)}
                    sx={{ flexShrink: 0 }}
                  >
                    Editar
                  </Button>
                </Box>
              </CardContent>
            </Card>

            <Card>
              <CardContent>
                <Typography variant="h6" sx={{ mb: 2 }}>
                  Extras
                </Typography>
                <ExtrasPanel serviceId={service.id} />
              </CardContent>
            </Card>

            <Card>
              <CardContent>
                <SchedulesSection
                  serviceId={service.id}
                  defaultCapacity={service.default_capacity}
                />
              </CardContent>
            </Card>

            <ServiceFormDialog
              service={editing ? service : null}
              open={editing}
              onClose={() => setEditing(false)}
            />
          </Stack>
        )}
      </Box>
    </Fade>
  )
}
