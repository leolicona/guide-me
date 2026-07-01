import { z } from 'zod'
import { serviceCoreObject } from '../../schemas'
import { FLEX_CAP_MAX_PCT } from '../../types'

// US-A41 — availability fields layered onto the service core. Departure times (US-A42) are
// NOT here: they live in wizard-local state (an array builder), gated manually.
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

// No `.default()` here: a Zod default makes the field optional on input but required on output,
// which desyncs zodResolver's input type from the inferred form type. The wizard supplies the
// blanks via `defaultValues` instead, keeping every field required & consistent.
const availabilityObject = z.object({
  frequency: z.enum(['single', 'recurring']),
  // Used when frequency === 'single'.
  single_date: z.string(),
  // Used when frequency === 'recurring'.
  weekdays: z.array(z.number().int().min(0).max(6)),
  start_date: z.string(),
  end_date: z.string(),
})

// The whole-wizard schema: service core ⊕ availability, with every cross-field rule restated
// here so a single zodResolver + per-step `trigger(STEP_FIELDS[n])` gates each step. The core
// refines mirror serviceFormSchema (and the backend createServiceSchema) exactly.
export const wizardSchema = serviceCoreObject
  .merge(availabilityObject)
  .superRefine((v, ctx) => {
    // --- Step 2: pricing & commission (mirror serviceFormSchema) ---
    if (v.minimum_price > v.base_price) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['minimum_price'],
        message: 'El precio mínimo debe ser ≤ al precio base',
      })
    }
    if (v.commission_type === 'percent' && v.commission_value > 100) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['commission_value'],
        message: 'El porcentaje máximo es 100',
      })
    }
    // Lodging skips the tour-only pricing/availability track entirely — its inventory is units
    // (a wizard-local repeater), priced per night, with no slots/schedules. Stop here. The fixed-
    // commission floor cap below is tour-only: lodging has no service price floor (units price per
    // night) and a fixed base commission counts per stay line, so the cap must not apply.
    if (v.category === 'lodging') return

    // --- Tour-only: a fixed commission may never exceed the price floor (D3) ---
    if (v.commission_type === 'fixed' && v.commission_value > v.minimum_price) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['commission_value'],
        message: 'La comisión fija no puede exceder el precio mínimo',
      })
    }

    // --- Step 3: capacity mode (US-A36) ---
    if (v.is_flexible && v.flex_capacity_pct < 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['flex_capacity_pct'],
        message: `Ingresa un porcentaje entre 1% y ${FLEX_CAP_MAX_PCT}%`,
      })
    }

    // --- Step 3: availability (US-A41) ---
    if (v.frequency === 'single') {
      if (!DATE_RE.test(v.single_date)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['single_date'],
          message: 'Selecciona una fecha',
        })
      }
    } else {
      if (v.weekdays.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['weekdays'],
          message: 'Selecciona al menos un día',
        })
      }
      if (!DATE_RE.test(v.start_date)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['start_date'],
          message: 'Selecciona la fecha inicial',
        })
      }
      if (!DATE_RE.test(v.end_date)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['end_date'],
          message: 'Selecciona la fecha final',
        })
      }
      if (
        DATE_RE.test(v.start_date) &&
        DATE_RE.test(v.end_date) &&
        v.start_date > v.end_date
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['end_date'],
          message: 'La fecha final debe ser ≥ a la inicial',
        })
      }
    }
  })

export type WizardFormData = z.infer<typeof wizardSchema>

// Fields validated when leaving each step (RHF `trigger`). Step 3 also enforces ≥1 departure
// time manually (an array, not an RHF field); Step 4's extras are optional.
export const STEP_FIELDS = {
  1: ['name', 'category'],
  2: ['base_price', 'minimum_price', 'commission_type', 'commission_value'],
  3: [
    'default_capacity',
    'is_flexible',
    'flex_capacity_pct',
    'frequency',
    'single_date',
    'weekdays',
    'start_date',
    'end_date',
  ],
  4: [],
} as const satisfies Record<number, readonly (keyof WizardFormData)[]>

// Lodging track step fields (3 steps): básica · comisión · unidades (gated by units.length).
const LODGING_STEP_FIELDS: Record<number, readonly (keyof WizardFormData)[]> = {
  1: ['name', 'category'],
  2: ['commission_type', 'commission_value'],
  3: [],
}

/** Category-aware RHF fields to validate when leaving a step (tour 4 steps · lodging 3 steps). */
export const stepFields = (
  category: string,
  step: number,
): readonly (keyof WizardFormData)[] =>
  category === 'lodging'
    ? (LODGING_STEP_FIELDS[step] ?? [])
    : (STEP_FIELDS[step as keyof typeof STEP_FIELDS] ?? [])
