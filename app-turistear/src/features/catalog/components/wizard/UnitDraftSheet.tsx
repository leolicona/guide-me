import { useState } from 'react'
import { FormProvider, useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import {
  Alert,
  Box,
  Button,
  Collapse,
  Stack,
  Typography,
  Chip,
  ButtonBase,
} from '@mui/material'
import { ExpandMoreRounded } from '@mui/icons-material'
import { BottomSheet } from '../../../../components'
import { unitFormSchema, type UnitFormData } from '../../schemas'
import { UnitFields } from '../UnitFields'
import { SeasonsField, type SeasonRowValue } from '../SeasonsField'
import { BlockoutsField, type BlockoutRowValue } from '../BlockoutsField'
import type { UnitDraft } from '../../hooks/useCreateLodgingFull'

interface UnitDraftSheetProps {
  open: boolean
  onClose: () => void
  /** null → add; a draft → edit or duplicate (see `mode`). */
  initial: UnitDraft | null
  /** Which action opened the sheet. `duplicate` gets a prefilled draft that is NOT yet in the
   * parent list — it's only added on save, so the labels must read as "add", not "edit". */
  mode?: 'add' | 'edit' | 'duplicate'
  onSave: (draft: UnitDraft) => void
  /** Names already taken inside the target property — the other local drafts plus, in the
   * wizard's attach mode, the property's ACTIVE server-side units (US-A91 D11). Distinct names
   * are the only thing telling two POS cards apart, and the API enforces no uniqueness
   * (TECH_DEBT #28), so this is the gate. */
  existingNames?: string[]
  /** US-A91 D9 — seeds the name of a NEW draft (ignored when editing/duplicating): the property
   * name the user typed before realising the unit belonged to an existing property. */
  suggestedName?: string
}

const EMPTY: UnitFormData = {
  name: '',
  unit_type: '',
  inventory_count: 1,
  beds: 1,
  base_occupancy: 2,
  max_capacity: 4,
  base_rate: 0,
  weekend_rate: null,
  extra_person_fee: 0,
  min_nights: 1,
  checkin_time: '15:00',
  checkout_time: '11:00',
  amenities: [],
  commission_type: 'inherit', // default: inherit the service's base commission
  commission_value: null,
  max_discount_pct: 0, // US-A92 — no discount until the admin says otherwise
}

// A 48px tappable disclosure header (chevron + label + count badge when populated).
function DisclosureHeader({
  label,
  count,
  open,
  onToggle,
}: {
  label: string
  count: number
  open: boolean
  onToggle: () => void
}) {
  return (
    <ButtonBase
      onClick={onToggle}
      sx={{
        width: '100%',
        minHeight: 48,
        px: 1,
        justifyContent: 'space-between',
        borderRadius: 1,
      }}
      aria-expanded={open}
    >
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
        <Typography sx={{ fontWeight: 600 }}>{label}</Typography>
        {count > 0 && <Chip size="small" label={count} />}
      </Stack>
      <ExpandMoreRounded
        sx={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }}
      />
    </ButtonBase>
  )
}

