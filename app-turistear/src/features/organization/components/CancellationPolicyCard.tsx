import { useMemo, useState } from 'react'
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Divider,
  FormControlLabel,
  InputAdornment,
  Stack,
  Switch,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from '@mui/material'
import { AddRounded, EventBusyRounded } from '@mui/icons-material'
import { MoneyText } from '../../../components'
import { useUpdateOrganization } from '../hooks/useUpdateOrganization'
import {
  DEFAULT_CANCELLATION_POLICY,
  type CancellationPolicy,
  type CancellationTier,
} from '../types'

// US-A69/A70/A72 — the cancellation refund ladder editor.
// Spec: docs/cancellation/cancellation-policy-engine.spec.md
//
// MOBILE-FIRST, and that is not decoration here. The first version laid each tier out as a ROW of
// three or four number fields; at 390px that clipped the labels ("Anticipaci…", two identical
// "Co…") and then the VALUES themselves — a stored 168 rendered as "1". An admin could not read
// back the policy they had configured, on the platform the product is actually used on.
//
// So a tier is a BLOCK of stacked, full-width fields. Vertical space on a phone is cheap (you
// scroll); horizontal space is not. This also makes the affiliate column (US-A72) one more stacked
// field instead of a fourth column, which is what broke worst. It follows the pattern the sibling
// settings cards already use: one field per row, help text underneath.
//
// Two other choices worth knowing:
//   * The threshold can be TYPED in hours or days (a toggle per tier), but only hours are ever
//     stored — see `ThresholdField`. D16 originally forbade a days input entirely; it now allows
//     one on the condition that the exact hours stay on screen in both modes, which is what the
//     decision was actually protecting.
//   * The money moved INTO each tier. It used to be a summary table at the bottom of the card,
//     below everything; the system's first law is that money reads first, and a refund figure
//     belongs next to the tier that produces it.

// The preview folio. A round number so the arithmetic is legible at a glance.
const PREVIEW_TOTAL = 100_000 // $1,000.00 in minor units

interface Props {
  policy: CancellationPolicy | null
}

// The unit the admin is currently TYPING in. Presentation only — `min_hours` is always stored in
// hours (D16 revised): whichever unit is selected, the value is converted to exact hours on save.
type Unit = 'hours' | 'days'

// A draft tier carries strings: a half-typed field must be allowed to be empty without the value
// collapsing to 0 under the user's cursor.
interface DraftTier {
  /** The number as typed, in `unit`. Not necessarily hours — use `hoursOf`. */
  amount: string
  unit: Unit
  refundPct: string
  agentPct: string
  affiliatePct: string
}

const TERMINAL_FALLBACK: DraftTier = {
  amount: '',
  unit: 'hours',
  refundPct: '0',
  agentPct: '100',
  affiliatePct: '',
}

// A stored 168 opens as "7 días", a stored 6 as "6 horas". Whole days are how people say these
// windows out loud, so that is what we show first — but only when the number really is whole days,
// never by rounding something that is not.
const naturalUnit = (hours: number): Unit =>
  hours >= 24 && hours % 24 === 0 ? 'days' : 'hours'

const toDraft = (t: CancellationTier): DraftTier => {
  const unit = t.min_hours === null ? 'hours' : naturalUnit(t.min_hours)
  return {
    amount:
      t.min_hours === null ? '' : String(unit === 'days' ? t.min_hours / 24 : t.min_hours),
    unit,
    refundPct: String(t.refund_pct),
    agentPct: String(t.agent_commission_pct),
    affiliatePct:
      t.affiliate_commission_pct === undefined ? '' : String(t.affiliate_commission_pct),
  }
}

const num = (s: string) => (s.trim() === '' ? NaN : Number(s))
const pctValid = (s: string) => {
  const n = num(s)
  return Number.isInteger(n) && n >= 0 && n <= 100
}

// Drops IEEE-754 dust for display: 1.3 × 24 is 31.200000000000003, and nobody should have to read
// that to learn their tier is invalid.
const trimNum = (n: number): string => String(Number(n.toFixed(2)))

