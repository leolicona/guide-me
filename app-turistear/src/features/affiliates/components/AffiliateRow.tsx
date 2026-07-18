import { Typography, Stack, IconButton, Switch, FormControlLabel } from '@mui/material'
import StorefrontRounded from '@mui/icons-material/StorefrontRounded'
import GroupsRounded from '@mui/icons-material/GroupsRounded'
import EditRounded from '@mui/icons-material/EditRounded'
import { Link as RouterLink } from 'react-router-dom'
import type { AffiliateListItem } from '../types'
import { ListRow } from '../../../components'

interface AffiliateRowProps {
  affiliate: AffiliateListItem
  onDeactivate: (affiliate: AffiliateListItem) => void
  onReactivate: (affiliate: AffiliateListItem) => void
}

// US-A48 — one affiliate company in the list (unified ListRow v2 anatomy): title and the
// corner ✎ both navigate to the detail/edit page; the estado switch requests suspend/
// reactivate through the list-level confirm sheet (parity with services/agents), flipping
// only after the mutation lands.
export function AffiliateRow({ affiliate, onDeactivate, onReactivate }: AffiliateRowProps) {
  const suspended = affiliate.status === 'suspended'
  const detailTo = `/affiliates/${affiliate.id}`

  return (
    <ListRow
      title={affiliate.name}
      titleTo={detailTo}
      inactive={suspended}
      meta={
        <Stack direction="row" spacing={2} sx={{ mt: 0.5, color: 'text.secondary' }}>
          <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center' }}>
            <StorefrontRounded fontSize="inherit" />
            <Typography variant="body2">
              {affiliate.service_count} servicio{affiliate.service_count === 1 ? '' : 's'}
            </Typography>
          </Stack>
          <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center' }}>
            <GroupsRounded fontSize="inherit" />
            <Typography variant="body2">
              {affiliate.user_count} usuario{affiliate.user_count === 1 ? '' : 's'}
            </Typography>
          </Stack>
        </Stack>
      }
      cornerAction={
        <IconButton aria-label="Editar" component={RouterLink} to={detailTo}>
          <EditRounded fontSize="small" />
        </IconButton>
      }
      footerStatus={
        <FormControlLabel
          control={
            <Switch
              color="secondary"
              checked={!suspended}
              onChange={() => (suspended ? onReactivate(affiliate) : onDeactivate(affiliate))}
            />
          }
          label={suspended ? 'Suspendido' : 'Activo'}
          slotProps={{ typography: { variant: 'body2' } }}
          sx={{ mr: 0 }}
        />
      }
    />
  )
}
