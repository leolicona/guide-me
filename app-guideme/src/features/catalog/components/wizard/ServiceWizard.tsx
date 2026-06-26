import { useState } from 'react'
import { useForm, FormProvider } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { Dialog, Box, Typography, Button, Stack, Alert } from '@mui/material'
import { WizardShell } from '../../../../components'
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
    <>
      <WizardShell
        open={open}
        onClose={handleClose}
        title="Nuevo servicio"
        step={step}
        totalSteps={TOTAL_STEPS}
        stepTitle={STEP_TITLES[step]}
        onBack={goBack}
        onNext={goNext}
        onFinish={save}
        isLastStep={isLast}
        finishLabel="Guardar"
        busy={saving}
        error={
          saveMutation.isError ? (
            <Alert severity="error">
              No se pudo crear el servicio. Revisa los datos e inténtalo de nuevo.
            </Alert>
          ) : undefined
        }
      >
        <FormProvider {...methods}>
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
        </FormProvider>
      </WizardShell>

      {/* Discard confirmation */}
      <Dialog
        open={confirmDiscard}
        onClose={() => setConfirmDiscard(false)}
        slotProps={{ paper: { sx: { borderRadius: 'var(--radius-lg, 16px)', p: 1 } } }}
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
            <Button color="error" variant="contained" onClick={doClose}>
              Descartar
            </Button>
          </Stack>
        </Box>
      </Dialog>
    </>
  )
}
