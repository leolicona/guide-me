import { Typography, Chip, Button, IconButton, Switch, FormControlLabel, Skeleton } from '@mui/material'
import EditRounded from '@mui/icons-material/EditRounded'
import DeleteOutlineRounded from '@mui/icons-material/DeleteOutlineRounded'
import ScheduleRounded from '@mui/icons-material/ScheduleRounded'
import SellRounded from '@mui/icons-material/SellRounded'
import BedRounded from '@mui/icons-material/BedRounded'
import { Link as RouterLink } from 'react-router-dom'
import type { Service } from '../types'
import { formatMoney } from '../types'
import { categoryLabel, pricesAtServiceLevel } from '../categories'
import { fromNightlyRate } from '../lodging'
import { useUnits } from '../hooks/useUnits'
import { ListRow } from '../../../components'

interface ServiceRowProps {
  service: Service
  onEdit: (service: Service) => void
  onDeactivate: (service: Service) => void
  onReactivate: (service: Service) => void
  onDelete: (service: Service) => void
}

// The unit-based (lodging) meta line: the service record carries canonical zeros, so the
// row's useful numbers live on its unit types. This shares UnitsSection's query key, so the
// list fetch pre-warms the detail page's cache (and vice versa).
function LodgingSummary({ serviceId }: { serviceId: string }) {
  const { data: units, isLoading } = useUnits(serviceId)

  if (isLoading) {
    return <Skeleton width={200} sx={{ fontSize: '0.875rem' }} />
  }

  const active = (units ?? []).filter((u) => u.status === 'active')
  if (active.length === 0) {
    return (
      <Typography variant="body2" color="text.secondary">
        Sin tipos de unidad
      </Typography>
    )
  }

  const rooms = active.reduce((sum, u) => sum + u.inventory_count, 0)
  const fromRate = Math.min(...active.map((u) => fromNightlyRate(u.base_rate, u.weekend_rate)))

  return (
    <Typography variant="body2" color="text.secondary" className="numeric">
      {active.length} tipo{active.length === 1 ? '' : 's'} ·{' '}
      {rooms === 1 ? '1 habitación' : `${rooms} habitaciones`} · desde{' '}
      {formatMoney(fromRate)}/noche
    </Typography>
  )
}

// One service in the catalog list (unified ListRow v2 anatomy): title → detail page, corner
// ✎ opens the general-info edit sheet, meta + quick-edit shortcuts branch on the category's
// operational model (categories.ts) — slot services show price/capacity and jump to Horarios /
// Extras; unit services show their inventory summary and jump to Unidades. The estado switch
// reflects `service.status` and requests the change — the flip only lands after the confirm
// sheet (owned by ServiceList) resolves the mutation.
export function ServiceRow({
  service,
  onEdit,
  onDeactivate,
  onReactivate,
  onDelete,
}: ServiceRowProps) {
  const inactive = service.status === 'inactive'
  const extrasCount = service.extras?.length ?? 0
  const slotBased = pricesAtServiceLevel(service.category)
  const detailTo = `/catalog/${service.id}`

  return (
    <ListRow
      title={service.name}
      titleTo={detailTo}
      inactive={inactive}
      meta={
        slotBased ? (
          <>
            <Typography variant="body2" color="text.secondary" className="numeric">
              {formatMoney(service.base_price)} · mín {formatMoney(service.minimum_price)}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Cap. {service.default_capacity}
              {extrasCount > 0 ? ` · ${extrasCount} extra${extrasCount > 1 ? 's' : ''}` : ''}
            </Typography>
          </>
        ) : (
          <LodgingSummary serviceId={service.id} />
        )
      }
      cornerAction={
        <IconButton aria-label="Editar" onClick={() => onEdit(service)}>
          <EditRounded fontSize="small" />
        </IconButton>
      }
      tags={
        <>
          {service.category && (
            // US-A37 — primary category (none shown for a legacy null service).
            <Chip size="small" variant="outlined" label={categoryLabel(service.category)} />
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
        </>
      }
      footerActions={
        slotBased ? (
          <>
            <Button
              size="small"
              component={RouterLink}
              to={detailTo}
              state={{ scrollTo: 'schedules' }}
              startIcon={<ScheduleRounded />}
            >
              Horarios
            </Button>
            <Button
              size="small"
              component={RouterLink}
              to={detailTo}
              state={{ scrollTo: 'extras' }}
              startIcon={<SellRounded />}
            >
              Extras
            </Button>
          </>
        ) : (
          <Button
            size="small"
            component={RouterLink}
            to={detailTo}
            state={{ scrollTo: 'units' }}
            startIcon={<BedRounded />}
          >
            Unidades
          </Button>
        )
      }
      footerStatus={
        <>
          {inactive && (
            // US-A58 — permanent delete, offered for an already-deactivated (no-longer-offered)
            // service. Blocked server-side if it has sales history.
            <Button
              size="small"
              color="error"
              startIcon={<DeleteOutlineRounded />}
              onClick={() => onDelete(service)}
            >
              Eliminar
            </Button>
          )}
          <FormControlLabel
            control={
              <Switch
                color="secondary"
                checked={!inactive}
                onChange={() => (inactive ? onReactivate(service) : onDeactivate(service))}
              />
            }
            label={inactive ? 'Inactivo' : 'Activo'}
            slotProps={{ typography: { variant: 'body2' } }}
            sx={{ mr: 0 }}
          />
        </>
      }
    />
  )
}
