import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  createService,
  addExtra,
  type ServiceInput,
  type ExtraInput,
} from '../../../services/catalogService'
import { createSchedule, createSlot } from '../../../services/schedulesService'
import { SERVICES_QUERY_KEY } from './useServices'
import type { DepartureTime } from '../components/wizard/wizardTypes'

// US-A44 — the Wizard's compiled payload. The service `core` is today's ServiceInput; the
// availability + extras are flushed as child writes once the service id exists.
export interface WizardAvailability {
  frequency: 'single' | 'recurring'
  /** frequency === 'single' */
  single_date: string
  /** frequency === 'recurring' */
  weekdays: number[]
  start_date: string
  end_date: string
  /** ≥1; each becomes one slot (single) or one schedule (recurring). */
  times: DepartureTime[]
}

export interface WizardSavePayload {
  core: ServiceInput
  availability: WizardAvailability
  extras: ExtraInput[]
}

export interface WizardSaveResult {
  serviceId: string
  /** Count of child writes (schedules/slots/extras) that failed (D1: partial success is
   * recoverable on the detail page, so we report rather than roll back). */
  failures: number
}

// Orchestration (Decision D1 — frontend, no transactional endpoint):
// 1. POST /services  → if this throws, nothing else is attempted (clean fail).
// 2. fan out one schedule/slot per departure time + one extra each, collecting failures.
async function createServiceFull(
  payload: WizardSavePayload,
): Promise<WizardSaveResult> {
  const service = await createService(payload.core)
  const { availability, extras } = payload

  const children: Promise<unknown>[] = [
    ...availability.times.map((time) =>
      availability.frequency === 'recurring'
        ? createSchedule(service.id, {
            weekdays: availability.weekdays,
            start_time: time,
            start_date: availability.start_date,
            end_date: availability.end_date,
          })
        : createSlot(service.id, {
            date: availability.single_date,
            start_time: time,
          }),
    ),
    ...extras.map((extra) => addExtra(service.id, extra)),
  ]

  const results = await Promise.allSettled(children)
  const failures = results.filter((r) => r.status === 'rejected').length

  return { serviceId: service.id, failures }
}

export function useCreateServiceFull() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: createServiceFull,
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: SERVICES_QUERY_KEY }),
  })
}
