import { useMemo, useState } from 'react'
import {
  Box,
  Typography,
  Button,
  Stack,
  Divider,
  TextField,
  IconButton,
} from '@mui/material'
import AddRounded from '@mui/icons-material/AddRounded'
import RemoveRounded from '@mui/icons-material/RemoveRounded'
import { SlotPicker } from './SlotPicker'
import { effectiveRemaining } from '../capacity'
import type { PosServiceDetail, PosSlot } from '../types'
import { usePosCart, type CartExtra } from '../../../store/posCart'
import {
  amountToCents,
  centsToAmount,
  formatMoney,
} from '../../catalog/types'

interface ServiceSelectionPanelProps {
  service: PosServiceDetail
  /** US-AG33 — the day axis to render (from the owner): 3 days on the "Hoy" anchor, 1 for
   * an explicit catalog date. */
  days: string[]
  /** Real org-local today, for the "Hoy" relative label. */
  today: string
  /** Fired after a line is successfully staged in the cart — the owner (sheet / page)
   * decides what happens next (close + snackbar, or its own snackbar). */
  onAdded: () => void
}

// US-AG31/AG32/AG33/AG34 — the shared sale-configuration body, ordered **people → date/time
// matrix → price/extras → confirm**. The people-first reactive filter (US-AG32) and the
// orange cushion warning (US-AG34) live in the matrix; the server stays the single source
// of truth — these bounds are display/input guards only.
export function ServiceSelectionPanel({
  service,
  days,
  today,
  onAdded,
}: ServiceSelectionPanelProps) {
  const addLine = usePosCart((s) => s.addLine)

  // US-AG32 — party size is chosen FIRST (before any slot), default 1.
  const [partySize, setPartySize] = useState(1)
  const [slot, setSlot] = useState<PosSlot | null>(null)
  // Discount price is edited in major units; clamped to [minimum, base].
  const [priceInput, setPriceInput] = useState('')
  const [extraQtys, setExtraQtys] = useState<Record<string, number>>({})

  // US-AG32 — the largest group any in-window slot can seat (Effective Capacity, US-A36).
  // Caps the People counter so the agent can never request a group no slot fits.
  const maxParty = useMemo(
    () =>
      Math.max(
        1,
        ...service.slots.map((s) =>
          effectiveRemaining(s, service.is_flexible, service.flex_capacity_pct),
        ),
      ),
    [service],
  )

  const clearSelection = () => {
    setSlot(null)
    setPriceInput('')
    setExtraQtys({})
  }

  // The People counter only grows via the `+` button. When it does, the currently selected
  // slot may no longer seat the group — clear it here (rather than in an effect) so
  // price/extras/confirm collapse until a fitting slot is re-picked (US-AG32, Scenario 9).
  const incrementParty = () => {
    const next = Math.min(maxParty, partySize + 1)
    setPartySize(next)
    if (
      slot &&
      effectiveRemaining(slot, service.is_flexible, service.flex_capacity_pct) < next
    ) {
      clearSelection()
    }
  }

  const handleSelectSlot = (s: PosSlot) => {
    setSlot(s)
    setPriceInput(String(centsToAmount(service.base_price)))
  }

  const handleAdd = () => {
    if (!slot) return
    const unitCents = amountToCents(Number(priceInput))
    const extras: CartExtra[] = service.extras
      .filter((e) => (extraQtys[e.id] ?? 0) > 0)
      .map((e) => ({ extra: e, quantity: extraQtys[e.id] }))

    addLine({
      service: {
        id: service.id,
        name: service.name,
        base_price: service.base_price,
        minimum_price: service.minimum_price,
      },
      // US-A36 — the cart caps quantity at `remaining`; for a Soft Cap service that ceiling
      // is the Effective Capacity (raw + flexible margin), so pass the effective figure.
      slot: { ...slot, remaining: flexRemaining },
      quantity: partySize,
      unit_price: unitCents,
      extras,
    })
    onAdded()
  }

  // Discount-field validation (the store also clamps; this drives inline UX).
  const priceCents = priceInput === '' ? NaN : amountToCents(Number(priceInput))
  const belowMin = priceCents < service.minimum_price
  const aboveBase = priceCents > service.base_price
  const priceInvalid = Number.isNaN(priceCents) || belowMin || aboveBase

  // US-A36 — the sellable ceiling for the selected slot: raw remaining for a Hard Cap
  // service, raw + flexible margin for a Soft Cap one. `inFlexZone` is true once the party
  // size crosses the strict capacity into the overbooking margin, so the UI can flag it.
  const flexRemaining = slot
    ? effectiveRemaining(slot, service.is_flexible, service.flex_capacity_pct)
    : 0
  const inFlexZone = !!slot && partySize > slot.remaining

  return (
    <Stack spacing={3}>
      <Box>
        <Typography variant="h5" component="h2">
          {service.name}
        </Typography>
        {service.description && (
          <Typography color="text.secondary" sx={{ mt: 0.5 }}>
            {service.description}
          </Typography>
        )}
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
          {formatMoney(service.base_price)} · mín {formatMoney(service.minimum_price)}
        </Typography>
      </Box>

      {/* US-AG32 — People control is the FIRST interactive element. */}
      <Box>
        <Typography variant="subtitle2" color="text.secondary" sx={{ mb: 1 }}>
          Personas
        </Typography>
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
          <IconButton
            size="small"
            aria-label="Menos personas"
            onClick={() => setPartySize((q) => Math.max(1, q - 1))}
            disabled={partySize <= 1}
          >
            <RemoveRounded />
          </IconButton>
          <Typography sx={{ minWidth: 32, textAlign: 'center' }}>{partySize}</Typography>
          <IconButton
            size="small"
            aria-label="Más personas"
            onClick={incrementParty}
            disabled={partySize >= maxParty}
          >
            <AddRounded />
          </IconButton>
          {inFlexZone && (
            <Typography
              variant="caption"
              color="warning.main"
              sx={{ ml: 1, fontWeight: 600 }}
            >
              Usando cupo flexible · {flexRemaining} máx.
            </Typography>
          )}
        </Stack>
      </Box>

      {/* US-AG33/AG34 — date/time matrix: a row per day, per-day fit filter + orange cushion. */}
      <Box>
        <Typography variant="subtitle2" color="text.secondary" sx={{ mb: 1 }}>
          Elige un horario
        </Typography>
        {service.slots.length === 0 ? (
          <Typography color="text.secondary">
            No hay horarios disponibles para este servicio.
          </Typography>
        ) : (
          <SlotPicker
            slots={service.slots}
            days={days}
            today={today}
            partySize={partySize}
            selectedId={slot?.id ?? null}
            onSelect={handleSelectSlot}
            isFlexible={service.is_flexible}
            flexCapacityPct={service.flex_capacity_pct}
          />
        )}
      </Box>

      {slot && (
        <>
          <Box>
            <Typography variant="subtitle2" color="text.secondary" sx={{ mb: 1 }}>
              Precio unitario
            </Typography>
            <TextField
              type="number"
              size="small"
              value={priceInput}
              onChange={(e) => setPriceInput(e.target.value)}
              error={priceInput !== '' && priceInvalid}
              helperText={
                belowMin
                  ? `Mínimo ${formatMoney(service.minimum_price)}`
                  : aboveBase
                    ? `Máximo ${formatMoney(service.base_price)}`
                    : `Mín ${formatMoney(service.minimum_price)} · base ${formatMoney(service.base_price)}`
              }
              slotProps={{
                htmlInput: {
                  min: centsToAmount(service.minimum_price),
                  max: centsToAmount(service.base_price),
                  step: 0.01,
                },
              }}
            />
          </Box>

          {service.extras.length > 0 && (
            <Box>
              <Typography variant="subtitle2" color="text.secondary" sx={{ mb: 1 }}>
                Extras
              </Typography>
              <Stack spacing={1} divider={<Divider flexItem />}>
                {service.extras.map((extra) => {
                  const qty = extraQtys[extra.id] ?? 0
                  return (
                    <Stack
                      key={extra.id}
                      direction="row"
                      spacing={1}
                      sx={{ alignItems: 'center', justifyContent: 'space-between' }}
                    >
                      <Box sx={{ minWidth: 0 }}>
                        <Typography variant="body2">{extra.name}</Typography>
                        <Typography variant="caption" color="text.secondary">
                          {formatMoney(extra.price)}
                        </Typography>
                      </Box>
                      <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center' }}>
                        <IconButton
                          size="small"
                          aria-label={`Menos ${extra.name}`}
                          onClick={() =>
                            setExtraQtys((m) => ({
                              ...m,
                              [extra.id]: Math.max(0, qty - 1),
                            }))
                          }
                          disabled={qty <= 0}
                        >
                          <RemoveRounded fontSize="small" />
                        </IconButton>
                        <Typography sx={{ minWidth: 24, textAlign: 'center' }}>
                          {qty}
                        </Typography>
                        <IconButton
                          size="small"
                          aria-label={`Más ${extra.name}`}
                          onClick={() =>
                            setExtraQtys((m) => ({
                              ...m,
                              [extra.id]: qty + 1,
                            }))
                          }
                        >
                          <AddRounded fontSize="small" />
                        </IconButton>
                      </Stack>
                    </Stack>
                  )
                })}
              </Stack>
            </Box>
          )}

          <Button
            variant="contained"
            disableElevation
            onClick={handleAdd}
            disabled={priceInvalid}
          >
            Agregar al carrito
          </Button>
        </>
      )}
    </Stack>
  )
}
