import { useState } from 'react'
import {
  Box,
  Typography,
  Card,
  CardContent,
  Stack,
  TextField,
  MenuItem,
  InputAdornment,
  Button,
  Alert,
  Snackbar,
  CircularProgress,
  Fade,
  Divider,
  FormControlLabel,
  Switch,
  ToggleButton,
  ToggleButtonGroup,
} from '@mui/material'
import SavingsRounded from '@mui/icons-material/SavingsRounded'
import StorefrontRounded from '@mui/icons-material/StorefrontRounded'
import HotelRounded from '@mui/icons-material/HotelRounded'
import { useMyOrganization, useUpdateOrganization } from '../features/organization'
import { usePosPreferences } from '../store/posPreferences'

// US-A47 — the backend stores a SIGNED departure offset (+ = before, − = after). The admin never
// types a negative: they enter a positive magnitude and pick a direction; the page translates.
type OffsetDir = 'before' | 'after'
const splitOffset = (v: number): { mag: number; dir: OffsetDir } =>
  v >= 0 ? { mag: v, dir: 'before' } : { mag: -v, dir: 'after' }
const joinOffset = (mag: number, dir: OffsetDir): number => (dir === 'after' ? -mag : mag)
const OFFSET_MAX = 240

// US-A60 — weekend-rate days. Values are JS weekday ints (0=Sun…6=Sat, matching the engine's
// weekdayOf); displayed Mon→Sun for familiarity. Default org weekend is Fri+Sat ([5,6]).
const WEEKDAY_OPTIONS: { value: number; label: string }[] = [
  { value: 1, label: 'L' },
  { value: 2, label: 'M' },
  { value: 3, label: 'X' },
  { value: 4, label: 'J' },
  { value: 5, label: 'V' },
  { value: 6, label: 'S' },
  { value: 0, label: 'D' },
]

// A positive-magnitude minutes input + a Before/After "de la salida" selector (US-A47).
function OffsetField({
  label,
  helper,
  mag,
  setMag,
  dir,
  setDir,
  invalid,
}: {
  label: string
  helper: string
  mag: string
  setMag: (v: string) => void
  dir: OffsetDir
  setDir: (v: OffsetDir) => void
  invalid: boolean
}) {
  return (
    <Box>
      <Typography variant="subtitle2" sx={{ fontWeight: 600, mb: 1 }}>
        {label}
      </Typography>
      <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
        <TextField
          type="number"
          size="small"
          value={mag}
          onChange={(e) => setMag(e.target.value)}
          error={mag !== '' && invalid}
          slotProps={{
            input: { endAdornment: <InputAdornment position="end">min</InputAdornment> },
            htmlInput: { min: 0, max: OFFSET_MAX, step: 5, inputMode: 'numeric' },
          }}
          sx={{ width: 130 }}
        />
        <TextField
          select
          size="small"
          value={dir}
          onChange={(e) => setDir(e.target.value as OffsetDir)}
          sx={{ width: 140 }}
        >
          <MenuItem value="before">Antes</MenuItem>
          <MenuItem value="after">Después</MenuItem>
        </TextField>
        <Typography color="text.secondary">de la salida</Typography>
      </Stack>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.75 }}>
        {mag !== '' && invalid ? `Captura entre 0 y ${OFFSET_MAX} minutos.` : helper}
      </Typography>
    </Box>
  )
}

