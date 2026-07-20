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
import type { PosServiceDetail, PosSlot, PosSlotZone } from '../types'
import { usePosCart, type CartExtra } from '../../../store/posCart'
import { formatMoney } from '../../catalog/types'
import { chipPillSx } from '../../filters'

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

  const zonesEnabled = !!service.zones_enabled

  // US-AG32 — party size is chosen FIRST (before any slot), default 1.
  const [partySize, setPartySize] = useState(1)
  const [slot, setSlot] = useState<PosSlot | null>(null)
  // US-A64 — on a zoned service the agent picks a zone after the departure.
  const [zone, setZone] = useState<PosSlotZone | null>(null)
  const [extraQtys, setExtraQtys] = useState<Record<string, number>>({})

  // US-AG32 — the largest group any in-window slot can seat (Effective Capacity, US-A36). On a
  // zoned service a party can't span zones, so the ceiling is the biggest single-zone remaining.
  // Caps the People counter so the agent can never request a group no slot/zone fits.
  const maxParty = useMemo(
    () =>
      zonesEnabled
        ? Math.max(
            1,
            ...service.slots.flatMap((s) =>
              (s.zones ?? [])
                .filter((z) => z.status === 'active')
                .map((z) => z.remaining),
            ),
          )
        : Math.max(
            1,
            ...service.slots.map((s) =>
              effectiveRemaining(s, service.is_flexible, service.flex_capacity_pct),
            ),
          ),
    [service, zonesEnabled],
  )

  const clearSelection = () => {
    setSlot(null)
    setZone(null)
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

  const handleSelectSlot = (s: PosSlot) => {
    setSlot(s)
    setZone(null) // a new departure clears the zone pick
  }

  const handleAdd = () => {
    if (!slot || (zonesEnabled && !zone)) return
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
      // The cart caps quantity at the line's `remaining`: a zoned line is bounded by its zone's
      // seats; a Soft Cap slot by Effective Capacity (raw + flexible margin).
      slot: { ...slot, remaining: cap },
      zone: zone ? { id: zone.zone_id, name: zone.name } : undefined,
      quantity: partySize,
      // Price is locked to base here — the discount is applied later in the cart.
      unit_price: service.base_price,
      extras,
    })
    onAdded()
  }

  // Active zones on the selected departure (empty for an unzoned service).
  const slotZones = (slot?.zones ?? []).filter((z) => z.status === 'active')

  // The sellable ceiling for the current selection: the chosen zone's remaining (zoned), else the
  // slot's Effective Capacity (raw + flexible margin for Soft Cap). `inFlexZone` flags a Soft Cap
  // party crossing into the overbooking margin.
  const flexRemaining = slot
    ? effectiveRemaining(slot, service.is_flexible, service.flex_capacity_pct)
    : 0
  const cap = zonesEnabled ? (zone?.remaining ?? 0) : flexRemaining
  const inFlexZone = !zonesEnabled && !!slot && partySize > slot.remaining

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

        {/* US-A64 — zone chips: pick a physical zone on the chosen departure. Bound by the zone's
            own remaining; a zone that can't seat the party (or is closed) is disabled. */}
        {slot && zonesEnabled && (
          <Box sx={{ mt: 3 }}>
            <Typography variant="subtitle2" color="text.secondary" sx={{ mb: 1 }}>
              Elige una zona
            </Typography>
            <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
              {slotZones.map((z) => {
                const fits = z.remaining >= partySize
                const selected = zone?.zone_id === z.zone_id
                return (
                  <Box
                    key={z.zone_id}
                    component="button"
                    type="button"
                    disabled={!fits}
                    onClick={() => setZone(z)}
                    sx={{
                      ...chipPillSx(selected),
                      border: 'none',
                      cursor: fits ? 'pointer' : 'default',
                      opacity: fits ? 1 : 0.5,
                      flexDirection: 'column',
                      height: 'auto',
                      py: 1,
                    }}
                  >
                    <Typography variant="body2" sx={{ fontWeight: 600 }}>
                      {z.name}
                    </Typography>
                    <Typography variant="caption" color={selected ? 'primary.main' : 'text.secondary'}>
                      {z.remaining} disponibles
                    </Typography>
                  </Box>
                )
              })}
            </Stack>
          </Box>
        )}

        {slot && (!zonesEnabled || zone) && service.extras.length > 0 && (
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
          disabled={!slot || (zonesEnabled && !zone)}
          sx={{ py: 1.25 }}
        >
          {!slot
            ? 'Elige un horario'
            : zonesEnabled && !zone
              ? 'Elige una zona'
              : 'Agregar al carrito'}
        </Button>
      </Box>
    </Box>
  )
}
