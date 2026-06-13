import { useState } from 'react'
import {
  Stack,
  TextField,
  InputAdornment,
  Button,
  Box,
  Typography,
  Paper,
  IconButton,
} from '@mui/material'
import AddRounded from '@mui/icons-material/AddRounded'
import DeleteOutlineRounded from '@mui/icons-material/DeleteOutlineRounded'
import LocalOfferRounded from '@mui/icons-material/LocalOfferRounded'
import { formatMoney, amountToCents } from '../../types'
import { StepIntro } from './StepIntro'
import type { ExtraDraft } from './wizardTypes'

interface StepExtrasProps {
  extras: ExtraDraft[]
  onChange: (extras: ExtraDraft[]) => void
}

/** Step 4 — Extras (US-A43). Inline add form (Add disabled until both filled), newest-first
 * list with the price in green, inputs clear after add, trash to remove. Optional step. */
export function StepExtras({ extras, onChange }: StepExtrasProps) {
  const [name, setName] = useState('')
  const [price, setPrice] = useState('')

  const priceNum = Number(price)
  const canAdd = name.trim().length > 0 && price.trim().length > 0 && priceNum >= 0

  const add = () => {
    if (!canAdd) return
    onChange([{ name: name.trim(), price: priceNum }, ...extras])
    setName('')
    setPrice('')
  }

  const remove = (index: number) =>
    onChange(extras.filter((_, i) => i !== index))

  return (
    <Stack spacing={2.5}>
      <StepIntro
        title="Extras (opcional)"
        subtitle="Agrega opciones con costo adicional para aumentar el ticket promedio: renta de equipo, comida, fotos…"
      />

      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        spacing={1.5}
        sx={{ alignItems: 'flex-start' }}
      >
        <TextField
          label="Nombre del extra"
          placeholder="p. ej. Renta de equipo"
          fullWidth
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <TextField
          label="Precio"
          type="number"
          value={price}
          onChange={(e) => setPrice(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              add()
            }
          }}
          slotProps={{
            input: {
              startAdornment: <InputAdornment position="start">$</InputAdornment>,
            },
            htmlInput: { step: 0.01, min: 0, inputMode: 'decimal' },
          }}
          sx={{ width: { xs: '100%', sm: 160 }, flexShrink: 0 }}
        />
        <Button
          onClick={add}
          disabled={!canAdd}
          startIcon={<AddRounded />}
          variant="outlined"
          color="secondary"
          sx={{ flexShrink: 0, mt: { sm: 1 }, height: 40 }}
        >
          Agregar
        </Button>
      </Stack>

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
          {extras.map((extra, i) => (
            <Paper
              key={`${extra.name}-${i}`}
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
                  aria-label={`Eliminar ${extra.name}`}
                  onClick={() => remove(i)}
                >
                  <DeleteOutlineRounded fontSize="small" />
                </IconButton>
              </Stack>
            </Paper>
          ))}
        </Stack>
      )}
    </Stack>
  )
}
