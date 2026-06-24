import {
  Box,
  Stack,
  Switch,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
  InputAdornment,
  Collapse,
} from '@mui/material'
import type { Service } from '../../catalog/types'
import { categoryLabel } from '../../catalog/categories'
import type { CommissionDraft, CommissionDraftMap } from '../commission'
import { defaultDraft } from '../commission'

interface Props {
  services: Service[]
  value: CommissionDraftMap
  onChange: (next: CommissionDraftMap) => void
}

// US-A56 — the curated catalog + per-service commission editor. Each active service is a card
// row with an ON/OFF switch; enabling it reveals an inline value field + %/$ toggle. Turning a
// service ON is what adds it to the affiliate's allow-list (the row's existence, D1/D2).
export function CommissionCatalogEditor({ services, value, onChange }: Props) {
  const update = (id: string, patch: Partial<CommissionDraft>) => {
    const current = value[id] ?? defaultDraft()
    onChange({ ...value, [id]: { ...current, ...patch } })
  }

  if (services.length === 0) {
    return (
      <Typography color="text.secondary" sx={{ py: 2 }}>
        No hay servicios activos en el catálogo. Crea un servicio antes de configurar comisiones.
      </Typography>
    )
  }

  return (
    <Stack spacing={1.5}>
      {services.map((svc) => {
        const draft = value[svc.id] ?? defaultDraft()
        const isFixed = draft.commission_type === 'fixed'
        const invalid = draft.enabled && !(typeof draft.value === 'number' && draft.value > 0)

        return (
          <Box
            key={svc.id}
            sx={{
              border: '1px solid',
              borderColor: draft.enabled ? 'secondary.main' : 'divider',
              borderRadius: 2,
              p: 2,
              transition: 'border-color 150ms',
            }}
          >
            <Stack
              direction="row"
              sx={{ alignItems: 'center', justifyContent: 'space-between', gap: 1 }}
            >
              <Box sx={{ minWidth: 0 }}>
                <Typography variant="body1" noWrap sx={{ fontWeight: 500 }}>
                  {svc.name}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  {categoryLabel(svc.category)}
                </Typography>
              </Box>
              <Switch
                color="secondary"
                checked={draft.enabled}
                onChange={(e) => update(svc.id, { enabled: e.target.checked })}
                slotProps={{ input: { 'aria-label': `Habilitar ${svc.name}` } }}
              />
            </Stack>

            <Collapse in={draft.enabled} unmountOnExit>
              <Stack direction="row" spacing={1.5} sx={{ mt: 2, alignItems: 'flex-start' }}>
                <ToggleButtonGroup
                  exclusive
                  size="small"
                  color="secondary"
                  value={draft.commission_type}
                  onChange={(_, v) => v && update(svc.id, { commission_type: v })}
                  aria-label="Tipo de comisión"
                >
                  <ToggleButton value="percent" aria-label="Porcentaje">
                    %
                  </ToggleButton>
                  <ToggleButton value="fixed" aria-label="Monto fijo">
                    $
                  </ToggleButton>
                </ToggleButtonGroup>

                <TextField
                  size="small"
                  type="number"
                  value={draft.value}
                  onChange={(e) =>
                    update(svc.id, {
                      value: e.target.value === '' ? '' : Number(e.target.value),
                    })
                  }
                  error={invalid}
                  helperText={
                    invalid
                      ? 'Ingresa un valor mayor a 0'
                      : isFixed
                        ? 'Monto por persona'
                        : 'Porcentaje de la venta'
                  }
                  placeholder={isFixed ? '0.00' : '0'}
                  slotProps={{
                    input: {
                      startAdornment: isFixed ? (
                        <InputAdornment position="start">$</InputAdornment>
                      ) : undefined,
                      endAdornment: !isFixed ? (
                        <InputAdornment position="end">%</InputAdornment>
                      ) : undefined,
                    },
                    htmlInput: { min: 0, step: isFixed ? 0.01 : 1 },
                  }}
                  sx={{ maxWidth: 180 }}
                />
              </Stack>
            </Collapse>
          </Box>
        )
      })}
    </Stack>
  )
}
