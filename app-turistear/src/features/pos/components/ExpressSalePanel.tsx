import { useEffect, useMemo, useState } from 'react'
import {
  Box,
  Typography,
  Button,
  Stack,
  IconButton,
  TextField,
  InputAdornment,
  ButtonBase,
  Chip,
  Alert,
  Snackbar,
} from '@mui/material'
import AddRounded from '@mui/icons-material/AddRounded'
import RemoveRounded from '@mui/icons-material/RemoveRounded'
import BoltRounded from '@mui/icons-material/BoltRounded'
import QrCode2Rounded from '@mui/icons-material/QrCode2Rounded'
import UndoRounded from '@mui/icons-material/UndoRounded'
import { useQueryClient } from '@tanstack/react-query'
import { useConfirmSale } from '../hooks'
import { useRepeatPress } from '../hooks'
import { effectiveRemaining } from '../capacity'
import { isSendablePhone } from '../phone'
import { voidExpressSale } from '../../../services/posService'
import { ServiceError } from '../../../services/authService'
import { formatMoney, amountToCents, centsToAmount } from '../../catalog/types'
import { TicketWhatsAppButton } from '../../bookings/components/TicketWhatsAppButton'
import { ExpressTicketOverlay } from './ExpressTicketOverlay'
import type { PosServiceDetail, PosSlot, Folio } from '../types'
import { POS_QUERY_KEY } from '../hooks/usePosServices'

interface ExpressSalePanelProps {
  service: PosServiceDetail
  /** Org-local today (US-A66) — Express is same-day ONLY (D5). */
  today: string
}

// US-AG47 — the void window, mirrored from the server (which is authoritative; this only decides
// how long the button renders).
const VOID_WINDOW_MS = 60_000

const errorMessage = (error: unknown): string => {
  if (error instanceof ServiceError) {
    if (error.code === 'SLOT_UNAVAILABLE') return 'Ese horario se acaba de agotar.'
    if (error.code === 'SLOT_CLOSED') return 'Ese horario ya cerró para venta.'
    if (error.code === 'EXPRESS_NOT_ELIGIBLE')
      return 'Este servicio no admite Venta Express.'
    if (error.code === 'PRICE_BELOW_MINIMUM') return 'El precio está debajo del mínimo.'
  }
  return 'No se pudo completar la venta. Inténtalo de nuevo.'
}

