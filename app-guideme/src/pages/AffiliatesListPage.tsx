import { useState } from 'react'
import { Box, Typography, Button, CircularProgress, Alert, Fade, Stack } from '@mui/material'
import AddBusinessRounded from '@mui/icons-material/AddBusinessRounded'
import { useNavigate } from 'react-router-dom'
import { useAffiliates } from '../features/affiliates/hooks/useAffiliates'
import { AffiliateRow } from '../features/affiliates/components/AffiliateRow'
import { AffiliateWizard } from '../features/affiliates/components/AffiliateWizard'

export default function AffiliatesListPage() {
  const { data: affiliates, isLoading, isError } = useAffiliates()
  const [wizardOpen, setWizardOpen] = useState(false)
  const navigate = useNavigate()

  return (
    <Fade in timeout={400}>
      <Box sx={{ maxWidth: 720, mx: 'auto' }}>
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
            Afiliados
          </Typography>
          <Button
            variant="contained"
            disableElevation
            startIcon={<AddBusinessRounded />}
            onClick={() => setWizardOpen(true)}
          >
            Nuevo afiliado
          </Button>
        </Box>

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
                <AffiliateRow key={a.id} affiliate={a} />
              ))}
            </Stack>
          ))}

        <AffiliateWizard
          open={wizardOpen}
          onClose={() => setWizardOpen(false)}
          onCreated={(id) => {
            setWizardOpen(false)
            navigate(`/affiliates/${id}`)
          }}
        />
      </Box>
    </Fade>
  )
}