// US-A59 — add/edit one unit inside the wizard. Own RHF form (unitFormSchema) wrapping the shared
// UnitFields, plus collapsed-by-default Temporadas/Bloqueos disclosures bound to the draft's local
// arrays (controlled, no network). Pushes/replaces the full draft in the parent `units` array.
export function UnitDraftSheet({
  open,
  onClose,
  initial,
  mode = initial ? 'edit' : 'add',
  onSave,
  existingNames = [],
  suggestedName,
}: UnitDraftSheetProps) {
  const methods = useForm<UnitFormData>({
    resolver: zodResolver(unitFormSchema),
    defaultValues: EMPTY,
  })

  // Duplicate-name gate (case-insensitive, trimmed). Blocking, not advisory: two units sharing
  // a name reach the POS as two visually identical cards with no way to tell which inventory
  // each draws from, and nothing downstream can recover the distinction (US-A91 D11).
  const draftName = methods.watch('name')
  const isDuplicateName =
    !!draftName?.trim() &&
    existingNames.some((n) => n.trim().toLowerCase() === draftName.trim().toLowerCase())

  const [seasons, setSeasons] = useState<SeasonRowValue[]>([])
  const [blockouts, setBlockouts] = useState<BlockoutRowValue[]>([])
  const [seasonsOpen, setSeasonsOpen] = useState(false)
  const [blockoutsOpen, setBlockoutsOpen] = useState(false)

  // Seed in render-phase on the open transition (the "store previous prop" pattern used across
  // the app — PosDatePickerSheet/SettingsPage — so the reset lands before paint with no
  // cascading-render effect).
  const [wasOpen, setWasOpen] = useState(false)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) {
      if (initial) {
        const { tempId: _t, seasons: s, blockouts: b, ...form } = initial
        void _t
        methods.reset(form)
        setSeasons(
          s.map((x) => ({
            id: x.tempId,
            name: x.name,
            start_date: x.start_date,
            end_date: x.end_date,
            nightly_rate: x.nightly_rate,
          })),
        )
        setBlockouts(
          b.map((x) => ({
            id: x.tempId,
            start_date: x.start_date,
            end_date: x.end_date,
            quantity: x.quantity,
            reason: x.reason,
          })),
        )
        setSeasonsOpen(s.length > 0) // a draft with seasons opens that section expanded
        setBlockoutsOpen(b.length > 0)
      } else {
        // D9 — a rescued property name seeds a NEW draft; everything else stays blank.
        methods.reset(suggestedName ? { ...EMPTY, name: suggestedName } : EMPTY)
        setSeasons([])
        setBlockouts([])
        setSeasonsOpen(false)
        setBlockoutsOpen(false)
      }
    }
  }

  const submit = methods.handleSubmit((form) => {
    if (isDuplicateName) return
    onSave({
      tempId: initial?.tempId ?? crypto.randomUUID(),
      ...form,
      seasons: seasons.map((s) => ({
        tempId: s.id,
        name: s.name,
        start_date: s.start_date,
        end_date: s.end_date,
        nightly_rate: s.nightly_rate,
      })),
      blockouts: blockouts.map((b) => ({
        tempId: b.id,
        start_date: b.start_date,
        end_date: b.end_date,
        quantity: b.quantity,
        reason: b.reason,
      })),
    })
    onClose()
  })

  return (
    <BottomSheet
      open={open}
      onClose={onClose}
      title={mode === 'edit' ? 'Editar unidad' : mode === 'duplicate' ? 'Duplicar unidad' : 'Nueva unidad'}
      header={
        <Typography variant="h6" sx={{ px: 2, pb: 1 }}>
          {mode === 'edit' ? 'Editar unidad' : mode === 'duplicate' ? 'Duplicar unidad' : 'Nueva unidad'}
        </Typography>
      }
      footer={
        <Box sx={{ p: 2 }}>
          <Button
            fullWidth
            variant="contained"
            disableElevation
            disabled={isDuplicateName}
            onClick={submit}
          >
            {mode === 'edit' ? 'Guardar' : 'Agregar'}
          </Button>
        </Box>
      }
    >
      <Box sx={{ px: 2, pb: 2 }}>
        {isDuplicateName && (
          <Alert severity="error" sx={{ mb: 2 }}>
            Ya existe una unidad con este nombre en esta propiedad — usa nombres distintos para
            diferenciarlas en el punto de venta.
          </Alert>
        )}
        <FormProvider {...methods}>
          <UnitFields />
        </FormProvider>

        <Box sx={{ mt: 2, borderTop: '1px solid var(--slate-200, #E2E8F0)', pt: 1 }}>
          <DisclosureHeader
            label="Temporadas (opcional)"
            count={seasons.length}
            open={seasonsOpen}
            onToggle={() => setSeasonsOpen((o) => !o)}
          />
          <Collapse in={seasonsOpen} unmountOnExit>
            <Box sx={{ pt: 1 }}>
              <SeasonsField value={seasons} onChange={setSeasons} />
            </Box>
          </Collapse>
        </Box>

        <Box sx={{ mt: 1, borderTop: '1px solid var(--slate-200, #E2E8F0)', pt: 1 }}>
          <DisclosureHeader
            label="Bloqueos (opcional)"
            count={blockouts.length}
            open={blockoutsOpen}
            onToggle={() => setBlockoutsOpen((o) => !o)}
          />
          <Collapse in={blockoutsOpen} unmountOnExit>
            <Box sx={{ pt: 1 }}>
              <BlockoutsField value={blockouts} onChange={setBlockouts} />
            </Box>
          </Collapse>
        </Box>
      </Box>
    </BottomSheet>
  )
}
