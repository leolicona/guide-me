import { useMemo, useState } from 'react'
import {
  Box,
  Typography,
  Button,
  Stack,
  Divider,
  IconButton,
} from '@mui/material'
import AddRounded from '@mui/icons-material/AddRounded'
import RemoveRounded from '@mui/icons-material/RemoveRounded'
import ShoppingCartRounded from '@mui/icons-material/ShoppingCartRounded'
import { SlotPicker } from './SlotPicker'
import { effectiveRemaining } from '../capacity'
import { useRepeatPress } from '../hooks'
import type { PosServiceDetail, PosSlot } from '../types'
import { usePosCart, type CartExtra } from '../../../store/posCart'
import { formatMoney } from '../../catalog/types'

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

// US-AG31/AG32/AG33/AG34 — the sale-configuration body, laid out as fixed header (service +
// People) · scrollable date/time matrix · pinned "Agregar al carrito" footer. This step is
// strictly about securing inventory: the unit-price adjustment now lives in the cart, so the
// agent locks the slot here and tunes the discount at checkout. The server stays the single
// source of truth — the bounds here are display/input guards only.
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
    setExtraQtys({})
  }

  // The People counter only grows via the `+` button. When it does, the currently selected
  // slot may no longer seat the group — clear it here so extras/confirm collapse until a
  // fitting slot is re-picked (US-AG32, Scenario 9). Returns whether the value changed, so
  // the long-press repeat (useRepeatPress) stops once the cap is reached.
  const incrementParty = (): boolean => {
    if (partySize >= maxParty) return false
    const next = partySize + 1
    setPartySize(next)
    if (
      slot &&
      effectiveRemaining(slot, service.is_flexible, service.flex_capacity_pct) < next
    ) {
      clearSelection()
    }
    return true
  }

  const decrementParty = (): boolean => {
    if (partySize <= 1) return false
    setPartySize(partySize - 1)
    return true
  }

  const incHandlers = useRepeatPress(incrementParty)
  const decHandlers = useRepeatPress(decrementParty)

  const handleSelectSlot = (s: PosSlot) => setSlot(s)

  const handleAdd = () => {
    if (!slot) return
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
      // Price is locked to base here — the discount is applied later in the cart.
      unit_price: service.base_price,
      extras,
    })
    onAdded()
  }

  // US-A36 — the sellable ceiling for the selected slot: raw remaining for a Hard Cap
  // service, raw + flexible margin for a Soft Cap one. `inFlexZone` is true once the party
  // size crosses the strict capacity into the overbooking margin, so the UI can flag it.
  const flexRemaining = slot
    ? effectiveRemaining(slot, service.is_flexible, service.flex_capacity_pct)
    : 0
  const inFlexZone = !!slot && partySize > slot.remaining

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      {/* ── Fixed header: service identity + People (US-AG32, chosen first) ── */}
      <Box sx={{ px: 3, pt: 1, pb: 2.5, flexShrink: 0 }}>
        <Typography variant="h5" component="h2" sx={{ fontWeight: 600 }}>
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

        <Stack
          direction="row"
          sx={{ alignItems: 'center', justifyContent: 'space-between', mt: 2.5 }}
        >
          <Box>
            <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>
              Personas
            </Typography>
            {inFlexZone && (
              <Typography variant="caption" color="warning.main" sx={{ fontWeight: 600 }}>
                Usando cupo flexible · {flexRemaining} máx.
              </Typography>
            )}
          </Box>

          {/* Stepper pill — hold +/- to accelerate (useRepeatPress). */}
          <Stack
            direction="row"
            sx={{
              alignItems: 'center',
              border: '1px solid',
              borderColor: 'divider',
              borderRadius: 999,
              px: 0.5,
            }}
          >
            <IconButton
              size="small"
              aria-label="Menos personas"
              disabled={partySize <= 1}
              sx={{ touchAction: 'none' }}
              {...decHandlers}
            >
              <RemoveRounded fontSize="small" />
            </IconButton>
            <Typography
              sx={{ minWidth: 36, textAlign: 'center', fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}
            >
              {partySize}
            </Typography>
            <IconButton
              size="small"
              aria-label="Más personas"
              color="secondary"
              disabled={partySize >= maxParty}
              sx={{ touchAction: 'none' }}
              {...incHandlers}
            >
              <AddRounded fontSize="small" />
            </IconButton>
          </Stack>
        </Stack>
      </Box>

      <Divider />

      {/* ── Scrollable matrix (the ONLY overflow-y region) ── */}
      <Box sx={{ flex: 1, minHeight: 0, overflowY: 'auto', px: 3, py: 2.5 }}>
        <Typography variant="subtitle2" color="text.secondary" sx={{ mb: 1.5 }}>
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

        {slot && service.extras.length > 0 && (
          <Box sx={{ mt: 3 }}>
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
      </Box>

      <Divider />

      {/* ── Pinned footer: always visible, enabled once a slot is chosen ── */}
      <Box sx={{ px: 3, py: 2, flexShrink: 0 }}>
        <Button
          fullWidth
          size="large"
          variant="contained"
          color="secondary"
          disableElevation
          startIcon={<ShoppingCartRounded />}
          onClick={handleAdd}
          disabled={!slot}
          sx={{ py: 1.25 }}
        >
          {slot ? 'Agregar al carrito' : 'Elige un horario'}
        </Button>
      </Box>
    </Box>
  )
}
