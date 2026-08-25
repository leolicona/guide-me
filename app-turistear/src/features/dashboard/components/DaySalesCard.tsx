import { Divider, Stack, Typography } from '@mui/material'
import { MoneyText, SectionCard } from '../../../components'
import type { DashboardSales } from '../../../services/dashboardService'

// US-A16 / D10 — the day's money as the LEDGER stamped it (net payments − refunds inside the
// org-tz day), so this figure can never disagree with Caja. The COUNT is a separate fact and
// labeled as such — «ventas», the UI's one word for the object (US-UX07); the money above it is
// «Cobrado hoy», so the two never collide. Attribution follows who took the money (D14), not who made the sale.
export function DaySalesCard({ sales }: { sales: DashboardSales | undefined }) {
  return (
    <SectionCard title="Cobrado hoy">
      <MoneyText cents={sales?.collected_cents ?? 0} signed srLabel="Cobrado hoy" />
      <Typography variant="body2" color="textSecondary" sx={{ mt: 0.5 }}>
        {sales ? `${sales.folios_created} ventas creadas hoy` : 'Cargando…'}
      </Typography>
      {sales !== undefined && sales.per_seller.length > 0 && (
        <Stack spacing={1.5} divider={<Divider flexItem />} sx={{ mt: 2.5 }}>
          {sales.per_seller.map((s) => (
            <Stack
              key={`${s.user_id}:${s.operator_name ?? ''}`}
              direction="row"
              sx={{ alignItems: 'center', justifyContent: 'space-between' }}
            >
              <Typography sx={{ fontWeight: 600, minWidth: 0 }} noWrap>
                {s.name}
                {s.operator_name && (
                  <Typography component="span" variant="body2" color="textSecondary">
                    {' '}
                    — {s.operator_name}
                  </Typography>
                )}
              </Typography>
              {/* Neutral ink at body size: only the headline figure wears the money green, so the
                  eye lands there first (de-emphasize to emphasize). Red still marks a negative. */}
              <MoneyText
                cents={s.collected_cents}
                semantic={s.collected_cents < 0 ? 'negative' : 'neutral'}
                variant="body1"
                srLabel={`Cobrado por ${s.name}`}
              />
            </Stack>
          ))}
        </Stack>
      )}
    </SectionCard>
  )
}
