import { useState } from 'react'
import { Stack, Button, Box, Typography, Alert } from '@mui/material'
import AddRounded from '@mui/icons-material/AddRounded'
import { StepIntro } from './StepIntro'
import { UnitRow } from '../UnitRow'
import { fromNightlyRate } from '../../lodging'
import { UnitDraftSheet } from './UnitDraftSheet'
import { amountToCents } from '../../types'
import type { UnitDraft } from '../../hooks/useCreateLodgingFull'

interface StepUnitsProps {
  units: UnitDraft[]
  onChange: (units: UnitDraft[]) => void
  /** True when the user tried to finish with zero units (the ≥1 gate). */
  showUnitsError: boolean
  /** US-A91 — the existing property these units are being added to (attach mode). Undefined
   * when the wizard is creating the property. Naming it on every screen is what teaches the
   * hierarchy the feature exists to teach. */
  propertyName?: string
  /** US-A91 D11 — names of the target property's ACTIVE units, from the server. The local
   * drafts alone cannot see them, which is how attach mode would otherwise ship a duplicate. */
  serverUnitNames?: string[]
  /** US-A91 D9 — a property name the user typed before switching to an existing property. They
   * named the thing they wanted; it was only at the wrong level, so it prefills the first unit. */
  suggestedName?: string
}

// Lodging Step 2 (v2) — the units repeater (mirrors the times/extras local-array pattern).
// ≥1 unit is required to advance. Each unit captures its full field set (incl. how many
// identical ones exist) + (optional) seasons/blockouts in the UnitDraftSheet. "Duplicar" clones
// a draft for the common near-identical case ("Sencilla" → "Sencilla vista mar").
export function StepUnits({
  units,
  onChange,
  showUnitsError,
  propertyName,
  serverUnitNames,
  suggestedName,
}: StepUnitsProps) {
  const [editing, setEditing] = useState<UnitDraft | null>(null)
  const [mode, setMode] = useState<'add' | 'edit' | 'duplicate'>('add')
  const [open, setOpen] = useState(false)

  const openAdd = () => {
    setEditing(null)
    setMode('add')
    setOpen(true)
  }
  const openEdit = (draft: UnitDraft) => {
    setEditing(draft)
    setMode('edit')
    setOpen(true)
  }

  const save = (draft: UnitDraft) => {
    const exists = units.some((u) => u.tempId === draft.tempId)
    onChange(exists ? units.map((u) => (u.tempId === draft.tempId ? draft : u)) : [...units, draft])
  }

  // Deep-copy a draft (fresh tempIds throughout) and open it in the sheet WITHOUT appending —
  // save() adds unknown tempIds, so the copy only joins the list when the user confirms, and
  // closing the sheet discards it (no stray "(copia)" rows).
  const duplicate = (u: UnitDraft) => {
    const copy: UnitDraft = {
      ...u,
      tempId: crypto.randomUUID(),
      name: `${u.name} (copia)`,
      seasons: u.seasons.map((s) => ({ ...s, tempId: crypto.randomUUID() })),
      blockouts: u.blockouts.map((b) => ({ ...b, tempId: crypto.randomUUID() })),
    }
    setEditing(copy)
    setMode('duplicate')
    setOpen(true)
  }

  return (
    <Stack spacing={2.5}>
      <StepIntro
        title="Unidades"
        subtitle={
          propertyName
            ? `Se agregarán a ${propertyName} — una cabaña única o una habitación con varias iguales. Cada una tendrá su propia tarjeta en el punto de venta.`
            : 'Agrega los alojamientos de esta propiedad — una cabaña única o una habitación con varias iguales. Cada una tendrá su propia tarjeta en el punto de venta.'
        }
      />

      <Button
        variant="contained"
        disableElevation
        startIcon={<AddRounded />}
        onClick={openAdd}
        sx={{ alignSelf: 'flex-start' }}
      >
        Agregar unidad
      </Button>

      {showUnitsError && units.length === 0 && (
        <Alert severity="error">Agrega al menos una unidad para continuar.</Alert>
      )}

      {units.length === 0 ? (
        <Box
          sx={{
            textAlign: 'center',
            py: 4,
            color: 'text.secondary',
            border: '1px dashed',
            borderColor: 'divider',
            borderRadius: 2,
          }}
        >
          <Typography variant="body2">
            Aún no hay unidades — agrega al menos una para poder vender.
          </Typography>
        </Box>
      ) : (
        <Stack spacing={1.5}>
          {units.map((u) => (
            <UnitRow
              key={u.tempId}
              unit={{
                name: u.name,
                unit_type: u.unit_type,
                inventory_count: u.inventory_count,
                beds: u.beds,
                base_occupancy: u.base_occupancy,
                max_capacity: u.max_capacity,
                from_rate: fromNightlyRate(
                  amountToCents(u.base_rate),
                  u.weekend_rate == null ? null : amountToCents(u.weekend_rate),
                ),
                amenities: u.amenities,
              }}
              actions={
                <>
                  <Button size="small" onClick={() => openEdit(u)}>
                    Editar
                  </Button>
                  <Button size="small" onClick={() => duplicate(u)}>
                    Duplicar
                  </Button>
                  <Button
                    size="small"
                    color="inherit"
                    onClick={() => onChange(units.filter((x) => x.tempId !== u.tempId))}
                  >
                    Eliminar
                  </Button>
                </>
              }
            />
          ))}
        </Stack>
      )}

      <UnitDraftSheet
        open={open}
        onClose={() => setOpen(false)}
        initial={editing}
        mode={mode}
        onSave={save}
        // Duplicate-name guard: distinct names are what tell the unit cards apart in the POS.
        // In attach mode the property's server-side units join the local drafts (D11) —
        // without them, the wizard is blind to everything already saved.
        // D9 — only the FIRST unit inherits the name rescued from the property field; after
        // that the user is authoring deliberately and a repeated prefill would be noise.
        suggestedName={units.length === 0 ? suggestedName : undefined}
        existingNames={[
          ...(serverUnitNames ?? []),
          ...units.filter((u) => u.tempId !== editing?.tempId).map((u) => u.name),
        ]}
      />
    </Stack>
  )
}