// US-AG45/AG46 — the ⚡ Venta Express body: seats (+5/+10) · today's departures (ALL visible,
// none hidden — D6/D7 diverge from US-AG32 deliberately) · price inside [mín, base] · phone ·
// Cobrar. After each sale the service AND departure stay selected (D20): seats → 1, price → base,
// phone cleared, tally up — the next customer in the queue starts at zero taps.
export function ExpressSalePanel({ service, today }: ExpressSalePanelProps) {
  const queryClient = useQueryClient()
  const confirm = useConfirmSale()

  const todaySlots = useMemo(
    () =>
      service.slots
        .filter((s) => s.date === today)
        .sort((a, b) => a.start_time.localeCompare(b.start_time)),
    [service.slots, today],
  )
  const remainingOf = (s: PosSlot) =>
    effectiveRemaining(s, service.is_flexible, service.flex_capacity_pct)

  // D6 — the NEAREST fitting departure is preselected; D7 — once picked (or preselected), it is
  // HELD: growing the party clamps to this slot and never auto-advances.
  const [slotId, setSlotId] = useState<string | null>(
    () => todaySlots.find((s) => remainingOf(s) >= 1)?.id ?? null,
  )
  const slot = todaySlots.find((s) => s.id === slotId) ?? null
  const cap = slot ? remainingOf(slot) : 0

  const [seats, setSeats] = useState(1)
  const [clampMsg, setClampMsg] = useState<string | null>(null)
  const [priceInput, setPriceInput] = useState(() => String(centsToAmount(service.base_price)))
  const [phone, setPhone] = useState('')
  // D21 — one replay key per SALE ATTEMPT: minted when the form resets, so a double-tap or a
  // retry of the same sale re-sends the same key and can never sell twice.
  const [idemKey, setIdemKey] = useState(() => crypto.randomUUID())

  // D20 — the session tally (labelled "Esta sesión", never "caja": the authoritative drawer
  // figure lives on /balance, computed over the whole shift).
  const [tally, setTally] = useState({ count: 0, cents: 0 })
  const [lastSale, setLastSale] = useState<{ folio: Folio; at: number } | null>(null)
  const [overlayToken, setOverlayToken] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [voiding, setVoiding] = useState(false)

  // Seats — additive steppers (+1 hold-to-repeat, +5, +10), clamped to the HELD slot's effective
  // remaining. When the clamp bites, say why and name the best alternative (D7) — the departures
  // are all visible below, so the agent re-picks with one tap if they want the bigger boat.
  const addSeats = (n: number): boolean => {
    if (!slot) return false
    const wanted = seats + n
    const next = Math.max(1, Math.min(wanted, cap))
    if (next !== seats) setSeats(next)
    if (wanted > cap) {
      const alt = todaySlots
        .filter((s) => s.id !== slot.id && remainingOf(s) > cap)
        .sort((a, b) => remainingOf(b) - remainingOf(a))[0]
      setClampMsg(
        `Máx ${cap} en las ${slot.start_time}` +
          (alt ? ` · ${alt.start_time} tiene ${remainingOf(alt)}` : ''),
      )
      return false
    }
    setClampMsg(null)
    return next !== seats
  }
  const incHandlers = useRepeatPress(() => addSeats(1))
  const decHandlers = useRepeatPress(() => {
    setClampMsg(null)
    if (seats <= 1) return false
    setSeats(seats - 1)
    return true
  })

  const priceCents = priceInput.trim() === '' ? NaN : amountToCents(Number(priceInput))
  const priceValid =
    !Number.isNaN(priceCents) &&
    priceCents >= service.minimum_price &&
    priceCents <= service.base_price
  const commitPrice = () => {
    const clamped = Number.isNaN(priceCents)
      ? service.base_price
      : Math.min(Math.max(priceCents, service.minimum_price), service.base_price)
    setPriceInput(String(centsToAmount(clamped)))
  }
  const phoneValid = isSendablePhone(phone)
  const total = priceValid ? priceCents * seats : 0
  const canCobrar =
    !confirm.isPending && !!slot && cap >= seats && priceValid && phoneValid

  const refreshAvailability = () =>
    queryClient.invalidateQueries({ queryKey: POS_QUERY_KEY })

  const handleCobrar = () => {
    if (!canCobrar || !slot) return
    confirm.mutate(
      {
        sale_mode: 'express',
        idempotency_key: idemKey,
        customer_phone: phone,
        payment_method: 'cash',
        lines: [{ slot_id: slot.id, quantity: seats, unit_price: priceCents, extras: [] }],
      },
      {
        onSuccess: (folio) => {
          const token = folio.lines[0]?.qr_token ?? null
          setLastSale({ folio, at: Date.now() })
          setVoidWindowOpen(true)
          setOverlayToken(token) // the QR IS the delivery — full-bleed, immediately
          setTally((t) => ({ count: t.count + 1, cents: t.cents + folio.total }))
          // D20 — reset for the next customer: service + departure HELD.
          setSeats(1)
          setClampMsg(null)
          setPriceInput(String(centsToAmount(service.base_price)))
          setPhone('')
          setIdemKey(crypto.randomUUID())
          refreshAvailability()
        },
      },
    )
  }

  const handleVoid = async () => {
    if (!lastSale || voiding) return
    setVoiding(true)
    try {
      const result = await voidExpressSale(lastSale.folio.id)
      setTally((t) => ({
        count: Math.max(0, t.count - 1),
        cents: Math.max(0, t.cents - lastSale.folio.total),
      }))
      setLastSale(null)
      setOverlayToken(null)
      setNotice(`Venta anulada · ${formatMoney(result.refund_amount)} devueltos al cliente`)
      refreshAvailability()
    } catch (err) {
      setNotice(
        err instanceof ServiceError && err.code === 'VOID_WINDOW_CLOSED'
          ? 'Ya no se puede anular esta venta.'
          : 'No se pudo anular la venta.',
      )
    } finally {
      setVoiding(false)
    }
  }

  // The Deshacer button renders only inside the (server-enforced) 60s window. Opened alongside
  // setLastSale on a successful sale; this effect only schedules the close — the server remains
  // the authority if the clocks disagree.
  const [voidWindowOpen, setVoidWindowOpen] = useState(false)
  useEffect(() => {
    if (!lastSale) return
    const t = setTimeout(
      () => setVoidWindowOpen(false),
      Math.max(0, VOID_WINDOW_MS - (Date.now() - lastSale.at)),
    )
    return () => clearTimeout(t)
  }, [lastSale])
  const inVoidWindow = !!lastSale && voidWindowOpen

  const saleSlotLine = (folio: Folio) => folio.lines[0]

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      {/* ── Fixed header: identity + session tally ── */}
      <Box sx={{ px: 3, pt: 1, pb: 2, flexShrink: 0 }}>
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
          <BoltRounded fontSize="small" color="secondary" />
          <Typography variant="h5" component="h2" sx={{ fontWeight: 600, flex: 1 }}>
            {service.name}
          </Typography>
        </Stack>
        <Typography variant="body2" color="text.secondary">
          Venta Express · solo efectivo · hoy
        </Typography>
        {tally.count > 0 && (
          <Typography variant="caption" color="text.secondary" className="numeric">
            Esta sesión · {tally.count} {tally.count === 1 ? 'venta' : 'ventas'} ·{' '}
            {formatMoney(tally.cents)}
          </Typography>
        )}
      </Box>

      {/* ── Scrollable body ── */}
      <Box sx={{ px: 3, pb: 2, overflowY: 'auto', flex: 1, minHeight: 0 }}>
        <Stack spacing={2.5}>
          {confirm.isError && <Alert severity="error">{errorMessage(confirm.error)}</Alert>}

          {/* Seats — first, with the queue-sized shortcuts (D8). */}
          <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between' }}>
            <Box>
              <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>
                Personas
              </Typography>
              {clampMsg && (
                <Typography variant="caption" color="warning.main" sx={{ fontWeight: 600 }}>
                  {clampMsg}
                </Typography>
              )}
            </Box>
            <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
              <Chip label="+5" size="small" variant="outlined" onClick={() => addSeats(5)} />
              <Chip label="+10" size="small" variant="outlined" onClick={() => addSeats(10)} />
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
                  disabled={seats <= 1}
                  sx={{ touchAction: 'none' }}
                  {...decHandlers}
                >
                  <RemoveRounded fontSize="small" />
                </IconButton>
                <Typography className="numeric" sx={{ minWidth: 28, textAlign: 'center', fontWeight: 700 }}>
                  {seats}
                </Typography>
                <IconButton
                  size="small"
                  aria-label="Más personas"
                  disabled={!slot || seats >= cap}
                  sx={{ touchAction: 'none' }}
                  {...incHandlers}
                >
                  <AddRounded fontSize="small" />
                </IconButton>
              </Stack>
            </Stack>
          </Stack>

          {/* Today's departures — ALL of them, with counts, none hidden (D6: hiding + a held
              slot would trap the agent; the alternative must stay visible). */}
          <Box>
            <Typography variant="subtitle2" sx={{ fontWeight: 600, mb: 1 }}>
              Salidas de hoy
            </Typography>
            {todaySlots.length === 0 ? (
              <Typography color="text.secondary" variant="body2">
                No hay salidas disponibles hoy.
              </Typography>
            ) : (
              <Stack direction="row" sx={{ flexWrap: 'wrap', gap: 1 }}>
                {todaySlots.map((s) => {
                  const rem = remainingOf(s)
                  const selected = s.id === slotId
                  return (
                    <ButtonBase
                      key={s.id}
                      aria-pressed={selected}
                      disabled={rem <= 0}
                      onClick={() => {
                        setSlotId(s.id)
                        setClampMsg(null)
                        if (seats > rem) setSeats(Math.max(1, rem))
                      }}
                      sx={{
                        minWidth: 96,
                        px: 1.5,
                        py: 1,
                        borderRadius: 1.5,
                        border: '1px solid',
                        flexDirection: 'column',
                        borderColor: selected ? 'secondary.main' : 'grey.300',
                        boxShadow: selected ? '0 0 0 3px rgba(15,118,110,0.15)' : 'none',
                        opacity: rem <= 0 ? 0.45 : 1,
                      }}
                    >
                      <Typography sx={{ fontWeight: 700 }}>{s.start_time}</Typography>
                      <Typography variant="caption" color={rem <= 0 ? 'text.disabled' : 'text.secondary'}>
                        {rem <= 0 ? 'Agotado' : `${rem} disponibles`}
                      </Typography>
                    </ButtonBase>
                  )
                })}
              </Stack>
            )}
          </Box>

          {/* Price — per unit, clamped to the admin's floor and base (no surge, D9/Q9). */}
          <TextField
            label="Precio unitario"
            type="number"
            size="small"
            value={priceInput}
            onChange={(e) => setPriceInput(e.target.value)}
            onBlur={commitPrice}
            error={priceInput !== '' && !priceValid}
            helperText={`Mín ${formatMoney(service.minimum_price)} · base ${formatMoney(service.base_price)}`}
            slotProps={{
              inputLabel: { shrink: true },
              input: { startAdornment: <InputAdornment position="start">$</InputAdornment> },
              htmlInput: {
                min: centsToAmount(service.minimum_price),
                max: centsToAmount(service.base_price),
                step: 0.01,
                inputMode: 'decimal',
              },
            }}
            sx={{ width: 200 }}
          />

          {/* Phone — the ONE identity field (D17/D18): the fallback-delivery handle and the
              folio's contact of record. No name in Express. */}
          <TextField
            label="Teléfono"
            placeholder="55 1234 5678"
            size="small"
            required
            type="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            error={phone.length > 0 && !phoneValid}
            helperText={
              phone.length > 0 && !phoneValid
                ? 'Ingresa un teléfono válido (10 dígitos).'
                : 'Único dato del cliente — el boleto se entrega con el QR.'
            }
            slotProps={{ inputLabel: { shrink: true } }}
          />
        </Stack>
      </Box>

      {/* ── The counter-handoff panel — docked in the LOWER HALF, non-blocking (D20 amended):
          the form above stays live so the agent starts the next sale while this customer is
          still scanning. The footer below keeps Cobrar reachable throughout. ── */}
      <ExpressTicketOverlay
        qrToken={overlayToken}
        serviceName={service.name}
        slotLabel={
          lastSale ? `Hoy · ${saleSlotLine(lastSale.folio)?.slot_start_time ?? ''}` : 'Hoy'
        }
        passes={lastSale ? (saleSlotLine(lastSale.folio)?.quantity ?? seats) : seats}
        total={lastSale?.folio.total ?? total}
        onClose={() => setOverlayToken(null)}
      />

      {/* ── Pinned footer: the confirmation strip (last sale) + Cobrar ── */}
      <Box sx={{ px: 3, py: 2, borderTop: '1px solid', borderColor: 'divider', flexShrink: 0 }}>
        {lastSale && (
          <Stack
            direction="row"
            spacing={1}
            sx={{ alignItems: 'center', mb: 1.5, flexWrap: 'wrap' }}
          >
            <Typography variant="body2" sx={{ fontWeight: 600, flex: 1, minWidth: 140 }}>
              ✓ Venta · {formatMoney(lastSale.folio.total)}
            </Typography>
            <Button
              size="small"
              startIcon={<QrCode2Rounded />}
              onClick={() => setOverlayToken(saleSlotLine(lastSale.folio)?.qr_token ?? null)}
            >
              Mostrar QR
            </Button>
            <TicketWhatsAppButton folio={lastSale.folio} variant="icon" />
            {inVoidWindow && (
              <Button
                size="small"
                color="error"
                startIcon={<UndoRounded />}
                disabled={voiding}
                onClick={handleVoid}
              >
                Deshacer
              </Button>
            )}
          </Stack>
        )}

        <Button
          fullWidth
          size="large"
          variant="contained"
          color="secondary"
          disabled={!canCobrar}
          onClick={handleCobrar}
        >
          {confirm.isPending
            ? 'Cobrando…'
            : canCobrar
              ? `Cobrar ${formatMoney(total)}`
              : !slot || cap < seats
                ? 'Sin lugares suficientes'
                : !phoneValid
                  ? 'Captura el teléfono'
                  : 'Revisa el precio'}
        </Button>
      </Box>

      <Snackbar
        open={notice !== null}
        autoHideDuration={5000}
        onClose={() => setNotice(null)}
        message={notice}
        anchorOrigin={{ vertical: 'top', horizontal: 'center' }}
      />
    </Box>
  )
}
