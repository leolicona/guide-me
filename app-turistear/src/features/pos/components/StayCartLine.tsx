import { useState } from 'react'
import {
  Box,
  Stack,
  Typography,
  IconButton,
  Collapse,
  Button,
  TextField,
  InputAdornment,
} from '@mui/material'
import DeleteOutlineRounded from '@mui/icons-material/DeleteOutlineRounded'
import ExpandMoreRounded from '@mui/icons-material/ExpandMoreRounded'
import { MoneyText } from '../../../components'
import { formatMoney, centsToAmount, amountToCents } from '../../catalog/types'
import { usePosCart, type StayCartLine as StayCartLineModel } from '../../../store/posCart'

const WEEKDAYS_ES = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb']

// "Sáb 10" for a YYYY-MM-DD (UTC getters, matching the engine's date math).
const dayLabel = (date: string): string => {
  const d = new Date(`${date}T00:00:00Z`)
  return `${WEEKDAYS_ES[d.getUTCDay()]} ${d.getUTCDate()}`
}

interface StayCartLineProps {
  line: StayCartLineModel
  onRemove: () => void
}

// US-AG57 — the stay's discount. Shaped like the tour line's «Precio unitario» field, but bound to
// the SERVER's floor (`min_total`) rather than to a percent recomputed here, so the number the
// agent is shown and the number the confirm enforces are the same one (D6). Edits stay local while
// typing so the store's clamp does not fight the keystrokes; on blur the total commits and snaps
// back into [min_total, quoted_total].
function StayTotalField({ line }: { line: StayCartLineModel }) {
  const setStayTotal = usePosCart((s) => s.setStayTotal)
  const [value, setValue] = useState(String(centsToAmount(line.total)))

  const cents = value === '' ? NaN : amountToCents(Number(value))
  const belowMin = cents < line.min_total
  const aboveQuote = cents > line.quoted_total
  const invalid = Number.isNaN(cents) || belowMin || aboveQuote

  const commit = () => {
    const next = Number.isNaN(cents)
      ? line.total
      : Math.min(Math.max(cents, line.min_total), line.quoted_total)
    setStayTotal(line.id, next)
    setValue(String(centsToAmount(next)))
  }

  return (
    <TextField
      label="Total"
      type="number"
      size="small"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      error={value !== '' && invalid}
      helperText={
        belowMin
          ? `Mínimo ${formatMoney(line.min_total)}`
          : aboveQuote
            ? `Máximo ${formatMoney(line.quoted_total)}`
            : `Mín ${formatMoney(line.min_total)}`
      }
      slotProps={{
        inputLabel: { shrink: true },
        input: { startAdornment: <InputAdornment position="start">$</InputAdornment> },
        htmlInput: {
          min: centsToAmount(line.min_total),
          max: centsToAmount(line.quoted_total),
          step: 0.01,
          inputMode: 'decimal',
          'aria-label': 'Total de la estancia',
        },
      }}
      sx={{ width: 150 }}
    />
  )
}

// US-AG38 — the checkout line for a stay (transactional hierarchy: the total reads first, the
// per-night math is secondary and expandable).
export function StayCartLine({ line, onRemove }: StayCartLineProps) {
  const [open, setOpen] = useState(false)

  return (
    <Box>
      <Stack direction="row" spacing={1} sx={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <Box sx={{ minWidth: 0 }}>
          <Typography variant="subtitle2">
            {line.unit_type_name}
            {line.quantity > 1 ? ` × ${line.quantity}` : ''}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            {/* Rooms live in the title ("× 2") — the meta stays dates · nights · guests. */}
            {dayLabel(line.check_in)} → {dayLabel(line.check_out)} · {line.nights}{' '}
            {line.nights === 1 ? 'noche' : 'noches'} · {line.guests}{' '}
            {line.guests === 1 ? 'huésped' : 'huéspedes'}
          </Typography>
          {line.per_night.length > 0 && (
            <Button
              size="small"
              onClick={() => setOpen((o) => !o)}
              endIcon={
                <ExpandMoreRounded
                  sx={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }}
                />
              }
              sx={{ mt: 0.5, px: 0.5 }}
            >
              Ver desglose
            </Button>
          )}
        </Box>
        <Stack spacing={0.5} sx={{ alignItems: 'flex-end', flexShrink: 0 }}>
          {/* D7 — a unidad with no discount ceiling renders the total as text. A control that can
              only ever reject the agent's input is noise on a counter, and this keeps the feature
              invisible until an admin turns it on. */}
          {line.min_total < line.quoted_total ? (
            <StayTotalField line={line} />
          ) : (
            <MoneyText cents={line.total} variant="subtitle2" srLabel="Total de la estancia" />
          )}
          <IconButton size="small" aria-label="Eliminar estancia" onClick={onRemove}>
            <DeleteOutlineRounded fontSize="small" />
          </IconButton>
        </Stack>
      </Stack>

      <Collapse in={open} unmountOnExit>
        <Stack spacing={0.25} sx={{ mt: 1, pl: 1 }}>
          {line.per_night.map((n) => (
            <Stack key={n.date} direction="row" sx={{ justifyContent: 'space-between' }}>
              <Typography variant="caption" color="text.secondary">
                {dayLabel(n.date)}
              </Typography>
              <Typography variant="caption" color="text.secondary" className="numeric">
                {formatMoney(n.rate)}
              </Typography>
            </Stack>
          ))}
        </Stack>
      </Collapse>
    </Box>
  )
}
