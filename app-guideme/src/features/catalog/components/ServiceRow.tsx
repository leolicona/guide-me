import { Card, CardContent, Box, Typography, Chip, Button, Stack } from '@mui/material'
import { Link as RouterLink } from 'react-router-dom'
import EditRounded from '@mui/icons-material/EditRounded'
import TuneRounded from '@mui/icons-material/TuneRounded'
import EventRepeatRounded from '@mui/icons-material/EventRepeatRounded'
import BlockRounded from '@mui/icons-material/BlockRounded'
import CheckCircleRounded from '@mui/icons-material/CheckCircleRounded'
import DeleteOutlineRounded from '@mui/icons-material/DeleteOutlineRounded'
import type { Service } from '../types'
import { formatMoney } from '../types'
import { categoryLabel } from '../categories'
import { StatusChip } from '../../../components'

interface ServiceRowProps {
  service: Service
  onEdit: (service: Service) => void
  onManageExtras: (service: Service) => void
  onDeactivate: (service: Service) => void
  onReactivate: (service: Service) => void
  onDelete: (service: Service) => void
}

export function ServiceRow({
  service,
  onEdit,
  onManageExtras,
  onDeactivate,
  onReactivate,
  onDelete,
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
                // RouterLink renders an inline <a>; noWrap's ellipsis only works on a block,
                // so without this a long title overflows the card instead of truncating (375px).
                display: 'block',
                fontWeight: 600,
                color: 'text.primary',
                textDecoration: 'none',
                '&:hover': { textDecoration: 'underline' },
              }}
              noWrap
            >
              {service.name}
            </Typography>
            <Typography variant="body2" color="text.secondary" className="numeric">
              {formatMoney(service.base_price)} · mín {formatMoney(service.minimum_price)}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Cap. {service.default_capacity}
              {extrasCount > 0 ? ` · ${extrasCount} extra${extrasCount > 1 ? 's' : ''}` : ''}
            </Typography>
          </Box>

          <Stack
            direction="row"
            spacing={1}
            sx={{ alignItems: 'center', flexShrink: 0, flexWrap: 'wrap' }}
          >
            <StatusChip
              status={inactive ? 'suspended' : 'active'}
              label={inactive ? 'Inactivo' : 'Activo'}
            />
            {service.category && (
              // US-A37 — primary category (none shown for a legacy null service).
              <Chip
                size="small"
                variant="outlined"
                label={categoryLabel(service.category)}
              />
            )}
            {service.is_flexible && (
              // US-A36 — Soft Cap services allow a small overbooking margin.
              <Chip
                size="small"
                variant="outlined"
                color="warning"
                label={`Flexible +${service.flex_capacity_pct}%`}
              />
            )}
            <Button size="small" startIcon={<EditRounded />} onClick={() => onEdit(service)}>
              Editar
            </Button>
            <Button
              size="small"
              startIcon={<TuneRounded />}
              onClick={() => onManageExtras(service)}
            >
              Gestionar extras
            </Button>
            <Button
              size="small"
              component={RouterLink}
              to={`/catalog/${service.id}`}
              startIcon={<EventRepeatRounded />}
            >
              Horarios
            </Button>
            {inactive ? (
              <>
                <Button
                  size="small"
                  color="primary"
                  startIcon={<CheckCircleRounded />}
                  onClick={() => onReactivate(service)}
                >
                  Reactivar
                </Button>
                {/* US-A58 — permanent delete, offered for an already-deactivated (no-longer-offered)
                    service. Blocked server-side if it has sales history. */}
                <Button
                  size="small"
                  color="error"
                  startIcon={<DeleteOutlineRounded />}
                  onClick={() => onDelete(service)}
                >
                  Eliminar
                </Button>
              </>
            ) : (
              <Button
                size="small"
                color="error"
                startIcon={<BlockRounded />}
                onClick={() => onDeactivate(service)}
              >
                Desactivar
              </Button>
            )}
          </Stack>
        </Box>
      </CardContent>
    </Card>
  )
}
