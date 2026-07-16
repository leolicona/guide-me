import { useState } from 'react'
import { Stack, Button, Box, Typography, Paper, IconButton } from '@mui/material'
import AddRounded from '@mui/icons-material/AddRounded'
import EditOutlined from '@mui/icons-material/EditOutlined'
import DeleteOutlineRounded from '@mui/icons-material/DeleteOutlineRounded'
import LocalOfferRounded from '@mui/icons-material/LocalOfferRounded'
import { formatMoney, amountToCents } from '../../types'
import { StepIntro } from './StepIntro'
import { ExtraDraftSheet } from './ExtraDraftSheet'
import type { ExtraDraft } from './wizardTypes'

interface StepExtrasProps {
  extras: ExtraDraft[]
  onChange: (extras: ExtraDraft[]) => void
}

// Step 4 — Extras (US-A43, v2). Mirrors the StepUnits repeater: an "Agregar extra" button opens
// the ExtraDraftSheet (add/edit), rows show the price in green with edit/delete actions.
// Optional step — no minimum.
export function StepExtras({ extras, onChange }: StepExtrasProps) {
  const [editing, setEditing] = useState<ExtraDraft | null>(null)
  const [open, setOpen] = useState(false)

  const openAdd = () => {
    setEditing(null)
    setOpen(true)
  }
  const openEdit = (draft: ExtraDraft) => {
    setEditing(draft)
    setOpen(true)
  }

  const save = (draft: ExtraDraft) => {
    const exists = extras.some((e) => e.tempId === draft.tempId)
    onChange(
      exists ? extras.map((e) => (e.tempId === draft.tempId ? draft : e)) : [...extras, draft],
    )
  }

  return (
    <Stack spacing={2.5}>
      <StepIntro
        title="Extras (opcional)"
        subtitle="Agrega opciones con costo adicional para aumentar el ticket promedio: renta de equipo, comida, fotos…"
      />

      <Button
        variant="contained"
        disableElevation
        startIcon={<AddRounded />}
        onClick={openAdd}
        sx={{ alignSelf: 'flex-start' }}
      >
        Agregar extra
      </Button>

      {extras.length === 0 ? (
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
          <LocalOfferRounded sx={{ fontSize: 28, opacity: 0.4 }} />
          <Typography variant="body2" sx={{ mt: 1 }}>
            Aún no hay extras
          </Typography>
        </Box>
      ) : (
        <Stack spacing={1}>
          {extras.map((extra) => (
            <Paper
              key={extra.tempId}
              variant="outlined"
              sx={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                px: 2,
                py: 1.25,
                borderRadius: 2,
              }}
            >
              <Typography sx={{ fontWeight: 500, minWidth: 0, mr: 2 }} noWrap>
                {extra.name}
              </Typography>
              <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                <Typography sx={{ color: 'success.main', fontWeight: 600 }}>
                  {formatMoney(amountToCents(extra.price))}
                </Typography>
                <IconButton
                  size="small"
                  aria-label={`Editar ${extra.name}`}
                  onClick={() => openEdit(extra)}
                >
                  <EditOutlined fontSize="small" />
                </IconButton>
                <IconButton
                  size="small"
                  aria-label={`Eliminar ${extra.name}`}
                  onClick={() => onChange(extras.filter((x) => x.tempId !== extra.tempId))}
                >
                  <DeleteOutlineRounded fontSize="small" />
                </IconButton>
              </Stack>
            </Paper>
          ))}
        </Stack>
      )}

      <ExtraDraftSheet
        open={open}
        onClose={() => setOpen(false)}
        initial={editing}
        onSave={save}
        existingNames={extras.filter((e) => e.tempId !== editing?.tempId).map((e) => e.name)}
      />
    </Stack>
  )
}
