import { Card, CardActionArea, CardContent, Box, Typography, Chip, Stack } from '@mui/material'
import StorefrontRounded from '@mui/icons-material/StorefrontRounded'
import GroupsRounded from '@mui/icons-material/GroupsRounded'
import { useNavigate } from 'react-router-dom'
import type { AffiliateListItem } from '../types'

// US-A48 — one affiliate company in the list. The whole card navigates to the detail/edit page.
export function AffiliateRow({ affiliate }: { affiliate: AffiliateListItem }) {
  const navigate = useNavigate()
  const suspended = affiliate.status === 'suspended'

  return (
    <Card sx={{ opacity: suspended ? 0.6 : 1, transition: 'opacity 160ms ease' }}>
      <CardActionArea onClick={() => navigate(`/affiliates/${affiliate.id}`)}>
        <CardContent>
          <Box
            sx={{
              display: 'flex',
              gap: 2,
              justifyContent: 'space-between',
              alignItems: 'center',
            }}
          >
            <Box sx={{ minWidth: 0 }}>
              <Typography sx={{ fontWeight: 600 }} noWrap>
                {affiliate.name}
              </Typography>
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
            </Box>
            <Chip
              size="small"
              variant="outlined"
              color={suspended ? 'default' : 'success'}
              label={suspended ? 'Suspendido' : 'Activo'}
              sx={{ flexShrink: 0 }}
            />
          </Box>
        </CardContent>
      </CardActionArea>
    </Card>
  )
}