// THE canonical reading of a draft tier's threshold. Everything — validation, the saved document,
// the preview — goes through this, so there is exactly one place where a unit becomes hours.
const hoursOf = (row: Pick<DraftTier, 'amount' | 'unit'>): number => {
  const n = num(row.amount)
  if (!Number.isFinite(n)) return NaN
  const raw = row.unit === 'days' ? n * 24 : n
  // Snap to the nearest whole hour when we are within floating-point noise of it. `1.5 × 24` is
  // exactly 36 here, but not every decimal multiplies cleanly in binary — and a whole-hour entry
  // must not be rejected by an artefact of how it was computed. A genuinely fractional result
  // (1.3 días → 31.2 h) stays fractional and is still rejected.
  const whole = Math.round(raw)
  return Math.abs(raw - whole) < 1e-9 ? whole : raw
}

// The read-back under the field. It ALWAYS states the exact hours, in both unit modes.
//
// That is the point, not a nicety. The engine matches a tier at exactly `min_hours` before the
// departure INSTANT — so "5 días" in this field means 120 hours, not "any time on the day five days
// before". Letting an admin type days without showing the hours is what would re-open the gap D16
// was written to close (see the spec: a Friday 08:00 departure cancelled Sunday 18:00 is five
// calendar days ahead but only 110 hours). Typing days is fine; being unable to see the hours is not.
const thresholdHint = (hours: number, unit: Unit): string => {
  if (!Number.isFinite(hours)) return ' '
  if (hours === 0) return 'Hasta el momento mismo de la salida.'
  const h = `${trimNum(hours)} h exactas antes de la salida`
  // In days mode the typed number already says the days, so only the hours are added. In hours mode
  // the days go in parentheses — the direction the admin cannot compute at a glance.
  if (unit === 'days' || hours < 24) return `= ${h}.`
  const days = hours / 24
  const label = Number.isInteger(days)
    ? `${days} día${days === 1 ? '' : 's'}`
    : `${trimNum(days)} días`
  return `= ${h} (${label}).`
}

