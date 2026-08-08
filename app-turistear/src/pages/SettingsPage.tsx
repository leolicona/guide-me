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
import QrCodeScannerRounded from '@mui/icons-material/QrCodeScannerRounded'
import HotelRounded from '@mui/icons-material/HotelRounded'
import WhatsAppIcon from '@mui/icons-material/WhatsApp'
import {
  CancellationPolicyCard,
  useMyOrganization,
  useUpdateOrganization,
} from '../features/organization'
import { InfoPopover } from '../components'
import {
  DEFAULT_TICKET_TEMPLATE,
  DEFAULT_REMINDER_TEMPLATE,
  TEMPLATE_PLACEHOLDERS,
} from '../features/pos/delivery'
import { usePosPreferences } from '../store/posPreferences'
import { ORG_TIMEZONE_OPTIONS, DEFAULT_ORG_TIMEZONE } from '../config/timezones'

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

  const [timezone, setTimezone] = useState('')
  const [minPct, setMinPct] = useState('')
  const [bufferHours, setBufferHours] = useState('')
  const [creationCutoff, setCreationCutoff] = useState('')
  const [cutoffMag, setCutoffMag] = useState('')
  const [cutoffDir, setCutoffDir] = useState<OffsetDir>('before')
  const [graceMag, setGraceMag] = useState('')
  const [graceDir, setGraceDir] = useState<OffsetDir>('before')
  // US-A85 (D23) — when a departed line with nothing redeemed starts reading as "Sin usar".
  const [creditDays, setCreditDays] = useState('')
  const [noShowMag, setNoShowMag] = useState('')
  const [noShowDir, setNoShowDir] = useState<OffsetDir>('after')
  const [saved, setSaved] = useState(false)

  // US-A60/A63 — lodging org policy: weekend days, free-cancel window, penalty %.
  const [weekendDays, setWeekendDays] = useState<number[]>([])

  // whatsapp-qr-delivery D10 — the two admin-edited templates (seeded from the shipped default
  // when the org hasn't customized them).
  const [waTicket, setWaTicket] = useState('')
  const [waReminder, setWaReminder] = useState('')

  // Seed the form from the org's saved values (render-phase, no effect). Re-seeds whenever the
  // saved values change — i.e. on first load and after a successful save — resetting the dirty flag.
  const savedSig = org
    ? `${org.timezone}|${org.booking_min_down_payment_pct}|${org.booking_pre_departure_buffer_hours}|${org.booking_creation_cutoff_hours}|${org.sales_cutoff_offset_minutes}|${org.booking_grace_offset_minutes}|${org.lodging_weekend_days.join(',')}|${org.lodging_free_cancel_days}|${org.lodging_cancel_penalty_pct}|${org.wa_ticket_template ?? ''}|${org.wa_reminder_template ?? ''}`
    : null
  const [seededSig, setSeededSig] = useState<string | null>(null)
  if (org && savedSig !== seededSig) {
    setSeededSig(savedSig)
    setTimezone(org.timezone)
    setMinPct(String(org.booking_min_down_payment_pct))
    setBufferHours(String(org.booking_pre_departure_buffer_hours))
    setCreationCutoff(String(org.booking_creation_cutoff_hours))
    const c = splitOffset(org.sales_cutoff_offset_minutes)
    setCutoffMag(String(c.mag))
    setCutoffDir(c.dir)
    setCreditDays(String(org.booking_credit_valid_days ?? 90))
    const n = splitOffset(org.no_show_margin_minutes ?? 0)
    setNoShowMag(String(n.mag))
    setNoShowDir(n.dir)
    const g = splitOffset(org.booking_grace_offset_minutes)
    setGraceMag(String(g.mag))
    setGraceDir(g.dir)
    setWeekendDays(org.lodging_weekend_days)
    setWaTicket(org.wa_ticket_template ?? DEFAULT_TICKET_TEMPLATE)
    setWaReminder(org.wa_reminder_template ?? DEFAULT_REMINDER_TEMPLATE)
  }

  const pctNum = Number(minPct)
  const bufferNum = Number(bufferHours)
  const cutoffHoursNum = Number(creationCutoff)
  const cutoffMagNum = Number(cutoffMag)
  const graceMagNum = Number(graceMag)

  const pctInvalid = minPct === '' || !Number.isInteger(pctNum) || pctNum < 0 || pctNum > 100
  const bufferInvalid =
    bufferHours === '' || !Number.isInteger(bufferNum) || bufferNum < 0 || bufferNum > 168
  // US-A77 — 0 disables the restriction; anything else must leave room for the settle deadline,
  // or an apartado could be created inside the window it is supposed to be settled in. The server
  // enforces the same rule against the STORED values — this is the fast feedback, not the guard.
  const creationCutoffInvalid =
    creationCutoff === '' ||
    !Number.isInteger(cutoffHoursNum) ||
    cutoffHoursNum < 0 ||
    cutoffHoursNum > 720 ||
    (cutoffHoursNum !== 0 && !bufferInvalid && cutoffHoursNum < bufferNum)
  const magInvalid = (m: string, n: number) =>
    m === '' || !Number.isInteger(n) || n < 0 || n > OFFSET_MAX
  const cutoffInvalid = magInvalid(cutoffMag, cutoffMagNum)
  const graceInvalid = magInvalid(graceMag, graceMagNum)
  const creditDaysNum = Number(creditDays)
  const creditDaysInvalid =
    creditDays !== '' && (!Number.isInteger(creditDaysNum) || creditDaysNum < 1 || creditDaysNum > 730)
  const noShowMagNum = Number(noShowMag)
  const noShowInvalid = magInvalid(noShowMag, noShowMagNum)

  const cutoffSigned = joinOffset(cutoffMagNum, cutoffDir)
  const graceSigned = joinOffset(graceMagNum, graceDir)
  const noShowSigned = joinOffset(noShowMagNum, noShowDir)
  // US-A85 (D23) — the same guard the endpoint enforces, mirrored so the admin is not told after
  // the fact. Both are signed + = before / − = after, so "still sellable" is simply the lower
  // number: a margin ABOVE the sales cutoff would mark a customer absent while their seat is on
  // sale — declaring someone a no-show before we sold them their ticket.
  const noShowTooEarly =
    !noShowInvalid && !cutoffInvalid && noShowMag !== '' && noShowSigned > cutoffSigned
  // US-A87 (D4) — the third coherence rule. Releasing an apartado's spots before the slot stops
  // selling them hands back seats nobody can buy: the customer loses them and nobody gets them.
  // EVERY organization ships in violation of this (release +15, cutoff 0), so the message has to
  // say what to change rather than merely refuse.
  const releaseTooEarly =
    !graceInvalid && !cutoffInvalid && graceMag !== '' && graceSigned > cutoffSigned
  const invalid =
    pctInvalid ||
    bufferInvalid ||
    creationCutoffInvalid ||
    cutoffInvalid ||
    graceInvalid ||
    noShowInvalid ||
    noShowTooEarly ||
    releaseTooEarly ||
    creditDaysInvalid

  const dirty =
    !!org &&
    (timezone !== org.timezone ||
      pctNum !== org.booking_min_down_payment_pct ||
      bufferNum !== org.booking_pre_departure_buffer_hours ||
      cutoffHoursNum !== org.booking_creation_cutoff_hours ||
      cutoffSigned !== org.sales_cutoff_offset_minutes ||
      graceSigned !== org.booking_grace_offset_minutes ||
      noShowSigned !== (org.no_show_margin_minutes ?? 0) ||
      creditDaysNum !== (org.booking_credit_valid_days ?? 90))

  const handleSave = () => {
    update.mutate(
      {
        timezone,
        booking_min_down_payment_pct: pctNum,
        booking_pre_departure_buffer_hours: bufferNum,
        booking_creation_cutoff_hours: cutoffHoursNum,
        sales_cutoff_offset_minutes: cutoffSigned,
        booking_grace_offset_minutes: graceSigned,
        no_show_margin_minutes: noShowSigned,
        booking_credit_valid_days: creditDaysNum,
      },
      { onSuccess: () => setSaved(true) },
    )
  }

  // --- Lodging (Hospedaje) settings ---
  // The free-cancel window and penalty % that used to live here are RETIRED: a stay is priced by
  // the cancellation ladder now, like everything else. Their inputs are gone rather than disabled —
  // a control that changes no behaviour is worse than a missing one. Weekend days stay: that is a
  // PRICING input (which nights bill at weekend_rate), not a cancellation one.
  const lodgingInvalid = weekendDays.length === 0
  const lodgingDirty =
    !!org &&
    [...weekendDays].sort().join(',') !== [...org.lodging_weekend_days].sort().join(',')

  // An org that had configured a penalty lost it when the ladder took over. Say so where they
  // would look for it, once, instead of letting them find out from a refund.
  const hadLodgingCancelPolicy =
    !!org && (org.lodging_free_cancel_days > 0 || org.lodging_cancel_penalty_pct > 0)

  const handleSaveLodging = () => {
    update.mutate({ lodging_weekend_days: weekendDays }, { onSuccess: () => setSaved(true) })
  }

  // --- WhatsApp message templates (whatsapp-qr-delivery D10) ---
  const waTicketInvalid = !waTicket.includes('{portal_link}')
  const waDirty =
    !!org &&
    (waTicket !== (org.wa_ticket_template ?? DEFAULT_TICKET_TEMPLATE) ||
      waReminder !== (org.wa_reminder_template ?? DEFAULT_REMINDER_TEMPLATE))

  const handleSaveWa = () => {
    if (waTicketInvalid) return
    update.mutate(
      { wa_ticket_template: waTicket.trim(), wa_reminder_template: waReminder.trim() },
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
                {/* US-A66 — the org's time zone: the single clock the catalog "hoy", the sales
                    cutoff, and every registered time resolve against. */}
                <TextField
                  select
                  label="Zona horaria"
                  value={timezone || DEFAULT_ORG_TIMEZONE}
                  onChange={(e) => setTimezone(e.target.value)}
                  helperText="Define la hora local del negocio: el día de «hoy» en el catálogo, el cierre de ventas y las horas que se registran."
                >
                  {ORG_TIMEZONE_OPTIONS.map((tz) => (
                    <MenuItem key={tz.value} value={tz.value}>
                      {tz.label}
                    </MenuItem>
                  ))}
                </TextField>

                <Divider flexItem />

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

                {/* US-AG07.1 — the apartado deadline: the balance must be settled at least this long
                    before the tour departs, or the held spot is released. Within this window of
                    departure the tighter grace applies, so the deadline is never born in the past. */}
                <TextField
                  label="Plazo para pagar el saldo"
                  type="number"
                  value={bufferHours}
                  onChange={(e) => setBufferHours(e.target.value)}
                  error={bufferHours !== '' && bufferInvalid}
                  helperText={
                    bufferHours !== '' && bufferInvalid
                      ? 'Captura entre 0 y 168 horas.'
                      : 'Horas antes de la salida en que hay que pagar el saldo del apartado, o el lugar se libera. Ej.: 24 = a más tardar un día antes.'
                  }
                  slotProps={{
                    input: {
                      endAdornment: (
                        <InputAdornment position="end">
                          horas
                          <InfoPopover label="¿Cómo funciona el plazo para pagar el saldo?">
                            <Stack spacing={1}>
                              <Box>
                                El cliente debe pagar el <b>saldo restante</b> del apartado al menos
                                este tiempo antes de que salga el tour. Si no lo hace, el lugar se{' '}
                                <b>libera</b> solo.
                              </Box>
                              <Box>
                                Si faltan <b>menos</b> horas que este plazo para la salida (una
                                reserva de último momento), el apartado se conserva hasta unos minutos
                                antes de salir, para que el plazo <b>nunca quede en el pasado</b>.
                              </Box>
                              <Box color="text.secondary">
                                Ejemplo con 24: un tour dentro de 3 días se paga a más tardar 24 h
                                antes; un tour de mañana temprano se conserva casi hasta la salida.
                              </Box>
                            </Stack>
                          </InfoPopover>
                        </InputAdornment>
                      ),
                    },
                    htmlInput: { min: 0, max: 168, step: 1, inputMode: 'numeric' },
                  }}
                />

                {/* US-A77 — how close to departure an APARTADO may still be opened. Sits directly
                    under the settle deadline because the two are a pair: this one has to leave room
                    for that one, or an apartado is born inside the window it must be settled in. */}
                <TextField
                  label="Los apartados cierran"
                  type="number"
                  value={creationCutoff}
                  onChange={(e) => setCreationCutoff(e.target.value)}
                  error={creationCutoff !== '' && creationCutoffInvalid}
                  helperText={
                    creationCutoff !== '' && creationCutoffInvalid
                      ? cutoffHoursNum !== 0 && cutoffHoursNum < bufferNum
                        ? `Debe ser al menos el plazo para pagar el saldo (${bufferNum} h), o el apartado nacería sin tiempo para liquidarse.`
                        : 'Captura entre 0 y 720 horas.'
                      : cutoffHoursNum === 0
                        ? 'Sin restricción: se puede apartar hasta el momento de la salida.'
                        : `Horas antes de la salida en que dejas de aceptar apartados. Más cerca que eso, solo pago completo.`
                  }
                  slotProps={{
                    input: {
                      endAdornment: (
                        <InputAdornment position="end">
                          horas
                          <InfoPopover label="¿Por qué cerrar los apartados antes?">
                            <Stack spacing={1}>
                              <Box>
                                Un apartado es una <b>promesa de volver a pagar</b>. Muy cerca de la
                                salida no hay tiempo de cumplirla: se abre, vence y se cancela sin
                                que el cliente alcanzara a liquidar.
                              </Box>
                              <Box>
                                Esto <b>no</b> deja de vender el horario — solo deja de aceptar
                                anticipos. La misma salida se sigue vendiendo con{' '}
                                <b>pago completo</b> hasta el «Cierre de ventas».
                              </Box>
                              <Box color="text.secondary">
                                <b>0</b> desactiva la restricción, que es como funcionaba antes.
                              </Box>
                            </Stack>
                          </InfoPopover>
                        </InputAdornment>
                      ),
                    },
                    htmlInput: { min: 0, max: 720, step: 1, inputMode: 'numeric' },
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

                {/* US-A47 / US-AG07.1 — grace window: when an unsettled apartado close to departure
                    auto-cancels. Applies to ANY near-departure tour now (not just same calendar day). */}
                <OffsetField
                  label="Liberación de apartado (cerca de la salida)"
                  helper="Cuando el tour ya está por salir, un apartado sin pagar se libera en este momento. «Después» da un margen de cortesía tras la salida."
                  mag={graceMag}
                  setMag={setGraceMag}
                  dir={graceDir}
                  setDir={setGraceDir}
                  invalid={graceInvalid}
                />

                {/* US-A85 (D23) — its OWN control, beside the two it must never borrow:
                    `Cierre de ventas` gates the sale and `Liberación de apartado` releases the
                    hold. One number cannot serve two intents. */}
                <OffsetField
                  label="Marcar como no usado"
                  helper="Cuando un lugar pagado que nadie escaneó empieza a contar como desperdiciado. «Después» da un margen de cortesía tras la salida."
                  mag={noShowMag}
                  setMag={setNoShowMag}
                  dir={noShowDir}
                  setDir={setNoShowDir}
                  invalid={noShowInvalid}
                />

                {/* US-A87 (D10) — how long the operator carries a closed apartado's credit. Its own
                    number: an accounting horizon, not one of the departure clocks. A perpetual
                    credit is an unbounded liability nobody reconciles. */}
                <TextField
                  label="Vigencia del saldo a favor"
                  type="number"
                  size="small"
                  value={creditDays}
                  onChange={(e) => setCreditDays(e.target.value)}
                  error={creditDaysInvalid}
                  helperText={
                    creditDaysInvalid
                      ? 'Captura entre 1 y 730 días.'
                      : 'Cuánto dura el saldo que queda cuando un apartado vence sin liquidarse.'
                  }
                  slotProps={{
                    input: { endAdornment: <InputAdornment position="end">días</InputAdornment> },
                    htmlInput: { min: 1, max: 730, inputMode: 'numeric' },
                  }}
                  sx={{ width: 220 }}
                />

                {releaseTooEarly && (
                  <Alert severity="warning">
                    Con estos valores devolverías los lugares del apartado{' '}
                    <strong>antes</strong> de dejar de venderlos — nadie podría comprarlos. Pon la
                    «Liberación de apartado» igual o después del «Cierre de ventas».
                  </Alert>
                )}

                {noShowTooEarly && (
                  <Alert severity="warning">
                    Este margen marcaría al cliente como ausente cuando su lugar todavía está a la
                    venta. Ponlo igual o después del «Cierre de ventas».
                  </Alert>
                )}

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

                {/* The free-cancel window and penalty % used to be edited here. They are retired:
                    a stay is priced by the cancellation ladder now. Orgs that had configured them
                    are told once, here, where they would go looking for them. */}
                {hadLodgingCancelPolicy && (
                  <Alert severity="warning">
                    Tu política de cancelación de hospedaje (
                    {org.lodging_free_cancel_days > 0
                      ? `${org.lodging_free_cancel_days} días libres`
                      : 'sin ventana libre'}
                    {org.lodging_cancel_penalty_pct > 0
                      ? `, ${org.lodging_cancel_penalty_pct}% de penalización`
                      : ''}
                    ) <strong>ya no se aplica</strong>. Ahora las estancias se cancelan con la{' '}
                    <strong>política de cancelación</strong> de abajo, igual que los tours —
                    mientras no la configures, se reembolsan al 100%.
                  </Alert>
                )}

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

        {/* US-A69/A70/A72 — the cancellation refund ladder. Sits after Hospedaje because it
            SUPERSEDES the two lodging cancellation fields above once configured: with a policy, the
            ladder prices stays too. Keyed on the stored policy so a save resets the draft cleanly. */}
        {org && (
          <CancellationPolicyCard
            key={JSON.stringify(org.cancellation_policy)}
            policy={org.cancellation_policy}
          />
        )}

        {/* whatsapp-qr-delivery D10 — admin-edited message templates (read-only for sellers, who
            never reach this admin screen). {portal_link} is required on the ticket template. */}
        <Card sx={{ mt: 3 }}>
          <CardContent>
            <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center', mb: 2 }}>
              <WhatsAppIcon color="primary" />
              <Typography variant="h6">Mensajes de WhatsApp</Typography>
            </Stack>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              El texto que se abre en WhatsApp al enviar los boletos. Variables:{' '}
              {TEMPLATE_PLACEHOLDERS.join(' ')} — se reemplazan por los datos de la venta.
            </Typography>
            <Stack spacing={2.5}>
              <TextField
                label="Entrega de boletos"
                multiline
                minRows={4}
                fullWidth
                value={waTicket}
                onChange={(e) => setWaTicket(e.target.value)}
                error={waTicketInvalid}
                helperText={
                  waTicketInvalid
                    ? 'Debe incluir {portal_link} — es el enlace a los boletos.'
                    : 'Se envía al cobrar (tours y hospedaje).'
                }
                slotProps={{ inputLabel: { shrink: true } }}
              />
              <TextField
                label="Recordatorio de apartado"
                multiline
                minRows={3}
                fullWidth
                value={waReminder}
                onChange={(e) => setWaReminder(e.target.value)}
                helperText="Se usa al recordar el saldo pendiente de un apartado."
                slotProps={{ inputLabel: { shrink: true } }}
              />
              <Stack direction="row" sx={{ justifyContent: 'flex-end' }}>
                <Button
                  variant="contained"
                  disableElevation
                  disabled={!waDirty || waTicketInvalid || update.isPending}
                  onClick={handleSaveWa}
                >
                  {update.isPending ? 'Guardando…' : 'Guardar mensajes'}
                </Button>
              </Stack>
            </Stack>
          </CardContent>
        </Card>

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

            <Divider sx={{ my: 2 }} />

            {/* US-A88 (payment-verification D10) — org-wide, commits on tap like the scanner
                toggle. Only the INPUT relaxes: the copy says so, because the admin still verifies
                every transferencia (US-A67) — with or without a reference to match against. */}
            <FormControlLabel
              control={
                <Switch
                  checked={org?.payment_reference_required ?? true}
                  disabled={update.isPending}
                  onChange={(e) =>
                    update.mutate(
                      { payment_reference_required: e.target.checked },
                      { onSuccess: () => setSaved(true) },
                    )
                  }
                />
              }
              label={
                <Box>
                  <Typography variant="body1" sx={{ fontWeight: 500 }}>
                    Referencia obligatoria en transferencias
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    Exigir el número de referencia al cobrar o liquidar por transferencia. Si lo
                    desactivas, el campo se vuelve opcional — el pago igual pasa por verificación
                    del administrador.
                  </Typography>
                </Box>
              }
              sx={{ alignItems: 'flex-start', mx: 0 }}
            />
          </CardContent>
        </Card>

        {/* US-A81 (group-redemption) — how a scan consumes un boleto's passes. Commits on tap
            (no dirty tracking): a two-value org-wide choice whose trade-off the copy states
            explicitly (D8) — the admin is trading an accurate boarded-count for speed, and
            nothing in the system can un-redeem a pass. */}
        <Card sx={{ mt: 3 }}>
          <CardContent>
            <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center', mb: 1 }}>
              <QrCodeScannerRounded color="primary" />
              <Typography variant="h6">Escáner de acceso</Typography>
            </Stack>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              Cómo consume los pases un escaneo de QR.
            </Typography>
            <ToggleButtonGroup
              exclusive
              fullWidth
              value={org?.qr_redemption_mode ?? 'per_pass'}
              onChange={(_, value: 'per_pass' | 'all_passes' | null) => {
                if (value && value !== org?.qr_redemption_mode) {
                  update.mutate({ qr_redemption_mode: value }, { onSuccess: () => setSaved(true) })
                }
              }}
              aria-label="Modo de redención del QR"
            >
              <ToggleButton value="per_pass">Un pase por escaneo</ToggleButton>
              <ToggleButton value="all_passes">Todos los pases a la vez</ToggleButton>
            </ToggleButtonGroup>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
              «Todos a la vez» agiliza el abordaje de grupos (una familia = un escaneo), a cambio
              de perder el conteo exacto de cuántos abordaron — y un escaneo no se puede deshacer.
            </Typography>
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
