import { useMutation, useQueryClient } from '@tanstack/react-query'
import { createService, type ServiceInput } from '../../../services/catalogService'
import {
  createUnit,
  createSeason,
  createBlockout,
} from '../../../services/lodgingCatalogService'
import { amountToCents, unitCommissionToApi } from '../types'
import type { UnitFormData, SeasonFormData, BlockoutFormData } from '../schemas'
import { SERVICES_QUERY_KEY } from './useServices'

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
  // null — matching UnitFormDialog's mapping. (Found via live smoke test: POST /units → 400.)
  unit_type: u.unit_type?.trim() ? u.unit_type.trim() : null,
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

// Orchestration (Decision D1 — no transactional endpoint):
// 1. POST /services → if this throws, nothing is created (wizard stays on the last step).
// 2. For each unit SEQUENTIALLY: create the unit; if it fails, count it and skip its children
//    (no parent to attach to); else fan out its seasons + block-outs, counting failures.
async function createLodgingFull(
  payload: LodgingSavePayload,
): Promise<LodgingSaveResult> {
  const service = await createService(payload.core)
  let failures = 0

  for (const draft of payload.units) {
    let unitId: string
    try {
      const unit = await createUnit(service.id, toUnitInput(draft))
      unitId = unit.id
    } catch {
      failures += 1
      continue // children skipped — no parent
    }

    const children: Promise<unknown>[] = [
      ...draft.seasons.map((s: SeasonFormData) =>
        createSeason(service.id, unitId, {
          name: s.name,
          start_date: s.start_date,
          end_date: s.end_date,
          nightly_rate: amountToCents(s.nightly_rate),
        }),
      ),
      ...draft.blockouts.map((b: BlockoutFormData) =>
        createBlockout(service.id, unitId, {
          start_date: b.start_date,
          end_date: b.end_date,
          reason: b.reason ?? null,
        }),
      ),
    ]
    const results = await Promise.allSettled(children)
    failures += results.filter((r) => r.status === 'rejected').length
  }

  return { serviceId: service.id, failures }
}

export function useCreateLodgingFull() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: createLodgingFull,
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: SERVICES_QUERY_KEY }),
  })
}