export function CancellationPolicyCard({ policy }: Props) {
  const update = useUpdateOrganization()

  // The terminal tier (after departure) is held separately: it has no threshold to edit and it can
  // never be removed, so keeping it out of the list means neither the UI nor the validation has to
  // special-case a row in the middle of an array.
  const initial = policy ?? DEFAULT_CANCELLATION_POLICY
  const [bounded, setBounded] = useState<DraftTier[]>(() =>
    initial.tiers.filter((t) => t.min_hours !== null).map(toDraft),
  )
  const [terminal, setTerminal] = useState<DraftTier>(() => {
    const t = initial.tiers.find((x) => x.min_hours === null)
    return t ? toDraft(t) : TERMINAL_FALLBACK
  })
  const [depositPct, setDepositPct] = useState(String(initial.booking_deposit_retained_pct))
  const [showAffiliate, setShowAffiliate] = useState(() =>
    initial.tiers.some((t) => t.affiliate_commission_pct !== undefined),
  )

  const patch = (i: number, field: keyof DraftTier, value: string) =>
    setBounded((rows) => rows.map((r, idx) => (idx === i ? { ...r, [field]: value } : r)))

  const addTier = () =>
    setBounded((rows) => [
      ...rows,
      { amount: '', unit: 'days', refundPct: '', agentPct: '100', affiliatePct: '' },
    ])

  // Switch the unit WITHOUT changing what the tier means: the number is rewritten so the resulting
  // hours are identical. Toggling back and forth is a no-op, which is what makes the control safe to
  // poke at — an admin exploring "what is this in days?" cannot silently rewrite their policy.
  const setUnit = (i: number, unit: Unit) =>
    setBounded((rows) =>
      rows.map((r, idx) => {
        if (idx !== i || r.unit === unit) return r
        const hours = hoursOf(r)
        if (!Number.isFinite(hours)) return { ...r, unit }
        const next = unit === 'days' ? hours / 24 : hours
        return { ...r, unit, amount: String(Number(next.toFixed(4))) }
      }),
    )

  // --- validation, mirroring the server's schema so a save is never rejected for shape ---

  const hoursList = bounded.map(hoursOf)
  const errors: string[] = []
  // The server takes whole hours, so days that do not land on one are rejected here rather than
  // silently rounded — 1.3 días is 31.2 h, and quietly storing 31 would change the policy by a
  // margin the admin never saw.
  if (hoursList.some((h) => !Number.isInteger(h) || h < 0))
    errors.push(
      'Cada tramo debe resultar en un número entero de horas (0 o más). En días, usa medios días como máximo (0.5 = 12 h).',
    )
  if (bounded.some((r) => !pctValid(r.refundPct) || !pctValid(r.agentPct)))
    errors.push('Los porcentajes van de 0 a 100.')
  if (showAffiliate && bounded.some((r) => r.affiliatePct !== '' && !pctValid(r.affiliatePct)))
    errors.push('El porcentaje de afiliado va de 0 a 100.')
  if (!pctValid(terminal.refundPct) || !pctValid(terminal.agentPct))
    errors.push('Revisa los porcentajes del tramo posterior a la salida.')
  if (!pctValid(depositPct)) errors.push('La retención del anticipo va de 0 a 100.')
  // Duplicates are still an error — two tiers at the same threshold is genuinely ambiguous and the
  // machine cannot pick for you. ORDER is not: the server wants them descending, and sorting a list
  // is work software should do rather than send an admin back to retype four fields on a phone.
  const dupeHours =
    hoursList.every(Number.isFinite) && new Set(hoursList).size !== hoursList.length
  if (dupeHours) errors.push('Dos tramos no pueden tener la misma anticipación.')

  const valid = errors.length === 0

  const built: CancellationPolicy | null = useMemo(() => {
    if (!valid) return null
    const mk = (r: DraftTier, minHours: number | null): CancellationTier => ({
      min_hours: minHours,
      refund_pct: num(r.refundPct),
      agent_commission_pct: num(r.agentPct),
      ...(showAffiliate && r.affiliatePct !== ''
        ? { affiliate_commission_pct: num(r.affiliatePct) }
        : {}),
    })
    // Sorted here, once, on the way out — the admin types in whatever order they think of.
    const sorted = [...bounded].sort((a, b) => hoursOf(b) - hoursOf(a))
    return {
      version: 1,
      // Whatever unit was typed, hours are what leaves this component (D16 revised).
      tiers: [...sorted.map((r) => mk(r, hoursOf(r))), mk(terminal, null)],
      booking_deposit_retained_pct: num(depositPct),
    }
  }, [valid, bounded, terminal, depositPct, showAffiliate])

  const handleSave = () => {
    if (built) update.mutate({ cancellation_policy: built })
  }

  // NOT "disable" — there is no such state any more (engine D17). Clearing the field only makes the
  // server fall back to the same 100% default, so the old button's promise ("las ventas nuevas
  // dejan de calcular reembolso") was the OPPOSITE of what happened: an admin trying to switch
  // refunds off would have switched them to refunding everything. This writes the default
  // explicitly instead, so the stored policy always says what is actually applied.
  const handleReset = () => update.mutate({ cancellation_policy: DEFAULT_CANCELLATION_POLICY })

  const pctField = (
    label: string,
    value: string,
    onChange: (v: string) => void,
    placeholder?: string,
  ) => (
    <TextField
      label={label}
      type="number"
      size="small"
      fullWidth
      placeholder={placeholder}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      slotProps={{
        // Pinned above the border. These labels are long and the fields carry a `%` adornment, so
        // an unshrunk label sits INSIDE the field and collides with it — "…conserva el afiliad◯%".
        // The affiliate field is the one that can legitimately be empty, which is exactly when MUI
        // would leave the label inline. Pinning also lets its placeholder actually show.
        inputLabel: { shrink: true },
        input: { endAdornment: <InputAdornment position="end">%</InputAdornment> },
        htmlInput: { min: 0, max: 100, step: 1, inputMode: 'numeric' },
      }}
    />
  )

  return (
    <Card sx={{ mt: 3 }}>
      <CardContent>
        <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center', mb: 1 }}>
          <EventBusyRounded color="primary" />
          <Typography variant="h6">Política de cancelación</Typography>
        </Stack>

        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Cuánto se le devuelve al cliente según la anticipación con que cancele. Se aplica a cada
          servicio del folio por separado, y queda congelada en cada venta: cambiarla aquí nunca
          modifica lo que ya se vendió.
        </Typography>

        <Stack spacing={2}>
          {bounded.map((row, i) => (
            <TierBlock
              key={i}
              title={`Tramo ${i + 1}`}
              onRemove={() => setBounded((rows) => rows.filter((_, idx) => idx !== i))}
              removeLabel={`Quitar el tramo de ${row.amount || '—'} ${
                row.unit === 'days' ? 'días' : 'horas'
              }`}
              refundPct={num(row.refundPct)}
            >
              <ThresholdField
                row={row}
                onAmount={(v) => patch(i, 'amount', v)}
                onUnit={(u) => setUnit(i, u)}
              />
              {pctField('Se devuelve al cliente', row.refundPct, (v) => patch(i, 'refundPct', v))}
              {pctField('Comisión que conserva el agente', row.agentPct, (v) =>
                patch(i, 'agentPct', v),
              )}
              {showAffiliate &&
                pctField(
                  'Comisión que conserva el afiliado',
                  row.affiliatePct,
                  (v) => patch(i, 'affiliatePct', v),
                  'igual que el agente',
                )}
            </TierBlock>
          ))}

          <Button startIcon={<AddRounded />} onClick={addTier} sx={{ alignSelf: 'flex-start' }}>
            Agregar tramo
          </Button>

          {/* The terminal tier always exists and cannot be removed — every cancellation after
              departure has to land somewhere. Same block shape as the others so the eye reads them
              as one list, minus the threshold it does not have. */}
          <TierBlock
            title="Después de la salida"
            subtitle="Cuando el cliente no se presentó."
            refundPct={num(terminal.refundPct)}
          >
            {pctField('Se devuelve al cliente', terminal.refundPct, (v) =>
              setTerminal({ ...terminal, refundPct: v }),
            )}
            {pctField('Comisión que conserva el agente', terminal.agentPct, (v) =>
              setTerminal({ ...terminal, agentPct: v }),
            )}
            {showAffiliate &&
              pctField(
                'Comisión que conserva el afiliado',
                terminal.affiliatePct,
                (v) => setTerminal({ ...terminal, affiliatePct: v }),
                'igual que el agente',
              )}
          </TierBlock>

          <Divider />

          <TextField
            label="Del anticipo de un apartado se retiene"
            type="number"
            fullWidth
            value={depositPct}
            onChange={(e) => setDepositPct(e.target.value)}
            helperText={
              num(depositPct) === 100
                ? 'El anticipo de un apartado no se devuelve, sin importar el tramo.'
                : 'Tope adicional: el reembolso de un apartado nunca supera este límite.'
            }
            slotProps={{
              input: { endAdornment: <InputAdornment position="end">%</InputAdornment> },
              htmlInput: { min: 0, max: 100, step: 1, inputMode: 'numeric' },
            }}
          />

          {/* US-A72 — hidden until asked for, so a company that treats resellers and staff the same
              never has to think about the distinction. */}
          <FormControlLabel
            control={
              <Switch
                checked={showAffiliate}
                onChange={(e) => setShowAffiliate(e.target.checked)}
              />
            }
            label={
              <Typography variant="body2">¿Los afiliados tienen otra regla de comisión?</Typography>
            }
          />

          {errors.length > 0 && (
            <Alert severity="warning">
              <Stack component="ul" sx={{ m: 0, pl: 2 }}>
                {errors.map((e) => (
                  <li key={e}>
                    <Typography variant="body2">{e}</Typography>
                  </li>
                ))}
              </Stack>
            </Alert>
          )}

          {update.isError && (
            <Alert severity="error">
              No se pudo guardar la política. Revisa los valores e inténtalo de nuevo.
            </Alert>
          )}

          <Button
            variant="contained"
            size="large"
            fullWidth
            disableElevation
            onClick={handleSave}
            disabled={!valid || update.isPending}
          >
            {update.isPending ? 'Guardando…' : 'Guardar política'}
          </Button>

          {/* Separated from the primary action by a divider, not just stacked under it — on a phone
              a thumb that overshoots "Guardar" should not land on something that rewrites the
              policy. */}
          <Divider />
          <Box>
            <Button
              variant="text"
              size="large"
              onClick={handleReset}
              disabled={update.isPending}
              sx={{ px: 0 }}
            >
              Restablecer al 100%
            </Button>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
              Vuelve a la política que traen todas las empresas: se devuelve todo, sin importar la
              anticipación. Las ventas ya hechas conservan la política con la que se vendieron.
            </Typography>
          </Box>
        </Stack>
      </CardContent>
    </Card>
  )
}

