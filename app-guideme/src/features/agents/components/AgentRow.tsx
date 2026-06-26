import { Card, CardContent, Box, Typography, Button } from '@mui/material'
import EditRounded from '@mui/icons-material/EditRounded'
import BlockRounded from '@mui/icons-material/BlockRounded'
import CheckCircleRounded from '@mui/icons-material/CheckCircleRounded'
import type { Agent } from '../types'
import { StatusChip } from '../../../components'

interface AgentRowProps {
  agent: Agent
  onEdit: (agent: Agent) => void
  onDeactivate: (agent: Agent) => void
  onReactivate: (agent: Agent) => void
}

export function AgentRow({
  agent,
  onEdit,
  onDeactivate,
  onReactivate,
}: AgentRowProps) {
  const suspended = agent.status === 'suspended'

  return (
    <Card sx={{ opacity: suspended ? 0.6 : 1, transition: 'opacity 160ms ease' }}>
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
            <Typography sx={{ fontWeight: 600 }} noWrap>
              {agent.name}
            </Typography>
            <Typography variant="body2" color="text.secondary" noWrap>
              {agent.email}
            </Typography>
            {agent.phone && (
              <Typography variant="body2" color="text.secondary" noWrap>
                {agent.phone}
              </Typography>
            )}
          </Box>

          <Box
            sx={{
              display: 'flex',
              gap: 1,
              alignItems: 'center',
              flexShrink: 0,
            }}
          >
            <StatusChip status={suspended ? 'suspended' : 'active'} />
            <Button
              size="small"
              startIcon={<EditRounded />}
              onClick={() => onEdit(agent)}
            >
              Editar
            </Button>
            {suspended ? (
              <Button
                size="small"
                color="primary"
                startIcon={<CheckCircleRounded />}
                onClick={() => onReactivate(agent)}
              >
                Reactivar
              </Button>
            ) : (
              <Button
                size="small"
                color="error"
                startIcon={<BlockRounded />}
                onClick={() => onDeactivate(agent)}
              >
                Desactivar
              </Button>
            )}
          </Box>
        </Box>
      </CardContent>
    </Card>
  )
}
