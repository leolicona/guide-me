import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { request } from '../../../services/authService'

// US-A86 — the admin's outbox.
// Spec: docs/folios/folio-state-machine.spec.md.
//
// There is no seller equivalent, deliberately (D13). US-AG50 drew the line between the two
// audiences at CAPABILITY: an action-tail leaves with the tap that produced it, and clock-produced
// work reaches a seller as a rung on their card's one suggested action — so a seller inbox would
// be a screen showing nothing the card does not already say.

export type NotificationChannel = 'email' | 'whatsapp'
export type NotificationStatus = 'pending' | 'sent' | 'failed' | 'skipped'

export interface OutboxRow {
  id: string
  folio_id: string
  event: string
  channel: NotificationChannel
  status: NotificationStatus
  attempts: number
  last_error: string | null
  sent_at: number | null
  sent_by: string | null
  created_at: number | null
  customer_name: string | null
  customer_phone: string | null
  template: string | null
}

export const useOutbox = (filter: { status?: NotificationStatus; channel?: NotificationChannel }) => {
  const params = new URLSearchParams()
  if (filter.status) params.set('status', filter.status)
  if (filter.channel) params.set('channel', filter.channel)
  const qs = params.toString()

  return useQuery({
    queryKey: ['outbox', filter.status ?? null, filter.channel ?? null],
    queryFn: async () => {
      const res = await request<{ notifications: OutboxRow[] }>(
        `/api/notifications${qs ? `?${qs}` : ''}`,
      )
      return res.notifications
    },
  })
}

/**
 * Mark a WhatsApp row drained. What it records is that a human SENT it — never that the customer
 * received it (D21). `tickets_viewed_at` is the only beacon in the product that means the second
 * thing, and nothing here may set it.
 */
export const useMarkNotificationSent = () => {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) =>
      request<{ notification: { id: string; status: string } }>(`/api/notifications/${id}/sent`, {
        method: 'POST',
        body: JSON.stringify({}),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['outbox'] })
      // Draining `tickets_delivered` also stamps the folio's delivery axis (D26), so any list
      // showing that axis is now stale.
      void qc.invalidateQueries({ queryKey: ['folios'] })
    },
  })
}