// The tier threshold: a number plus the unit it is being typed in.
//
// Storage is ALWAYS hours (D16 revised) — the toggle changes what the admin types, never what the
// engine receives. Two properties make that safe rather than merely convenient:
//   * toggling is value-preserving, so poking the control cannot rewrite a policy;
//   * the exact hours are printed underneath in BOTH modes, so the number the engine will match on
//     is never hidden behind a friendlier unit.
//
// The number + unit-selector shape follows the "Cierre de ventas" field in this same settings page
// (a magnitude plus an Antes/Después select), so it is not a new idiom to learn.
function ThresholdField({
  row,
  onAmount,
  onUnit,
}: {
  row: DraftTier
  onAmount: (v: string) => void
  onUnit: (u: Unit) => void
}) {
  const hours = hoursOf(row)
  return (
    <Box>
      <Stack direction="row" spacing={1} sx={{ alignItems: 'flex-start' }}>
        <TextField
          label="Anticipación mínima"
          type="number"
          size="small"
          value={row.amount}
          onChange={(e) => onAmount(e.target.value)}
          sx={{ flex: 1, minWidth: 0 }}
          slotProps={{
            inputLabel: { shrink: true },
            // Days may legitimately be fractional (0.5 = 12 h); hours never are.
            htmlInput:
              row.unit === 'days'
                ? { min: 0, step: 0.5, inputMode: 'decimal' }
                : { min: 0, step: 1, inputMode: 'numeric' },
          }}
        />
        <ToggleButtonGroup
          exclusive
          size="small"
          value={row.unit}
          onChange={(_, next: Unit | null) => next && onUnit(next)}
          aria-label="Unidad de la anticipación"
          sx={{ flexShrink: 0, '& .MuiToggleButton-root': { px: 1.5, height: 40 } }}
        >
          <ToggleButton value="hours">horas</ToggleButton>
          <ToggleButton value="days">días</ToggleButton>
        </ToggleButtonGroup>
      </Stack>
      <Typography
        variant="caption"
        color="text.secondary"
        sx={{ display: 'block', mt: 0.5, ml: 1.75 }}
      >
        {thresholdHint(hours, row.unit)}
      </Typography>
    </Box>
  )
}

