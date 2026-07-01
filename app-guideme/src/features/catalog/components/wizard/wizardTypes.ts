// US-A38..A44 — shared types for the Service Creation Wizard.

/** Step 3 inventory frequency: a single calendar date vs. a recurring weekly rule. */
export type Frequency = 'single' | 'recurring'

/** 'HH:MM' wall-clock departure time (US-A42). */
export type DepartureTime = string

/** A draft extra held in wizard-local state until Save flushes it (US-A43). `price` is a
 * major-unit decimal as typed; converted to centavos at save. */
export interface ExtraDraft {
  name: string
  price: number
}

export type WizardStep = 1 | 2 | 3 | 4

export const TOTAL_STEPS = 4 as const

/** Short title per step, shown beside the "PASO n DE 4" indicator. */
export const STEP_TITLES: Record<WizardStep, string> = {
  1: 'Información',
  2: 'Precio y comisión',
  3: 'Disponibilidad',
  4: 'Extras',
}

// US-A59 — the lodging track is 3 steps (no slots/extras; units replace availability).
const LODGING_STEP_TITLES: Record<number, string> = {
  1: 'Información',
  2: 'Comisión',
  3: 'Unidades',
}

/** Category-aware step count: tour 4 · lodging 3. */
export const totalSteps = (category: string): number =>
  category === 'lodging' ? 3 : TOTAL_STEPS

/** Category-aware step title. */
export const stepTitle = (category: string, step: number): string =>
  category === 'lodging'
    ? (LODGING_STEP_TITLES[step] ?? '')
    : (STEP_TITLES[step as WizardStep] ?? '')
