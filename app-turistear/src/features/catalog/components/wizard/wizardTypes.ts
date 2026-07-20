// US-A38..A44 — shared types for the Service Creation Wizard.

import { inventoryModel } from '../../categories'
import type { ServiceCategory } from '../../categories'

/** Step 3 inventory frequency: a single calendar date vs. a recurring weekly rule. */
export type Frequency = 'single' | 'recurring'

/** 'HH:MM' wall-clock departure time (US-A42). */
export type DepartureTime = string

/** A draft extra held in wizard-local state until Save flushes it (US-A43). `price` is a
 * major-unit decimal as typed; converted to centavos at save. `tempId` is a client-only
 * stable key for list rows and upsert-by-id — never sent to the API. */
export interface ExtraDraft {
  tempId: string
  name: string
  price: number
}

/** US-A64 — a draft physical zone held in wizard-local state until Save enables zones on the new
 * service. `tempId` is a client-only stable key; `capacity` is seats (whole number). */
export interface ZoneDraft {
  tempId: string
  name: string
  capacity: number
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

// US-A59 (v2) — the lodging track is 3 steps (no slots/extras; unit types replace availability).
// The types come BEFORE the commission so the property-wide rate is decided with the nightly
// prices in view (a fixed $-per-stay commission is meaningless without a rate anchor).
const LODGING_STEP_TITLES: Record<number, string> = {
  1: 'Información',
  2: 'Tipos de unidad',
  3: 'Comisión',
}

/** Category-aware step count: slot track 4 · unit track 3. */
export const totalSteps = (category: ServiceCategory | ''): number =>
  inventoryModel(category) === 'units' ? 3 : TOTAL_STEPS

/** Category-aware step title. */
export const stepTitle = (category: ServiceCategory | '', step: number): string =>
  inventoryModel(category) === 'units'
    ? (LODGING_STEP_TITLES[step] ?? '')
    : (STEP_TITLES[step as WizardStep] ?? '')
