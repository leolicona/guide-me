import { useMemo, useState } from 'react'
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Divider,
  FormControlLabel,
  IconButton,
  InputAdornment,
  Stack,
  Switch,
  TextField,
  Typography,
} from '@mui/material'
import {
  AddRounded,
  DeleteOutlineRounded,
  EventBusyRounded,
} from '@mui/icons-material'
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
// Two things about this screen are load-bearing rather than cosmetic:
//
// 1. HOURS, never days (D16). There is no days field and no conversion. "5 días" and "120 horas"
//    are different promises at the boundary — a Friday 08:00 departure cancelled Sunday 18:00 is
//    five calendar days ahead but only 110 hours — so a days-labelled field would advertise refunds
//    the engine will not pay. The number typed here is the number stored and the number that
//    decides.
// 2. No policy is a real state, not an empty form. An org without a ladder keeps the pre-feature
//    cancellation behaviour, so this card leads with that fact instead of showing a blank editor
//    that looks broken.

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

export function CancellationPolicyCard({ policy }: Props) {
  const update = useUpdateOrganization()

  // The terminal tier (after departure) is held separately: it has no threshold to edit and it can
  // never be removed, so keeping it out of the list means neither the UI nor the validation has to
  // special-case a row in the middle of an array.
  const initial = policy ?? DEFAULT_CANCELLATION_POLICY
  const [bounded, setBounded] = useState<DraftTier[]>(() =>
    initial.tiers.filter((t) => t.min_hours !== null).map(toDraft),
  )
  const [terminal, setTerminal] = useState<DraftTier>(() =>
    toDraft(initial.tiers.find((t) => t.min_hours === null) ?? DEFAULT_CANCELLATION_POLICY.tiers[2]),
  )
  const [depositPct, setDepositPct] = useState(
    String(initial.booking_deposit_retained_pct),
  )
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
  // Strictly descending — two tiers at the same threshold are ambiguous and an ascending one can
  // never be reached, since the first match wins.
  if (
    hoursList.every(Number.isFinite) &&
    hoursList.some((h, i) => i > 0 && h >= hoursList[i - 1])
  )
    errors.push('Ordena los tramos de mayor a menor anticipación, sin repetir horas.')

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
    return {
      version: 1,
      tiers: [...bounded.map((r) => mk(r, num(r.minHours))), mk(terminal, null)],
      booking_deposit_retained_pct: num(depositPct),
    }
  }, [valid, bounded, terminal, depositPct, showAffiliate])

  const handleSave = () => {
    if (built) update.mutate({ cancellation_policy: built })
  }

  const handleDisable = () => update.mutate({ cancellation_policy: null })

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

        {!policy && (
          <Alert severity="info" sx={{ mb: 2 }}>
            Aún no tienes una política. Hoy las cancelaciones se registran sin reembolso calculado.
            Al guardar, empezará a aplicarse <strong>solo a las ventas nuevas</strong>.
          </Alert>
        )}

        <Stack spacing={2}>
          {bounded.map((row, i) => (
            <Box key={i}>
              <Stack direction="row" spacing={1} sx={{ alignItems: 'flex-start' }}>
                <TextField
                  label="Anticipación"
                  type="number"
                  size="small"
                  value={row.minHours}
                  onChange={(e) => patch(i, 'minHours', e.target.value)}
                  sx={{ flex: 1.2 }}
                  slotProps={{
                    input: {
                      endAdornment: <InputAdornment position="end">h</InputAdornment>,
                    },
                    htmlInput: { min: 0, step: 1, inputMode: 'numeric' },
                  }}
                />
                <TextField
                  label="Se devuelve"
                  type="number"
                  size="small"
                  value={row.refundPct}
                  onChange={(e) => patch(i, 'refundPct', e.target.value)}
                  sx={{ flex: 1 }}
                  slotProps={{
                    input: { endAdornment: <InputAdornment position="end">%</InputAdornment> },
                    htmlInput: { min: 0, max: 100, step: 1, inputMode: 'numeric' },
                  }}
                />
                <TextField
                  label="Comisión agente"
                  type="number"
                  size="small"
                  value={row.agentPct}
                  onChange={(e) => patch(i, 'agentPct', e.target.value)}
                  sx={{ flex: 1 }}
                  slotProps={{
                    input: { endAdornment: <InputAdornment position="end">%</InputAdornment> },
                    htmlInput: { min: 0, max: 100, step: 1, inputMode: 'numeric' },
                  }}
                />
                {showAffiliate && (
                  <TextField
                    label="Comisión afiliado"
                    type="number"
                    size="small"
                    placeholder="igual"
                    value={row.affiliatePct}
                    onChange={(e) => patch(i, 'affiliatePct', e.target.value)}
                    sx={{ flex: 1 }}
                    slotProps={{
                      input: { endAdornment: <InputAdornment position="end">%</InputAdornment> },
                      htmlInput: { min: 0, max: 100, step: 1, inputMode: 'numeric' },
                    }}
                  />
                )}
                <IconButton
                  aria-label={`Quitar el tramo de ${row.minHours || '—'} horas`}
                  onClick={() => setBounded((rows) => rows.filter((_, idx) => idx !== i))}
                  sx={{ mt: 0.5 }}
                >
                  <DeleteOutlineRounded />
                </IconButton>
              </Stack>
              <Typography variant="caption" color="text.secondary" sx={{ pl: 0.5 }}>
                {tierSentence(row)}
              </Typography>
            </Box>
          ))}

          <Button
            startIcon={<AddRounded />}
            onClick={addTier}
            sx={{ alignSelf: 'flex-start' }}
          >
            Agregar tramo
          </Button>

          <Divider />

          {/* The terminal tier always exists and cannot be removed — every cancellation after
              departure has to land somewhere. */}
          <Box>
            <Typography variant="subtitle2" sx={{ fontWeight: 600, mb: 1 }}>
              Después de la salida (no se presentó)
            </Typography>
            <Stack direction="row" spacing={1}>
              <TextField
                label="Se devuelve"
                type="number"
                size="small"
                value={terminal.refundPct}
                onChange={(e) => setTerminal({ ...terminal, refundPct: e.target.value })}
                sx={{ flex: 1 }}
                slotProps={{
                  input: { endAdornment: <InputAdornment position="end">%</InputAdornment> },
                  htmlInput: { min: 0, max: 100, step: 1, inputMode: 'numeric' },
                }}
              />
              <TextField
                label="Comisión agente"
                type="number"
                size="small"
                value={terminal.agentPct}
                onChange={(e) => setTerminal({ ...terminal, agentPct: e.target.value })}
                sx={{ flex: 1 }}
                slotProps={{
                  input: { endAdornment: <InputAdornment position="end">%</InputAdornment> },
                  htmlInput: { min: 0, max: 100, step: 1, inputMode: 'numeric' },
                }}
              />
              {showAffiliate && (
                <TextField
                  label="Comisión afiliado"
                  type="number"
                  size="small"
                  placeholder="igual"
                  value={terminal.affiliatePct}
                  onChange={(e) => setTerminal({ ...terminal, affiliatePct: e.target.value })}
                  sx={{ flex: 1 }}
                  slotProps={{
                    input: { endAdornment: <InputAdornment position="end">%</InputAdornment> },
                    htmlInput: { min: 0, max: 100, step: 1, inputMode: 'numeric' },
                  }}
                />
              )}
            </Stack>
          </Box>

          <TextField
            label="Del anticipo de un apartado se retiene"
            type="number"
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

          {/* US-A72 — hidden until asked for, so a company that treats everyone the same never has
              to think about the distinction. */}
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

          <PolicyPreview policy={built} />

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

          <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', gap: 1 }}>
            <Button
              variant="contained"
              size="large"
              disableElevation
              onClick={handleSave}
              disabled={!valid || update.isPending}
            >
              {update.isPending ? 'Guardando…' : 'Guardar política'}
            </Button>
            {policy && (
              <Button
                variant="text"
                color="error"
                size="large"
                onClick={handleDisable}
                disabled={update.isPending}
              >
                Desactivar política
              </Button>
            )}
          </Stack>
          {policy && (
            <Typography variant="caption" color="text.secondary">
              Al desactivarla, las ventas nuevas dejan de calcular reembolso. Las ya vendidas
              conservan la política con la que se vendieron.
            </Typography>
          )}
        </Stack>
      </CardContent>
    </Card>
  )
}

