import { Stack, Typography } from '@mui/material'
import type { CommissionBreakdown } from '../types'
import { SectionCard, MoneyText } from '../../../components'

/**
 * US-AG29 block 3 — "Mis comisiones": earnings presented as earnings (not a deduction line),
 * with the split that resolves the cash-vs-electronic confusion: commissions on electronic
 * sales are pure benefit — they reduce the cash debt without any cash having entered the box.
 */
export function CommissionsCard({ commissions }: { commissions: CommissionBreakdown }) {
  return (
    <SectionCard>
        <Typography variant="overline" component="h2" color="textSecondary">
          Comisiones ganadas
        </Typography>
        {/* Earnings, not a deduction — shown in success green (positive semantic). */}
        <MoneyText
          cents={commissions.total}
          semantic="positive"
          variant="h2"
          srLabel="Comisiones ganadas"
          sx={{ display: 'block' }}
        />

        <Stack spacing={0.5} sx={{ mt: 1.5 }}>
          <Stack direction="row" sx={{ justifyContent: 'space-between' }}>
            <Typography variant="body2" color="textSecondary">
              De ventas en efectivo
            </Typography>
            <MoneyText cents={commissions.cash} variant="body2" srLabel="De ventas en efectivo" />
          </Stack>
          <Stack direction="row" sx={{ justifyContent: 'space-between' }}>
            <Typography variant="body2" color="textSecondary">
              De ventas electrónicas
            </Typography>
            <MoneyText
              cents={commissions.electronic}
              variant="body2"
              srLabel="De ventas electrónicas"
            />
          </Stack>
        </Stack>

        {commissions.electronic > 0 && (
          <Typography variant="caption" color="textSecondary" sx={{ display: 'block', mt: 1.5 }}>
            Tus comisiones ya están descontadas de tu caja. Las de ventas electrónicas reducen
            tu deuda de efectivo — son ganancia directa.
          </Typography>
        )}
    </SectionCard>
  )
}