// One tier: a hairline-bordered block of stacked fields, closed by what it means in pesos.
//
// The money line is the point of the block. Percentages are how the policy is stored; pesos are how
// an admin decides whether it is the policy they meant.
function TierBlock({
  title,
  subtitle,
  onRemove,
  removeLabel,
  refundPct,
  children,
}: {
  title: string
  subtitle?: string
  onRemove?: () => void
  removeLabel?: string
  refundPct: number
  children: React.ReactNode
}) {
  const refund = Number.isFinite(refundPct)
    ? Math.floor((PREVIEW_TOTAL * refundPct) / 100)
    : null

  return (
    <Box sx={{ border: 1, borderColor: 'grey.200', borderRadius: 2, p: 2 }}>
      <Stack
        direction="row"
        sx={{ justifyContent: 'space-between', alignItems: 'center', mb: subtitle ? 0 : 1.5 }}
      >
        <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>
          {title}
        </Typography>
        {onRemove && (
          <Button size="small" color="inherit" onClick={onRemove} aria-label={removeLabel}>
            Quitar
          </Button>
        )}
      </Stack>
      {subtitle && (
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1.5 }}>
          {subtitle}
        </Typography>
      )}

      <Stack spacing={2}>{children}</Stack>

      {refund !== null && (
        <>
          <Divider sx={{ my: 1.5 }} />
          <Stack
            direction="row"
            sx={{ justifyContent: 'space-between', alignItems: 'baseline', gap: 1 }}
          >
            <Typography variant="caption" color="text.secondary">
              De una venta de $1,000 se devuelven
            </Typography>
            <MoneyText
              cents={refund}
              variant="subtitle1"
              semantic={refund === 0 ? 'negative' : 'neutral'}
              srLabel="Se devuelve al cliente"
            />
          </Stack>
        </>
      )}
    </Box>
  )
}