// A plain-language restatement under each row, so the admin reads back what they just wrote
// instead of decoding three number fields.
function tierSentence(row: DraftTier): string {
  const h = num(row.minHours)
  const r = num(row.refundPct)
  if (!Number.isFinite(h) || !Number.isFinite(r)) return ' '
  const when =
    h === 0 ? 'En cualquier momento antes de la salida' : `Cancelando con ${h} h o más de anticipación`
  const what =
    r === 100 ? 'se devuelve todo' : r === 0 ? 'no se devuelve nada' : `se devuelve el ${r}%`
  return `${when}, ${what}.`
}

// The live preview. Money is the thing the admin actually cares about, so the ladder is restated in
// pesos on a round folio rather than left as percentages to multiply mentally.
function PolicyPreview({ policy }: { policy: CancellationPolicy | null }) {
  if (!policy) return null
  return (
    <Box
      sx={{
        border: 1,
        borderColor: 'grey.200',
        borderRadius: 2,
        p: 2,
        bgcolor: 'grey.50',
      }}
    >
      <Typography variant="subtitle2" sx={{ fontWeight: 600, mb: 1 }}>
        En una venta de <MoneyText cents={PREVIEW_TOTAL} component="span" variant="subtitle2" />
      </Typography>
      <Stack spacing={0.75}>
        {policy.tiers.map((t) => {
          const refund = Math.floor((PREVIEW_TOTAL * t.refund_pct) / 100)
          return (
            <Stack
              key={String(t.min_hours)}
              direction="row"
              sx={{ justifyContent: 'space-between', alignItems: 'baseline', gap: 2 }}
            >
              <Typography variant="body2" color="text.secondary">
                {t.min_hours === null
                  ? 'Después de la salida'
                  : t.min_hours === 0
                    ? 'Antes de la salida'
                    : `${t.min_hours} h o más antes`}
              </Typography>
              <MoneyText
                cents={refund}
                variant="body2"
                semantic={refund === 0 ? 'negative' : 'neutral'}
                srLabel="Se devuelve"
              />
            </Stack>
          )
        })}
      </Stack>
    </Box>
  )
}
