import {
  Box,
  Typography,
  Button,
  CircularProgress,
  Alert,
  Fade,
} from '@mui/material'
import PersonAddRounded from '@mui/icons-material/PersonAddRounded'
import { Link as RouterLink } from 'react-router-dom'
import { useAgents } from '../features/agents/hooks/useAgents'
import { AgentList } from '../features/agents/components/AgentList'
import { ROUTES } from '../config/routes'

export default function AgentsListPage() {
  const { data: agents, isLoading, isError } = useAgents()

  return (
    <Fade in timeout={400}>
      <Box>
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
            Agentes
          </Typography>
          <Button
            component={RouterLink}
            to={ROUTES.INVITE_AGENT}
            variant="contained"
            disableElevation
            startIcon={<PersonAddRounded />}
          >
            Invitar agente
          </Button>
        </Box>

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
      </Box>
    </Fade>
  )
}
