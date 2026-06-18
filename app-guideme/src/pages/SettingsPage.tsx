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
} from '@mui/material'
import SavingsRounded from '@mui/icons-material/SavingsRounded'
import { useMyOrganization, useUpdateOrganization } from '../features/organization'

// US-A47 — the backend stores a SIGNED departure offset (+ = before, − = after). The admin never
// types a negative: they enter a positive magnitude and pick a direction; the page translates.
type OffsetDir = 'before' | 'after'
const splitOffset = (v: number): { mag: number; dir: OffsetDir } =>
  v >= 0 ? { mag: v, dir: 'before' } : { mag: -v, dir: 'after' }
const joinOffset = (mag: number, dir: OffsetDir): number => (dir === 'after' ? -mag : mag)
const OFFSET_MAX = 240

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

  const [minPct, setMinPct] = useState('')
  const [holdDays, setHoldDays] = useState('')
  const [cutoffMag, setCutoffMag] = useState('')
  const [cutoffDir, setCutoffDir] = useState<OffsetDir>('before')
  const [graceMag, setGraceMag] = useState('')
  const [graceDir, setGraceDir] = useState<OffsetDir>('before')
  const [saved, setSaved] = useState(false)

  // Seed the form from the org's saved values (render-phase, no effect). Re-seeds whenever the
  // saved values change — i.e. on first load and after a successful save — resetting the dirty flag.
  const savedSig = org
    ? `${org.booking_min_down_payment_pct}|${org.booking_hold_days}|${org.sales_cutoff_offset_minutes}|${org.booking_grace_offset_minutes}`
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

  return (
    <Fade in timeout={400}>
      <Box sx={{ maxWidth: 560, mx: 'auto' }}>
        <Typography variant="h4" component="h1" sx={{ mb: 1 }}>
          Configuración
        </Typography>
        <Typography color="text.secondary" sx={{ mb: 3 }}>
          Política de ventas y apartados de tu organización.
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
