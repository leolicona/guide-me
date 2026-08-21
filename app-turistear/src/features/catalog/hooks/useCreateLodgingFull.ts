import { useMutation, useQueryClient } from '@tanstack/react-query'
import { createService, type ServiceInput } from '../../../services/catalogService'
import {
  createUnitType,
  createSeason,
  createBlockout,
} from '../../../services/lodgingCatalogService'
import { amountToCents, unitCommissionToApi } from '../types'
import type { UnitFormData, SeasonFormData, BlockoutFormData } from '../schemas'
import { SERVICES_QUERY_KEY } from './useServices'
import { unitsQueryKey } from './useUnits'

// Wizard draft shapes — the form output plus a client tempId. Money fields stay as major-unit
// decimals until this compile converts them to minor units.
export interface SeasonDraft extends SeasonFormData {
  tempId: string
}
export interface BlockoutDraft extends BlockoutFormData {
  tempId: string
}
export interface UnitDraft extends UnitFormData {
  tempId: string
  seasons: SeasonDraft[]
  blockouts: BlockoutDraft[]
}

// US-A38–A44 (lodging branch) — the wizard compiles a full property in one pass: the service,
// then every unit, then each unit's seasons + block-outs.
export interface LodgingSavePayload {
  core: ServiceInput // category 'lodging'; base_price/minimum_price/default_capacity = 0/0/1
  units: UnitDraft[]
}

export interface LodgingSaveResult {
  serviceId: string
  /** Count of child writes (units/seasons/blockouts) that failed — same partial-success contract
   * as useCreateServiceFull; the admin finishes the gaps on the detail page. */
  failures: number
}

const toUnitInput = (u: UnitDraft) => ({
  name: u.name,
  // The form defaults unit_type to '' (the "Tipo" field is optional). The API rejects '' with 400
  // (unit_type is `z.string().min(1).nullable().optional()`), so an empty/blank value must become
  // null — matching UnitFormSheet's mapping. (Found via live smoke test: POST /units → 400.)
  unit_type: u.unit_type?.trim() ? u.unit_type.trim() : null,
  inventory_count: u.inventory_count,
  beds: u.beds,
  base_occupancy: u.base_occupancy,
  max_capacity: u.max_capacity,
  base_rate: amountToCents(u.base_rate),
  weekend_rate:
    u.weekend_rate === null || u.weekend_rate === undefined
      ? null
      : amountToCents(u.weekend_rate),
  extra_person_fee: amountToCents(u.extra_person_fee),
  min_nights: u.min_nights,
  checkin_time: u.checkin_time,
  checkout_time: u.checkout_time,
  amenities: u.amenities,
  // Waterfall override → API (null ⇒ inherit the service base commission).
  ...unitCommissionToApi(u.commission_type, u.commission_value),
})

// The per-unit fan-out, shared by both modes: for each unit SEQUENTIALLY create the unit; if it
// fails, count it and skip its children (no parent to attach to); else fan out its seasons +
// block-outs, counting failures.
async function createUnits(serviceId: string, drafts: UnitDraft[]): Promise<number> {
  let failures = 0

  for (const draft of drafts) {
    let unitId: string
    try {
      const unit = await createUnitType(serviceId, toUnitInput(draft))
      unitId = unit.id
    } catch {
      failures += 1
      continue // children skipped — no parent
    }

    const children: Promise<unknown>[] = [
      ...draft.seasons.map((s: SeasonFormData) =>
        createSeason(serviceId, unitId, {
          name: s.name,
          start_date: s.start_date,
          end_date: s.end_date,
          nightly_rate: amountToCents(s.nightly_rate),
        }),
      ),
      ...draft.blockouts.map((b: BlockoutFormData) =>
        createBlockout(serviceId, unitId, {
          start_date: b.start_date,
          end_date: b.end_date,
          quantity: b.quantity,
          reason: b.reason ?? null,
        }),
      ),
    ]
    const results = await Promise.allSettled(children)
    failures += results.filter((r) => r.status === 'rejected').length
  }

  return failures
}

// Orchestration (Decision D1 — no transactional endpoint):
// 1. POST /services → if this throws, nothing is created (wizard stays on the last step).
// 2. Then the per-unit fan-out.
async function createLodgingFull(
  payload: LodgingSavePayload,
): Promise<LodgingSaveResult> {
  const service = await createService(payload.core)
  const failures = await createUnits(service.id, payload.units)
  return { serviceId: service.id, failures }
}

// US-A91 — attach mode: the property already exists, so step 1 of the orchestration is skipped
// entirely. No service write of any kind happens here; in particular the property's commission
// (which governs every unit already under it) is never touched.
async function attachUnits(payload: LodgingAttachPayload): Promise<LodgingSaveResult> {
  const failures = await createUnits(payload.serviceId, payload.units)
  return { serviceId: payload.serviceId, failures }
}

export interface LodgingAttachPayload {
  serviceId: string
  units: UnitDraft[]
}

export function useCreateLodgingFull() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: createLodgingFull,
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: SERVICES_QUERY_KEY }),
  })
}

/** US-A91 — add units to a property that already exists (wizard attach mode). */
export function useAttachLodgingUnits() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: attachUnits,
    onSuccess: (_result, variables) => {
      queryClient.invalidateQueries({ queryKey: SERVICES_QUERY_KEY })
      queryClient.invalidateQueries({ queryKey: unitsQueryKey(variables.serviceId) })
    },
  })
}
