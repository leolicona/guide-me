import { useState } from 'react'
import { Stack } from '@mui/material'
import type { Service } from '../types'
import { ServiceRow } from './ServiceRow'
import { ServiceFormSheet } from './ServiceFormSheet'
import { ConfirmServiceStatusSheet } from './ConfirmServiceStatusSheet'
import type { ServiceStatusAction } from './ConfirmServiceStatusSheet'
import { ConfirmDeleteServiceSheet } from './ConfirmDeleteServiceSheet'

interface ServiceListProps {
  services: Service[]
}

export function ServiceList({ services }: ServiceListProps) {
  const [editing, setEditing] = useState<Service | null>(null)
  const [confirm, setConfirm] = useState<{
    service: Service
    action: ServiceStatusAction
  } | null>(null)
  const [deleting, setDeleting] = useState<Service | null>(null)

  return (
    <>
      <Stack spacing={2}>
        {services.map((service) => (
          <ServiceRow
            key={service.id}
            service={service}
            onEdit={setEditing}
            onDeactivate={(s) => setConfirm({ service: s, action: 'deactivate' })}
            onReactivate={(s) => setConfirm({ service: s, action: 'reactivate' })}
            onDelete={setDeleting}
          />
        ))}
      </Stack>

      <ServiceFormSheet
        service={editing}
        open={!!editing}
        onClose={() => setEditing(null)}
      />

      <ConfirmServiceStatusSheet
        service={confirm?.service ?? null}
        action={confirm?.action ?? 'deactivate'}
        open={!!confirm}
        onClose={() => setConfirm(null)}
      />

      <ConfirmDeleteServiceSheet
        service={deleting}
        open={!!deleting}
        onClose={() => setDeleting(null)}
      />
    </>
  )
}