// US-A46/A47 — admin configures the org sales + booking policy. Setting the minimum down-payment %
// above 0 surfaces the "Apartar" deposit chip in the adaptive checkout (US-AG07.2).
export default function SettingsPage() {
  const { data: org, isLoading, isError } = useMyOrganization()
  const update = useUpdateOrganization()
  const hideSoldOut = usePosPreferences((s) => s.hideSoldOut)
  const setHideSoldOut = usePosPreferences((s) => s.setHideSoldOut)

  const [minPct, setMinPct] = useState('')
  const [holdDays, setHoldDays] = useState('')
  const [cutoffMag, setCutoffMag] = useState('')
  const [cutoffDir, setCutoffDir] = useState<OffsetDir>('before')
  const [graceMag, setGraceMag] = useState('')
  const [graceDir, setGraceDir] = useState<OffsetDir>('before')
  const [saved, setSaved] = useState(false)

  // US-A60/A63 — lodging org policy: weekend days, free-cancel window, penalty %.
  const [weekendDays, setWeekendDays] = useState<number[]>([])
  const [freeCancelDays, setFreeCancelDays] = useState('')
  const [penaltyPct, setPenaltyPct] = useState('')

  // Seed the form from the org's saved values (render-phase, no effect). Re-seeds whenever the
  // saved values change — i.e. on first load and after a successful save — resetting the dirty flag.
  const savedSig = org
    ? `${org.booking_min_down_payment_pct}|${org.booking_hold_days}|${org.sales_cutoff_offset_minutes}|${org.booking_grace_offset_minutes}|${org.lodging_weekend_days.join(',')}|${org.lodging_free_cancel_days}|${org.lodging_cancel_penalty_pct}`
    : null
  const [seededSig, setSeededSig] = useState<string | null>(null)
  if (org && savedSig !== seededSig) {
    setSeededSig(savedSig)
    setMinPct(String(org.booking_min_down_payment_pct))
    setHoldDays(String(org.booking_hold_days))
    const c = splitOffset(org.sales_cutoff_offset_minutes)
    setCutoffMag(String(c.mag))
    setCutoffDir(c.dir)
    const g = splitOffset(org.booking_grace_offset_minutes)
    setGraceMag(String(g.mag))
    setGraceDir(g.dir)
    setWeekendDays(org.lodging_weekend_days)
    setFreeCancelDays(String(org.lodging_free_cancel_days))
    setPenaltyPct(String(org.lodging_cancel_penalty_pct))
  }

  const pctNum = Number(minPct)
  const holdNum = Number(holdDays)
  const cutoffMagNum = Number(cutoffMag)
  const graceMagNum = Number(graceMag)

  const pctInvalid = minPct === '' || !Number.isInteger(pctNum) || pctNum < 0 || pctNum > 100
  const holdInvalid = holdDays === '' || !Number.isInteger(holdNum) || holdNum < 1
  const magInvalid = (m: string, n: number) =>
    m === '' || !Number.isInteger(n) || n < 0 || n > OFFSET_MAX
  const cutoffInvalid = magInvalid(cutoffMag, cutoffMagNum)
  const graceInvalid = magInvalid(graceMag, graceMagNum)
  const invalid = pctInvalid || holdInvalid || cutoffInvalid || graceInvalid

  const cutoffSigned = joinOffset(cutoffMagNum, cutoffDir)
  const graceSigned = joinOffset(graceMagNum, graceDir)

  const dirty =
    !!org &&
    (pctNum !== org.booking_min_down_payment_pct ||
      holdNum !== org.booking_hold_days ||
      cutoffSigned !== org.sales_cutoff_offset_minutes ||
      graceSigned !== org.booking_grace_offset_minutes)

  const handleSave = () => {
    update.mutate(
      {
        booking_min_down_payment_pct: pctNum,
        booking_hold_days: holdNum,
        sales_cutoff_offset_minutes: cutoffSigned,
        booking_grace_offset_minutes: graceSigned,
      },
      { onSuccess: () => setSaved(true) },
    )
  }

  // --- Lodging (Hospedaje) settings ---
  const freeCancelNum = Number(freeCancelDays)
  const penaltyNum = Number(penaltyPct)
  const freeCancelInvalid =
    freeCancelDays === '' || !Number.isInteger(freeCancelNum) || freeCancelNum < 0
  const penaltyInvalid =
    penaltyPct === '' || !Number.isInteger(penaltyNum) || penaltyNum < 0 || penaltyNum > 100
  const lodgingInvalid = freeCancelInvalid || penaltyInvalid || weekendDays.length === 0
  const lodgingDirty =
    !!org &&
    ([...weekendDays].sort().join(',') !== [...org.lodging_weekend_days].sort().join(',') ||
      freeCancelNum !== org.lodging_free_cancel_days ||
      penaltyNum !== org.lodging_cancel_penalty_pct)

  const handleSaveLodging = () => {
    update.mutate(
      {
        lodging_weekend_days: weekendDays,
        lodging_free_cancel_days: freeCancelNum,
        lodging_cancel_penalty_pct: penaltyNum,
      },
      { onSuccess: () => setSaved(true) },
    )
  }

  return (
    <Fade in timeout={400}>
      <Box sx={{ maxWidth: 560, mx: 'auto' }}>
        <Typography variant="h4" component="h1" sx={{ mb: 1 }}>
          Configuración
        </Typography>
        <Typography color="text.secondary" sx={{ mb: 3 }}>
          Política de ventas, apartados y preferencias del punto de venta.
        </Typography>

        {isLoading && (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
            <CircularProgress />
          </Box>
        )}

        {isError && (
          <Alert severity="error">No se pudo cargar la configuración. Inténtalo de nuevo.</Alert>
        )}

        {org && (
          <Card>
            <CardContent>
              <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center', mb: 2 }}>
                <SavingsRounded color="primary" />
                <Typography variant="h6">Ventas y apartados</Typography>
              </Stack>

              <Stack spacing={3}>
                <TextField
                  label="Anticipo mínimo"
                  type="number"
                  value={minPct}
                  onChange={(e) => setMinPct(e.target.value)}
                  error={minPct !== '' && pctInvalid}
                  helperText={
                    minPct !== '' && pctInvalid
                      ? 'Captura un porcentaje entre 0 y 100.'
                      : pctNum === 0
                        ? 'En 0% no se muestra la opción de apartar en el cobro. Súbelo para habilitarla.'
                        : 'Porcentaje mínimo del total que el cliente debe pagar para apartar.'
                  }
                  slotProps={{
                    input: {
                      endAdornment: <InputAdornment position="end">%</InputAdornment>,
                    },
                    htmlInput: { min: 0, max: 100, step: 1, inputMode: 'numeric' },
                  }}
                />

                <TextField
                  label="Vigencia del apartado"
                  type="number"
                  value={holdDays}
                  onChange={(e) => setHoldDays(e.target.value)}
                  error={holdDays !== '' && holdInvalid}
                  helperText={
                    holdDays !== '' && holdInvalid
                      ? 'Captura al menos 1 día.'
                      : 'Días que se mantienen apartados los lugares antes de liberarse.'
                  }
                  slotProps={{
                    input: {
                      endAdornment: <InputAdornment position="end">días</InputAdornment>,
                    },
                    htmlInput: { min: 1, step: 1, inputMode: 'numeric' },
                  }}
                />

                <Divider flexItem />

                {/* US-A47 — sales cutoff: closes NEW walk-in sales for a departing slot. */}
                <OffsetField
                  label="Cierre de ventas"
                  helper="Deja de vender un horario a partir de este margen. «Después» permite ventas de último minuto tras la salida."
                  mag={cutoffMag}
                  setMag={setCutoffMag}
                  dir={cutoffDir}
                  setDir={setCutoffDir}
                  invalid={cutoffInvalid}
                />

                {/* US-A47 — booking grace: when an unsettled same-day apartado auto-cancels. */}
                <OffsetField
                  label="Liberación de apartado (mismo día)"
                  helper="Un apartado del mismo día sin liquidar se cancela en este momento. «Después» da un margen de cortesía tras la salida."
                  mag={graceMag}
                  setMag={setGraceMag}
                  dir={graceDir}
                  setDir={setGraceDir}
                  invalid={graceInvalid}
                />

                {update.isError && (
                  <Alert severity="error">
                    No se pudo guardar la configuración. Inténtalo de nuevo.
                  </Alert>
                )}

                <Button
                  variant="contained"
                  size="large"
                  disableElevation
                  onClick={handleSave}
                  disabled={invalid || !dirty || update.isPending}
                >
                  {update.isPending ? 'Guardando…' : 'Guardar cambios'}
                </Button>
              </Stack>
            </CardContent>
          </Card>
        )}

        {org && (
          <Card sx={{ mt: 3 }}>
            <CardContent>
              <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center', mb: 2 }}>
                <HotelRounded color="primary" />
                <Typography variant="h6">Hospedaje</Typography>
              </Stack>

              <Stack spacing={3}>
                <Box>
                  <Typography variant="subtitle2" sx={{ fontWeight: 600, mb: 1 }}>
                    Días de fin de semana
                  </Typography>
                  <ToggleButtonGroup
                    value={weekendDays}
                    onChange={(_, next: number[]) => setWeekendDays(next)}
                    size="small"
                    aria-label="Días de fin de semana"
                  >
                    {WEEKDAY_OPTIONS.map((d) => (
                      <ToggleButton key={d.value} value={d.value} sx={{ width: 44 }}>
                        {d.label}
                      </ToggleButton>
                    ))}
                  </ToggleButtonGroup>
                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.75 }}>
                    {weekendDays.length === 0
                      ? 'Selecciona al menos un día.'
                      : 'Estos días usan la tarifa de fin de semana de cada unidad.'}
                  </Typography>
                </Box>

                <TextField
                  label="Cancelación gratuita"
                  type="number"
                  value={freeCancelDays}
                  onChange={(e) => setFreeCancelDays(e.target.value)}
                  error={freeCancelDays !== '' && freeCancelInvalid}
                  helperText={
                    freeCancelDays !== '' && freeCancelInvalid
                      ? 'Captura un número de días válido (0 o más).'
                      : 'Días antes del check-in en que la cancelación de una estancia pagada se reembolsa al 100%.'
                  }
                  slotProps={{
                    input: { endAdornment: <InputAdornment position="end">días</InputAdornment> },
                    htmlInput: { min: 0, step: 1, inputMode: 'numeric' },
                  }}
                />

                <TextField
                  label="Penalización"
                  type="number"
                  value={penaltyPct}
                  onChange={(e) => setPenaltyPct(e.target.value)}
                  error={penaltyPct !== '' && penaltyInvalid}
                  helperText={
                    penaltyPct !== '' && penaltyInvalid
                      ? 'Captura un porcentaje entre 0 y 100.'
                      : 'Porcentaje del total que se retiene si la cancelación cae dentro de la ventana.'
                  }
                  slotProps={{
                    input: { endAdornment: <InputAdornment position="end">%</InputAdornment> },
                    htmlInput: { min: 0, max: 100, step: 1, inputMode: 'numeric' },
                  }}
                />

                <Button
                  variant="contained"
                  size="large"
                  disableElevation
                  onClick={handleSaveLodging}
                  disabled={lodgingInvalid || !lodgingDirty || update.isPending}
                >
                  {update.isPending ? 'Guardando…' : 'Guardar cambios'}
                </Button>
              </Stack>
            </CardContent>
          </Card>
        )}

        <Card sx={{ mt: 3 }}>
          <CardContent>
            <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center', mb: 2 }}>
              <StorefrontRounded color="primary" />
              <Typography variant="h6">Punto de venta</Typography>
            </Stack>

            <FormControlLabel
              control={
                <Switch
                  checked={hideSoldOut}
                  onChange={(e) => setHideSoldOut(e.target.checked)}
                />
              }
              label={
                <Box>
                  <Typography variant="body1" sx={{ fontWeight: 500 }}>
                    Ocultar agotados
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    El catálogo de venta solo muestra servicios con disponibilidad.
                  </Typography>
                </Box>
              }
              sx={{ alignItems: 'flex-start', mx: 0 }}
            />
          </CardContent>
        </Card>

        <Snackbar
          open={saved}
          autoHideDuration={2500}
          onClose={() => setSaved(false)}
          anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
        >
          <Alert severity="success" variant="filled" onClose={() => setSaved(false)}>
            Configuración guardada
          </Alert>
        </Snackbar>
      </Box>
    </Fade>
  )
}
