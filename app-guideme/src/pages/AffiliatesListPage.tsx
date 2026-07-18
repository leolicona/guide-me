import { useEffect, useState } from 'react'
import {
  Box,
  Typography,
  Button,
  CircularProgress,
  Alert,
  Fade,
  Stack,
  Snackbar,
} from '@mui/material'
import AddBusinessRounded from '@mui/icons-material/AddBusinessRounded'
import { useLocation, useNavigate } from 'react-router-dom'
import { useAffiliates } from '../features/affiliates/hooks/useAffiliates'
import { AffiliateRow } from '../features/affiliates/components/AffiliateRow'
import {
  ConfirmAffiliateStatusSheet,
  type AffiliateStatusAction,
} from '../features/affiliates/components/ConfirmAffiliateStatusSheet'
import type { AffiliateListItem } from '../features/affiliates/types'
import { ListPageHeader } from '../components'
import { ROUTES } from '../config/routes'

export default function AffiliatesListPage() {
  const { data: affiliates, isLoading, isError } = useAffiliates()
  const navigate = useNavigate()
  const [confirm, setConfirm] = useState<{
    affiliate: AffiliateListItem
    action: AffiliateStatusAction
  } | null>(null)

  // The full-page wizard (/affiliates/new) returns here with `affiliateCreated` router state on a
  // successful create; toast once, then clear the state so a refresh or Back doesn't re-toast.
  const location = useLocation()
  const [created, setCreated] = useState(
    () => Boolean((location.state as { affiliateCreated?: boolean } | null)?.affiliateCreated),
  )
  useEffect(() => {
    if ((location.state as { affiliateCreated?: boolean } | null)?.affiliateCreated) {
      window.history.replaceState({}, '')
    }
  }, [location.state])

  return (
    <Fade in timeout={400}>
      <Box sx={{ maxWidth: 720, mx: 'auto' }}>
        <ListPageHeader
          title="Afiliados"
          action={
            <Button
              variant="contained"
              disableElevation
              startIcon={<AddBusinessRounded />}
              onClick={() => navigate(ROUTES.AFFILIATE_NEW)}
            >
              Nuevo afiliado
            </Button>
          }
        />

        {isLoading && (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
            <CircularProgress />
          </Box>
        )}

        {isError && (
          <Alert severity="error">No se pudieron cargar los afiliados. Inténtalo de nuevo.</Alert>
        )}

        {affiliates &&
          (affiliates.length === 0 ? (
            <Typography color="text.secondary">
              Aún no hay afiliados — crea tu primer socio revendedor.
            </Typography>
          ) : (
            <Stack spacing={1.5}>
              {affiliates.map((a) => (
                <AffiliateRow
                  key={a.id}
                  affiliate={a}
                  onDeactivate={(af) => setConfirm({ affiliate: af, action: 'deactivate' })}
                  onReactivate={(af) => setConfirm({ affiliate: af, action: 'reactivate' })}
                />
              ))}
            </Stack>
          ))}

        {/* Conditional render keyed by target so the status hook always receives a real id. */}
        {confirm && (
          <ConfirmAffiliateStatusSheet
            key={confirm.affiliate.id}
            affiliateId={confirm.affiliate.id}
            affiliateName={confirm.affiliate.name}
            action={confirm.action}
            open
            onClose={() => setConfirm(null)}
          />
        )}

        <Snackbar
          open={created}
          autoHideDuration={3000}
          onClose={() => setCreated(false)}
          anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
        >
          <Alert severity="success" variant="filled" onClose={() => setCreated(false)}>
            Afiliado creado
          </Alert>
        </Snackbar>
      </Box>
    </Fade>
  )
}
