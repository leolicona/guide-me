import { Typography, IconButton, Switch, FormControlLabel } from '@mui/material'
import EditRounded from '@mui/icons-material/EditRounded'
import type { Agent } from '../types'
import { ListRow } from '../../../components'

interface AgentRowProps {
  agent: Agent
  onEdit: (agent: Agent) => void
  onDeactivate: (agent: Agent) => void
  onReactivate: (agent: Agent) => void
}

// One agent in the list (unified ListRow v2 anatomy): agents have no detail page, so the title
// AND the corner ✎ both open the edit sheet (same tap-the-name gesture as the other lists).
// The estado switch sits in the footer; the flip only lands after the confirm sheet (owned by
// AgentList) resolves the mutation.
export function AgentRow({ agent, onEdit, onDeactivate, onReactivate }: AgentRowProps) {
  const suspended = agent.status === 'suspended'

  return (
    <ListRow
      title={agent.name}
      onTitleClick={() => onEdit(agent)}
      inactive={suspended}
      meta={
        <>
          <Typography variant="body2" color="text.secondary" noWrap>
            {agent.email}
          </Typography>
          {agent.phone && (
            <Typography variant="body2" color="text.secondary" noWrap>
              {agent.phone}
            </Typography>
          )}
        </>
      }
      cornerAction={
        <IconButton aria-label="Editar" onClick={() => onEdit(agent)}>
          <EditRounded fontSize="small" />
        </IconButton>
      }
      footerStatus={
        <FormControlLabel
          control={
            <Switch
              color="secondary"
              checked={!suspended}
              onChange={() => (suspended ? onReactivate(agent) : onDeactivate(agent))}
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
