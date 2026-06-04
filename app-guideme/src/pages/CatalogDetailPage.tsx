import { useState } from 'react'
import { useParams, Link as RouterLink } from 'react-router-dom'
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

  return (
    <Fade in timeout={400}>
      <Box>
        <Button
          component={RouterLink}
          to={ROUTES.CATALOG}
          startIcon={<ArrowBackRounded />}
          sx={{ mb: 2 }}
        >
          Catalog
        </Button>

        {isLoading && (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
            <CircularProgress />
          </Box>
        )}

        {isError && (
          <Alert severity="error">Couldn't load this service. Please try again.</Alert>
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
                        label={service.status === 'inactive' ? 'Inactive' : 'Active'}
                      />
                    </Stack>
                    {service.description && (
                      <Typography color="text.secondary" sx={{ mt: 1 }}>
                        {service.description}
                      </Typography>
                    )}
                    <Typography variant="body2" color="text.secondary" sx={{ mt: 1.5 }}>
                      {formatMoney(service.base_price)} · min{' '}
                      {formatMoney(service.minimum_price)} · capacity{' '}
                      {service.default_capacity}
                    </Typography>
                  </Box>
                  <Button
                    startIcon={<EditRounded />}
                    onClick={() => setEditing(true)}
                    sx={{ flexShrink: 0 }}
                  >
                    Edit
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
