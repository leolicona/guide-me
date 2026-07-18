import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  updateMyOrganization,
  type UpdateOrganizationInput,
} from '../../../services/organizationsService'
import { MY_ORG_QUERY_KEY } from './useMyOrganization'

// US-A46 — admin saves the org booking policy. On success the cached org is refreshed so the
// adaptive checkout's deposit chip (US-AG07.2) reflects the new minimum % immediately.
export function useUpdateOrganization() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: UpdateOrganizationInput) => updateMyOrganization(input),
    onSuccess: (org) => {
      qc.setQueryData(MY_ORG_QUERY_KEY, org)
    },
  })
}
