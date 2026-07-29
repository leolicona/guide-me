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
//   * HOURS stay the only input (D16) — but each tier translates itself into days as OUTPUT, the
//     way the booking-buffer field does ("Ej.: 24 = a más tardar un día antes"). The admin never
//     types days, so the two units can never disagree, and nobody has to divide by 24 in their head.
//   * The money moved INTO each tier. It used to be a summary table at the bottom of the card,
//     below everything; the system's first law is that money reads first, and a refund figure
//     belongs next to the tier that produces it.

// The preview folio. A round number so the arithmetic is legible at a glance.
const PREVIEW_TOTAL = 100_000 // $1,000.00 in minor units

interface Props {
  policy: CancellationPolicy | null
}

// A draft tier carries strings: a half-typed field must be allowed to be empty without the value
// collapsing to 0 under the user's cursor.
interface DraftTier {
  minHours: string
  refundPct: string
  agentPct: string
  affiliatePct: string
}

const TERMINAL_FALLBACK: DraftTier = {
  minHours: '',
  refundPct: '0',
  agentPct: '100',
  affiliatePct: '',
}

const toDraft = (t: CancellationTier): DraftTier => ({
  minHours: t.min_hours === null ? '' : String(t.min_hours),
  refundPct: String(t.refund_pct),
  agentPct: String(t.agent_commission_pct),
  affiliatePct:
    t.affiliate_commission_pct === undefined ? '' : String(t.affiliate_commission_pct),
})

const num = (s: string) => (s.trim() === '' ? NaN : Number(s))
const pctValid = (s: string) => {
  const n = num(s)
  return Number.isInteger(n) && n >= 0 && n <= 100
}

// Hours → days, as a read-back. Only ever shown, never typed (D16): "5 días" and "120 horas" are
// different promises at the tier boundary, so days must not become an input — but making the admin
// divide by 24 in their head is a separate problem, and this is what solves it.
const daysHint = (hours: number): string | null => {
  if (!Number.isFinite(hours)) return null
  if (hours === 0) return 'Hasta el momento de la salida.'
  if (hours < 24) return null // already the natural unit at this range
  const days = hours / 24
  const label = Number.isInteger(days)
    ? `${days} día${days === 1 ? '' : 's'}`
    : `${days.toFixed(1).replace('.0', '')} días`
  return `= ${label} antes de la salida.`
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
      { minHours: '', refundPct: '', agentPct: '100', affiliatePct: '' },
    ])

  // --- validation, mirroring the server's schema so a save is never rejected for shape ---

  const hoursList = bounded.map((r) => num(r.minHours))
  const errors: string[] = []
  if (bounded.some((r) => !Number.isInteger(num(r.minHours)) || num(r.minHours) < 0))
    errors.push('Cada tramo necesita un número entero de horas (0 o más).')
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
    const sorted = [...bounded].sort((a, b) => num(b.minHours) - num(a.minHours))
    return {
      version: 1,
      tiers: [...sorted.map((r) => mk(r, num(r.minHours))), mk(terminal, null)],
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
              removeLabel={`Quitar el tramo de ${row.minHours || '—'} horas`}
              refundPct={num(row.refundPct)}
            >
              <TextField
                label="Anticipación mínima"
                type="number"
                size="small"
                fullWidth
                value={row.minHours}
                onChange={(e) => patch(i, 'minHours', e.target.value)}
                helperText={daysHint(num(row.minHours)) ?? ' '}
                slotProps={{
                  inputLabel: { shrink: true },
                  input: { endAdornment: <InputAdornment position="end">horas</InputAdornment> },
                  htmlInput: { min: 0, step: 1, inputMode: 'numeric' },
                }}
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
