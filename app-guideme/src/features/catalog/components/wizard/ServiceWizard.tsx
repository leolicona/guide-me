import { useState } from 'react'
import { useForm, FormProvider } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import {
  Dialog,
  Box,
  Typography,
  IconButton,
  LinearProgress,
  Button,
  Stack,
  Fade,
  Alert,
  CircularProgress,
  Divider,
} from '@mui/material'
import CloseRounded from '@mui/icons-material/CloseRounded'
import ArrowBackRounded from '@mui/icons-material/ArrowBackRounded'
import CheckRounded from '@mui/icons-material/CheckRounded'
import { wizardSchema, STEP_FIELDS, type WizardFormData } from './wizardSchema'
import {
  TOTAL_STEPS,
  STEP_TITLES,
  type WizardStep,
  type DepartureTime,
  type ExtraDraft,
} from './wizardTypes'
import { StepBasicInfo } from './StepBasicInfo'
import { StepPricing } from './StepPricing'
import { StepAvailability } from './StepAvailability'
import { StepExtras } from './StepExtras'
import { useCreateServiceFull } from '../../hooks/useCreateServiceFull'
import { amountToCents, percentToBasisPoints } from '../../types'
import type { ServiceCategory } from '../../categories'
import type { ServiceInput, ExtraInput } from '../../../../services/catalogService'

const EMPTY: WizardFormData = {
  name: '',
  description: '',
  base_price: 0,
  minimum_price: 0,
  default_capacity: 1,
  category: '' as ServiceCategory,
  commission_type: 'percent',
  commission_value: 0,
  is_flexible: false,
  flex_capacity_pct: 0,
  frequency: 'recurring',
  single_date: '',
  weekdays: [],
  start_date: '',
  end_date: '',
}

interface ServiceWizardProps {
  open: boolean
  onClose: () => void
  /** Fired after a successful create. `failures` > 0 means the service exists but some
   * schedules/extras didn't persist (US-A44 partial path). */
  onCreated: (serviceId: string, failures: number) => void
}

