import { useState } from 'react'
import { Stack } from '@mui/material'
import type { Agent } from '../types'
import { AgentRow } from './AgentRow'
import { EditAgentSheet } from './EditAgentSheet'
import { ConfirmStatusSheet } from './ConfirmStatusSheet'
import type { StatusAction } from './ConfirmStatusSheet'

interface AgentListProps {
  agents: Agent[]
}

export function AgentList({ agents }: AgentListProps) {
  const [editing, setEditing] = useState<Agent | null>(null)
  const [confirm, setConfirm] = useState<{
    agent: Agent
    action: StatusAction
  } | null>(null)

  return (
    <>
      <Stack spacing={2}>
        {agents.map((agent) => (
          <AgentRow
            key={agent.id}
            agent={agent}
            onEdit={setEditing}
            onDeactivate={(a) => setConfirm({ agent: a, action: 'deactivate' })}
            onReactivate={(a) => setConfirm({ agent: a, action: 'reactivate' })}
          />
        ))}
      </Stack>

      <EditAgentSheet
        agent={editing}
        open={!!editing}
        onClose={() => setEditing(null)}
      />

      <ConfirmStatusSheet
        agent={confirm?.agent ?? null}
        action={confirm?.action ?? 'deactivate'}
        open={!!confirm}
        onClose={() => setConfirm(null)}
      />
    </>
  )
}
