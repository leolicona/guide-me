import { Card, CardContent, Box, Typography, Chip, Button, Stack } from '@mui/material'
import { Link as RouterLink } from 'react-router-dom'
import EditRounded from '@mui/icons-material/EditRounded'
import TuneRounded from '@mui/icons-material/TuneRounded'
import BlockRounded from '@mui/icons-material/BlockRounded'
import CheckCircleRounded from '@mui/icons-material/CheckCircleRounded'
import type { Service } from '../types'
import { formatMoney } from '../types'

interface ServiceRowProps {
  service: Service
  onEdit: (service: Service) => void
  onManageExtras: (service: Service) => void
  onDeactivate: (service: Service) => void
  onReactivate: (service: Service) => void
}

export function ServiceRow({
  service,
  onEdit,
  onManageExtras,
  onDeactivate,
  onReactivate,
}: ServiceRowProps) {
  const inactive = service.status === 'inactive'
  const extrasCount = service.extras?.length ?? 0

  return (
    <Card sx={{ opacity: inactive ? 0.6 : 1, transition: 'opacity 160ms ease' }}>
      <CardContent>
        <Box
          sx={{
            display: 'flex',
            flexDirection: { xs: 'column', sm: 'row' },
            gap: 2,
            justifyContent: 'space-between',
            alignItems: { xs: 'flex-start', sm: 'center' },
          }}
        >
          <Box sx={{ minWidth: 0 }}>
            <Typography
              component={RouterLink}
              to={`/catalog/${service.id}`}
              sx={{
                fontWeight: 600,
                color: 'text.primary',
                textDecoration: 'none',
                '&:hover': { textDecoration: 'underline' },
              }}
              noWrap
            >
              {service.name}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              {formatMoney(service.base_price)} · min {formatMoney(service.minimum_price)}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Capacity {service.default_capacity}
              {extrasCount > 0 ? ` · ${extrasCount} extra${extrasCount > 1 ? 's' : ''}` : ''}
            </Typography>
          </Box>

          <Stack
            direction="row"
            spacing={1}
            sx={{ alignItems: 'center', flexShrink: 0, flexWrap: 'wrap' }}
          >
            <Chip
              size="small"
              variant="outlined"
              color={inactive ? 'default' : 'success'}
              label={inactive ? 'Inactive' : 'Active'}
            />
            <Button size="small" startIcon={<EditRounded />} onClick={() => onEdit(service)}>
              Edit
            </Button>
            <Button
              size="small"
              startIcon={<TuneRounded />}
              onClick={() => onManageExtras(service)}
            >
              Manage extras
            </Button>
            {inactive ? (
              <Button
                size="small"
                color="primary"
                startIcon={<CheckCircleRounded />}
                onClick={() => onReactivate(service)}
              >
                Reactivate
              </Button>
            ) : (
              <Button
                size="small"
                color="error"
                startIcon={<BlockRounded />}
                onClick={() => onDeactivate(service)}
              >
                Deactivate
              </Button>
            )}
          </Stack>
        </Box>
      </CardContent>
    </Card>
  )
}
