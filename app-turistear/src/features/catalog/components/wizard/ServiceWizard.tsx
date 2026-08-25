import { useEffect, useMemo, useState } from 'react'
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
  type ZoneDraft,
  type LodgingMode,
} from './wizardTypes'
import { NEW_PROPERTY, type PropertyChoice } from './PropertyPicker'
import { StepBasicInfo } from './StepBasicInfo'
import { StepPricing } from './StepPricing'
import { StepAvailability } from './StepAvailability'
import { StepExtras } from './StepExtras'
import { StepCommission } from './StepCommission'
import { StepUnits } from './StepUnits'
import { useCreateServiceFull } from '../../hooks/useCreateServiceFull'
import {
  useCreateLodgingFull,
  useAttachLodgingUnits,
  type UnitDraft,
} from '../../hooks/useCreateLodgingFull'
import { useServices } from '../../hooks/useServices'
import { useUnits } from '../../hooks/useUnits'
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
   * schedules/extras didn't persist (US-A44 partial path). US-A91 — `attached` carries the
   * target property's name when units were added to an existing property (units created,
   * no service written), so the caller can name it in the confirmation. */
  onCreated: (
    serviceId: string,
    failures: number,
    attached?: { propertyName: string; unitCount: number },
  ) => void
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
  const [zones, setZones] = useState<ZoneDraft[]>([])
  const [showTimesError, setShowTimesError] = useState(false)
  const [showUnitsError, setShowUnitsError] = useState(false)
  const [showZonesError, setShowZonesError] = useState(false)
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  // US-A91 — which property the units go to. Wizard-local (like `units`/`times`): it is a
  // routing decision, not part of the service payload, so it never reaches ServiceInput.
  const [choice, setChoice] = useState<PropertyChoice>(null)
  const [showChoiceError, setShowChoiceError] = useState(false)

  const category = watch('category')
  // Structural branch on the category's operational model (categories.ts): the unit track
  // (lodging) swaps steps 2–4 and the save path; the slot track is everything else.
  const isLodging = inventoryModel(category) === 'units'

  // US-A91 D12 — only ACTIVE lodging properties are offerable: a unit under a deactivated
  // property cannot be sold. An org whose properties are all inactive is an org with none.
  const { data: services } = useServices()
  const properties = useMemo(
    () =>
      (services ?? []).filter((s) => s.category === 'lodging' && s.status === 'active'),
    [services],
  )
  // D6 — exactly one property is unambiguous, so it is preselected; with two or more nothing is,
  // and goNext() refuses to advance. Preselecting the first of several would invite a unit to be
  // filed under the wrong building, which looks correct everywhere afterwards.
  useEffect(() => {
    if (isLodging && choice === null && properties.length === 1) {
      setChoice(properties[0].id)
    }
  }, [isLodging, choice, properties])

  const attachTo =
    isLodging && choice !== null && choice !== NEW_PROPERTY
      ? (properties.find((p) => p.id === choice) ?? null)
      : null
  const mode: LodgingMode = attachTo ? 'attach' : 'create'
  // D11 — the guard must see what the SERVER already holds, or attach mode ships the duplicate
  // one level down. Same query key as the catalog list's summary, so the cache is warm.
  const { data: targetUnits } = useUnits(attachTo?.id ?? '', !!attachTo)
  const serverUnitNames = useMemo(
    () => (targetUnits ?? []).filter((u) => u.status === 'active').map((u) => u.name),
    [targetUnits],
  )

  const saveMutation = useCreateServiceFull()
  const lodgingSave = useCreateLodgingFull()
  const lodgingAttach = useAttachLodgingUnits()

  const isDirty =
    formState.isDirty ||
    times.length > 0 ||
    extras.length > 0 ||
    units.length > 0 ||
    zones.length > 0 ||
    choice !== null

  // US-A64 — zones are optional; when present they must be a complete 2–6 set with unique names
  // and ≥ 1 seat each. Empty = unzoned (valid).
  const zonesValid = (): boolean => {
    if (zones.length === 0) return true
    if (zones.length < 2 || zones.length > 6) return false
    const names = zones.map((z) => z.name.trim().toLowerCase())
    return (
      zones.every((z) => z.name.trim().length > 0 && Number.isInteger(z.capacity) && z.capacity >= 1) &&
      new Set(names).size === names.length
    )
  }

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
    // US-A91 D6 — with a picker on screen, step 1 gates on the choice: nothing is preselected
    // when there are two or more properties, precisely so a unit cannot be filed under the
    // wrong building by blowing through.
    if (isLodging && step === 1 && properties.length > 0 && choice === null) {
      setShowChoiceError(true)
      return
    }
    const ok = await trigger([...stepFields(category, step, mode)])
    if (!ok) return
    // The inventory step gates on a local array (not an RHF field): tours need ≥1 departure
    // time (step 3), lodging needs ≥1 unit (step 2 — units come before the commission).
    if (isLodging) {
      if (step === 2 && units.length === 0) {
        setShowUnitsError(true)
        return
      }
    } else if (step === 3) {
      if (times.length === 0) {
        setShowTimesError(true)
        return
      }
      if (!zonesValid()) {
        setShowZonesError(true)
        return
      }
    }
    setStep((s) => (s + 1) as WizardStep)
  }

  const goBack = () => setStep((s) => Math.max(1, s - 1) as WizardStep)

  const saveLodging = async () => {
    // US-A91 — attach mode writes NOTHING on the service. `name` and the commission fields
    // belong to a property being created; validating (let alone sending) them here would
    // rewrite the rate governing every unit already under the chosen property (D7).
    if (attachTo) {
      if (units.length === 0) {
        setShowUnitsError(true)
        setStep(2)
        return
      }
      lodgingAttach.mutate(
        { serviceId: attachTo.id, units },
        {
          onSuccess: ({ serviceId, failures }) =>
            onCreated(serviceId, failures, {
              propertyName: attachTo.name,
              unitCount: units.length,
            }),
        },
      )
      return
    }
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
    if (!zonesValid()) {
      setShowZonesError(true)
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
        // US-A64 — enabled on the new service after its departures exist (see useCreateServiceFull).
        zones:
          zones.length >= 2
            ? zones.map((z) => ({ name: z.name.trim(), capacity: z.capacity }))
            : undefined,
      },
      {
        onSuccess: ({ serviceId, failures }) => onCreated(serviceId, failures),
      },
    )
  }

  const total = totalSteps(category, mode)
  const isLast = step === total
  const saving = saveMutation.isPending || lodgingSave.isPending || lodgingAttach.isPending

  return (
    <>
      <WizardPage
        onClose={handleClose}
        title={attachTo ? 'Agregar unidad' : 'Nuevo servicio'}
        step={step}
        totalSteps={total}
        stepTitle={stepTitle(category, step, mode)}
        onBack={goBack}
        onNext={goNext}
        onFinish={save}
        isLastStep={isLast}
        finishLabel="Guardar"
        busy={saving}
        error={
          saveMutation.isError || lodgingSave.isError || lodgingAttach.isError ? (
            <Alert severity="error">
              {attachTo
                ? 'No se pudieron agregar las unidades. Revisa los datos e inténtalo de nuevo.'
                : 'No se pudo crear el servicio. Revisa los datos e inténtalo de nuevo.'}
            </Alert>
          ) : undefined
        }
      >
        <FormProvider {...methods}>
          {step === 1 && (
            <StepBasicInfo
              properties={properties}
              choice={choice}
              onChoiceChange={(next) => {
                setChoice(next)
                setShowChoiceError(false)
              }}
              showChoiceError={showChoiceError}
            />
          )}
          {step === 2 &&
            (isLodging ? (
              <StepUnits
                units={units}
                onChange={setUnits}
                showUnitsError={showUnitsError}
                propertyName={attachTo?.name}
                serverUnitNames={serverUnitNames}
                suggestedName={attachTo ? getValues('name')?.trim() : undefined}
              />
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
                zones={zones}
                onZonesChange={setZones}
                showZonesError={showZonesError}
              />
            ))}
          {step === 4 && !isLodging && <StepExtras extras={extras} onChange={setExtras} />}
        </FormProvider>
      </WizardPage>

      {/* Discard confirmation — the sheet outranks the WizardPage host (zIndex modal+1). */}
      <ConfirmSheet
        open={confirmDiscard}
        onClose={() => setConfirmDiscard(false)}
        title={attachTo ? '¿Descartar esta unidad?' : '¿Descartar este servicio?'}
        description="Perderás la información que has capturado en el asistente."
        confirmLabel="Descartar"
        cancelLabel="Seguir editando"
        onConfirm={onClose}
      />
    </>
  )
}
