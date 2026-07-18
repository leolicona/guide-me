import { useNavigate } from 'react-router-dom'
import { Box, Stack, Typography, IconButton, Divider } from '@mui/material'
import CloseRounded from '@mui/icons-material/CloseRounded'
import { InviteAgentForm } from '../features/agents/components/InviteAgentForm'
import { ROUTES } from '../config/routes'

// Focused single-form page (US — invite agent). Aligned to the creation-flow aesthetic: a
// wizard-style header (title + close X) over a centered, hairline-bordered card with no shadow —
// but no step chrome, since it's one field. Outside the nav shell, like /catalog/new.
export default function InviteAgentPage() {
  const navigate = useNavigate()
  const close = () => navigate(ROUTES.AGENTS, { replace: true })

  return (
    <Box
      sx={{
        minHeight: '100dvh',
        bgcolor: 'background.default',
        display: 'flex',
        justifyContent: 'center',
        alignItems: { xs: 'flex-start', sm: 'center' },
        p: { xs: 0, sm: 3 },
      }}
    >
      <Box
        sx={{
          width: '100%',
          maxWidth: { sm: 480 },
          bgcolor: 'background.paper',
          border: { xs: 'none', sm: '1px solid' },
          borderColor: { sm: 'divider' },
          borderRadius: { xs: 0, sm: 'var(--radius-lg, 16px)' },
          overflow: 'hidden',
        }}
      >
        {/* Header — title + close, mirroring the wizard chrome without the step indicator. */}
        <Box sx={{ px: 3, pt: 2.5, pb: 2 }}>
          <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between' }}>
            <Typography variant="h6">Invitar agente</Typography>
            <IconButton edge="end" onClick={close} aria-label="Cerrar">
              <CloseRounded />
            </IconButton>
          </Stack>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.25 }}>
            Envía una invitación por correo para que se una a tu equipo.
          </Typography>
        </Box>

        <Divider />

        <Box sx={{ px: 3, py: 3 }}>
          <InviteAgentForm />
        </Box>
      </Box>
    </Box>
  )
}
