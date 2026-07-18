import { useEffect, useState } from 'react'
import { useForm, FormProvider } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { Alert } from '@mui/material'
import { ConfirmSheet, WizardPage } from '../../../../components'
import { wizardSchema, STEP_FIELDS, stepFields, type WizardFormData } from './wizardSchema'
import {
  totalSteps,
  stepTitle,
  type WizardStep,
  type DepartureTime,
  type ExtraDraft,
} from './wizardTypes'
import { StepBasicInfo } from './StepBasicInfo'
import { StepPricing } from './StepPricing'
import { StepAvailability } from './StepAvailability'
import { StepExtras } from './StepExtras'
import { StepCommission } from './StepCommission'
import { StepUnits } from './StepUnits'
import { useCreateServiceFull } from '../../hooks/useCreateServiceFull'
import {
  useCreateLodgingFull,
  type UnitDraft,
} from '../../hooks/useCreateLodgingFull'
import { amountToCents, percentToBasisPoints } from '../../types'
import { inventoryModel, type ServiceCategory } from '../../categories'
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
  /** Exit confirmed (X on a clean form, or discard confirmed) — the parent navigates away. */
  onClose: () => void
  /** Fired after a successful create. `failures` > 0 means the service exists but some
   * schedules/extras didn't persist (US-A44 partial path). */
  onCreated: (serviceId: string, failures: number) => void
}

// The full-page service creation wizard (US-A38–A44) — always mounted as a route's content
// (/catalog/new); navigation away unmounts it, so there's no reset-on-close bookkeeping.
export function ServiceWizard({ onClose, onCreated }: ServiceWizardProps) {
  const methods = useForm<WizardFormData>({
    resolver: zodResolver(wizardSchema),
    defaultValues: EMPTY,
    mode: 'onTouched',
  })
  const { trigger, getValues, formState, watch } = methods

  const [step, setStep] = useState<WizardStep>(1)
  const [times, setTimes] = useState<DepartureTime[]>([])
  const [extras, setExtras] = useState<ExtraDraft[]>([])
  const [units, setUnits] = useState<UnitDraft[]>([])
  const [showTimesError, setShowTimesError] = useState(false)
  const [showUnitsError, setShowUnitsError] = useState(false)
  const [confirmDiscard, setConfirmDiscard] = useState(false)

  const category = watch('category')
  // Structural branch on the category's operational model (categories.ts): the unit track
  // (lodging) swaps steps 2–4 and the save path; the slot track is everything else.
  const isLodging = inventoryModel(category) === 'units'

  const saveMutation = useCreateServiceFull()
  const lodgingSave = useCreateLodgingFull()

  const isDirty =
    formState.isDirty || times.length > 0 || extras.length > 0 || units.length > 0

  const handleClose = () => {
    if (saveMutation.isPending) return
    if (isDirty) setConfirmDiscard(true)
    else onClose()
  }

  // Tab close / refresh with unsaved input → native "leave site?" prompt. SPA back-navigation
  // is not intercepted (BrowserRouter has no useBlocker) — an accepted silent discard.
  useEffect(() => {
    if (!isDirty) return
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [isDirty])

  const goNext = async () => {
    const ok = await trigger([...stepFields(category, step)])
    if (!ok) return
    // The inventory step gates on a local array (not an RHF field): tours need ≥1 departure
    // time (step 3), lodging needs ≥1 unit type (step 2 — types come before the commission).
    if (isLodging) {
      if (step === 2 && units.length === 0) {
        setShowUnitsError(true)
        return
      }
    } else if (step === 3 && times.length === 0) {
      setShowTimesError(true)
      return
    }
    setStep((s) => (s + 1) as WizardStep)
  }

  const goBack = () => setStep((s) => Math.max(1, s - 1) as WizardStep)

  const saveLodging = async () => {
    const ok = await trigger(['name', 'category', 'commission_type', 'commission_value'])
    if (!ok) {
      // Jump to the earliest lodging step still holding an error (1: identidad · 3: comisión).
      const e = methods.formState.errors
      setStep(e.name || e.category ? 1 : 3)
      return
    }
    if (units.length === 0) {
      setShowUnitsError(true)
      setStep(2)
      return
    }
    const data = getValues()
    const core: ServiceInput = {
      name: data.name.trim(),
      description: data.description?.trim() ? data.description.trim() : null,
      // Lodging prices per night on its units — the service carries no slot price/capacity.
      base_price: 0,
      minimum_price: 0,
      default_capacity: 1,
      category: 'lodging',
      commission_type: data.commission_type,
      commission_value:
        data.commission_type === 'fixed'
          ? amountToCents(data.commission_value)
          : percentToBasisPoints(data.commission_value),
      is_flexible: false,
      flex_capacity_pct: 0,
    }
    lodgingSave.mutate(
      { core, units },
      {
        onSuccess: ({ serviceId, failures }) => onCreated(serviceId, failures),
      },
    )
  }

  const save = async () => {
    if (isLodging) return saveLodging()
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
        onSuccess: ({ serviceId, failures }) => onCreated(serviceId, failures),
      },
    )
  }

  const total = totalSteps(category)
  const isLast = step === total
  const saving = saveMutation.isPending || lodgingSave.isPending

  return (
    <>
      <WizardPage
        onClose={handleClose}
        title="Nuevo servicio"
        step={step}
        totalSteps={total}
        stepTitle={stepTitle(category, step)}
        onBack={goBack}
        onNext={goNext}
        onFinish={save}
        isLastStep={isLast}
        finishLabel="Guardar"
        busy={saving}
        error={
          saveMutation.isError || lodgingSave.isError ? (
            <Alert severity="error">
              No se pudo crear el servicio. Revisa los datos e inténtalo de nuevo.
            </Alert>
          ) : undefined
        }
      >
        <FormProvider {...methods}>
          {step === 1 && <StepBasicInfo />}
          {step === 2 &&
            (isLodging ? (
              <StepUnits units={units} onChange={setUnits} showUnitsError={showUnitsError} />
            ) : (
              <StepPricing />
            ))}
          {step === 3 &&
            (isLodging ? (
              <StepCommission units={units} />
            ) : (
              <StepAvailability
                times={times}
                onTimesChange={setTimes}
                showTimesError={showTimesError}
              />
            ))}
          {step === 4 && !isLodging && <StepExtras extras={extras} onChange={setExtras} />}
        </FormProvider>
      </WizardPage>

      {/* Discard confirmation — the sheet outranks the WizardPage host (zIndex modal+1). */}
      <ConfirmSheet
        open={confirmDiscard}
        onClose={() => setConfirmDiscard(false)}
        title="¿Descartar este servicio?"
        description="Perderás la información que has capturado en el asistente."
        confirmLabel="Descartar"
        cancelLabel="Seguir editando"
        onConfirm={onClose}
      />
    </>
  )
}
