import { useState } from 'react'
import { Typography, Stack } from '@mui/material'
import { FormSheet } from '../../../components'
import { CommissionCatalogEditor } from './CommissionCatalogEditor'
import { useSetCommissions } from '../hooks/useAffiliates'
import {
  draftFromCommissions,
  draftToEntries,
  draftsValid,
  type CommissionDraftMap,
} from '../commission'
import type { AffiliateDetail } from '../types'
import type { Service } from '../../catalog/types'

interface CommissionsSheetProps {
  affiliate: AffiliateDetail
  /** Active services — the rows the editor renders. */
  services: Service[]
  open: boolean
  onClose: () => void
  /** Fires the page toast after a successful save. */
  onSaved: () => void
}

// Edit the affiliate's service allow-list + rates in the canonical FormSheet. Seeding the FULL
// draft map (incl. commissions for now-inactive services) means a Save preserves them even
// though the editor only renders active services (D12 — deactivation preserves rows).
export function CommissionsSheet({
  affiliate,
  services,
  open,
  onClose,
  onSaved,
}: CommissionsSheetProps) {
  const commissionsMutation = useSetCommissions(affiliate.id)
  const [drafts, setDrafts] = useState<CommissionDraftMap>({})

  // Seed in render-phase on the open transition (the "store previous prop" pattern).
  const [wasOpen, setWasOpen] = useState(false)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) setDrafts(draftFromCommissions(affiliate.commissions))
  }

  const save = () =>
    commissionsMutation.mutate(draftToEntries(drafts), {
      onSuccess: () => {
        onSaved()
        onClose()
      },
    })

  return (
    <FormSheet
      open={open}
      onClose={onClose}
      title="Catálogo y comisiones"
      submitLabel="Guardar comisiones"
      busy={commissionsMutation.isPending}
      disabled={!draftsValid(drafts)}
      onSubmit={(e) => {
        e.preventDefault()
        save()
      }}
    >
      <Stack spacing={2}>
        <Typography variant="body2" color="text.secondary">
          Activa los servicios que este afiliado puede vender y define su comisión.
        </Typography>
        <CommissionCatalogEditor services={services} value={drafts} onChange={setDrafts} />
      </Stack>
    </FormSheet>
  )
}