export function ServiceWizard({ open, onClose, onCreated }: ServiceWizardProps) {
  const methods = useForm<WizardFormData>({
    resolver: zodResolver(wizardSchema),
    defaultValues: EMPTY,
    mode: 'onTouched',
  })
  const { trigger, getValues, reset, formState } = methods

  const [step, setStep] = useState<WizardStep>(1)
  const [times, setTimes] = useState<DepartureTime[]>([])
  const [extras, setExtras] = useState<ExtraDraft[]>([])
  const [showTimesError, setShowTimesError] = useState(false)
  const [confirmDiscard, setConfirmDiscard] = useState(false)

  const saveMutation = useCreateServiceFull()

  const isDirty =
    formState.isDirty || times.length > 0 || extras.length > 0

  const resetAll = () => {
    reset(EMPTY)
    setStep(1)
    setTimes([])
    setExtras([])
    setShowTimesError(false)
    setConfirmDiscard(false)
    saveMutation.reset()
  }

  const doClose = () => {
    resetAll()
    onClose()
  }

  const handleClose = () => {
    if (saveMutation.isPending) return
    if (isDirty) setConfirmDiscard(true)
    else doClose()
  }

  const goNext = async () => {
    const ok = await trigger([...STEP_FIELDS[step]])
    if (!ok) return
    // Step 3 also needs ≥1 departure time (an array, not an RHF field).
    if (step === 3 && times.length === 0) {
      setShowTimesError(true)
      return
    }
    setStep((s) => (s + 1) as WizardStep)
  }

  const goBack = () => setStep((s) => Math.max(1, s - 1) as WizardStep)

  const save = async () => {
    const ok = await trigger()
    if (!ok) {
      // Jump back to the earliest step that still holds an error.
      for (const s of [1, 2, 3] as WizardStep[]) {
        if (STEP_FIELDS[s].some((f) => f in methods.formState.errors)) {
          setStep(s)
          return
        }
      }
      return
    }
    if (times.length === 0) {
      setShowTimesError(true)
      setStep(3)
      return
    }

    const data = getValues()
    const core: ServiceInput = {
      name: data.name.trim(),
      description: data.description?.trim() ? data.description.trim() : null,
      base_price: amountToCents(data.base_price),
      minimum_price: amountToCents(data.minimum_price),
      default_capacity: data.default_capacity,
      category: data.category,
      commission_type: data.commission_type,
      commission_value:
        data.commission_type === 'fixed'
          ? amountToCents(data.commission_value)
          : percentToBasisPoints(data.commission_value),
      is_flexible: data.is_flexible,
      flex_capacity_pct: data.is_flexible ? data.flex_capacity_pct : 0,
    }
    const extrasPayload: ExtraInput[] = extras.map((e) => ({
      name: e.name,
      price: amountToCents(e.price),
    }))

    saveMutation.mutate(
      {
        core,
        availability: {
          frequency: data.frequency,
          single_date: data.single_date,
          weekdays: data.weekdays,
          start_date: data.start_date,
          end_date: data.end_date,
          times,
        },
        extras: extrasPayload,
      },
      {
        onSuccess: ({ serviceId, failures }) => {
          onCreated(serviceId, failures)
          resetAll()
        },
      },
    )
  }

  const isLast = step === TOTAL_STEPS
  const saving = saveMutation.isPending

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      fullWidth
      slotProps={{
        paper: {
          sx: {
            m: { xs: 0, sm: 2 },
            position: { xs: 'fixed', sm: 'relative' },
            bottom: { xs: 0, sm: 'auto' },
            left: { xs: 0, sm: 'auto' },
            right: { xs: 0, sm: 'auto' },
            width: { xs: '100%', sm: '100%' },
            maxWidth: { sm: 600 },
            height: { xs: '90vh', sm: 'auto' },
            maxHeight: { xs: '90vh', sm: '88vh' },
            borderRadius: { xs: '20px 20px 0 0', sm: 3 },
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
          },
        },
      }}
    >
      {/* Fixed header — title, close, step indicator, progress (US-A38) */}
      <Box sx={{ px: 3, pt: 2.5, pb: 2, flexShrink: 0 }}>
        <Stack
          direction="row"
          sx={{ alignItems: 'center', justifyContent: 'space-between' }}
        >
          <Typography variant="h6">Nuevo servicio</Typography>
          <IconButton
            edge="end"
            onClick={handleClose}
            disabled={saving}
            aria-label="Cerrar"
          >
            <CloseRounded />
          </IconButton>
        </Stack>
        <Stack
          direction="row"
          spacing={1}
          sx={{ alignItems: 'baseline', mt: 0.25 }}
        >
          <Typography
            variant="overline"
            color="secondary"
            sx={{ fontWeight: 700, letterSpacing: 1 }}
          >
            Paso {step} de {TOTAL_STEPS}
          </Typography>
          <Typography variant="body2" color="text.secondary">
            · {STEP_TITLES[step]}
          </Typography>
        </Stack>
        <LinearProgress
          variant="determinate"
          color="secondary"
          value={(step / TOTAL_STEPS) * 100}
          sx={{
            mt: 1.5,
            height: 6,
            borderRadius: 3,
            bgcolor: 'action.hover',
          }}
        />
      </Box>

      <Divider />

      {/* Scrollable body */}
      <Box sx={{ flex: 1, overflowY: 'auto', px: 3, py: 3 }}>
        <FormProvider {...methods}>
          <Fade in key={step} timeout={250}>
            <Box>
              {step === 1 && <StepBasicInfo />}
              {step === 2 && <StepPricing />}
              {step === 3 && (
                <StepAvailability
                  times={times}
                  onTimesChange={setTimes}
                  showTimesError={showTimesError}
                />
              )}
              {step === 4 && <StepExtras extras={extras} onChange={setExtras} />}
            </Box>
          </Fade>
        </FormProvider>
      </Box>

      {saveMutation.isError && (
        <Alert severity="error" sx={{ mx: 3, mb: 1 }}>
          No se pudo crear el servicio. Revisa los datos e inténtalo de nuevo.
        </Alert>
      )}

      <Divider />

      {/* Fixed footer (US-A38) */}
      <Box sx={{ px: 3, py: 2, flexShrink: 0 }}>
        <Stack
          direction="row"
          sx={{ justifyContent: 'space-between', alignItems: 'center' }}
        >
          <Button
            onClick={goBack}
            disabled={step === 1 || saving}
            startIcon={<ArrowBackRounded />}
            color="inherit"
          >
            Anterior
          </Button>
          {isLast ? (
            <Button
              onClick={save}
              variant="contained"
              color="secondary"
              disableElevation
              disabled={saving}
              startIcon={
                saving ? (
                  <CircularProgress size={18} color="inherit" />
                ) : (
                  <CheckRounded />
                )
              }
            >
              Guardar
            </Button>
          ) : (
            <Button
              onClick={goNext}
              variant="contained"
              color="secondary"
              disableElevation
            >
              Siguiente
            </Button>
          )}
        </Stack>
      </Box>

      {/* Discard confirmation */}
      <Dialog
        open={confirmDiscard}
        onClose={() => setConfirmDiscard(false)}
        slotProps={{ paper: { sx: { borderRadius: 3, p: 1 } } }}
      >
        <Box sx={{ p: 2, maxWidth: 360 }}>
          <Typography variant="h6" sx={{ mb: 1 }}>
            ¿Descartar este servicio?
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2.5 }}>
            Perderás la información que has capturado en el asistente.
          </Typography>
          <Stack direction="row" spacing={1} sx={{ justifyContent: 'flex-end' }}>
            <Button color="inherit" onClick={() => setConfirmDiscard(false)}>
              Seguir editando
            </Button>
            <Button color="error" variant="contained" disableElevation onClick={doClose}>
              Descartar
            </Button>
          </Stack>
        </Box>
      </Dialog>
    </Dialog>
  )
}
