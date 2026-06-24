import { useState } from 'react'
import { Stack } from '@mui/material'
import type { Service } from '../types'
import { ServiceRow } from './ServiceRow'
import { ServiceFormDialog } from './ServiceFormDialog'
import { ExtrasManager } from './ExtrasManager'
import { ConfirmServiceStatusDialog } from './ConfirmServiceStatusDialog'
import type { ServiceStatusAction } from './ConfirmServiceStatusDialog'
import { ConfirmDeleteServiceDialog } from './ConfirmDeleteServiceDialog'

interface ServiceListProps {
  services: Service[]
}

export function ServiceList({ services }: ServiceListProps) {
  const [editing, setEditing] = useState<Service | null>(null)
  const [managing, setManaging] = useState<Service | null>(null)
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
            onManageExtras={setManaging}
            onDeactivate={(s) => setConfirm({ service: s, action: 'deactivate' })}
            onReactivate={(s) => setConfirm({ service: s, action: 'reactivate' })}
            onDelete={setDeleting}
          />
        ))}
      </Stack>

      <ServiceFormDialog
        service={editing}
        open={!!editing}
        onClose={() => setEditing(null)}
      />

      <ExtrasManager
        service={managing}
        open={!!managing}
        onClose={() => setManaging(null)}
      />

      <ConfirmServiceStatusDialog
        service={confirm?.service ?? null}
        action={confirm?.action ?? 'deactivate'}
        open={!!confirm}
        onClose={() => setConfirm(null)}
      />

      <ConfirmDeleteServiceDialog
        service={deleting}
        open={!!deleting}
        onClose={() => setDeleting(null)}
      />
    </>
  )
}
