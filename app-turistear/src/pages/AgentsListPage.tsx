import { useEffect, useState } from 'react'
import {
  Box,
  Typography,
  Button,
  CircularProgress,
  Alert,
  Fade,
  Snackbar,
} from '@mui/material'
import PersonAddRounded from '@mui/icons-material/PersonAddRounded'
import { Link as RouterLink, useLocation } from 'react-router-dom'
import { useAgents } from '../features/agents/hooks/useAgents'
import { AgentList } from '../features/agents/components/AgentList'
import { ListPageHeader } from '../components'
import { ROUTES } from '../config/routes'

export default function AgentsListPage() {
  const { data: agents, isLoading, isError } = useAgents()

  // The invite page (/agents/invite) returns here with `agentInvited` router state on success;
  // toast once, then clear the state so a refresh or Back doesn't re-toast.
  const location = useLocation()
  const [invited, setInvited] = useState(
    () => Boolean((location.state as { agentInvited?: boolean } | null)?.agentInvited),
  )
  useEffect(() => {
    if ((location.state as { agentInvited?: boolean } | null)?.agentInvited) {
      window.history.replaceState({}, '')
    }
  }, [location.state])

  return (
    <Fade in timeout={400}>
      <Box sx={{ maxWidth: 720, mx: 'auto' }}>
        <ListPageHeader
          title="Agentes"
          action={
            <Button
              component={RouterLink}
              to={ROUTES.INVITE_AGENT}
              variant="contained"
              disableElevation
              startIcon={<PersonAddRounded />}
            >
              Invitar agente
            </Button>
          }
        />

        {isLoading && (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
            <CircularProgress />
          </Box>
        )}

        {isError && (
          <Alert severity="error">
            No se pudieron cargar los agentes. Inténtalo de nuevo.
          </Alert>
        )}

        {agents &&
          (agents.length === 0 ? (
            <Typography color="text.secondary">
              Aún no hay agentes — invita a tu primer agente.
            </Typography>
          ) : (
            <AgentList agents={agents} />
          ))}

        <Snackbar
          open={invited}
          autoHideDuration={3000}
          onClose={() => setInvited(false)}
          anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
        >
          <Alert severity="success" variant="filled" onClose={() => setInvited(false)}>
            Invitación enviada
          </Alert>
        </Snackbar>
      </Box>
    </Fade>
  )
}
