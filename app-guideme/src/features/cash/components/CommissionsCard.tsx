import { Card, CardContent, Stack, Typography } from '@mui/material'
import type { CommissionBreakdown } from '../types'
import { formatMoney } from '../../catalog/types'

/**
 * US-AG29 block 3 — "Mis comisiones": earnings presented as earnings (not a deduction line),
 * with the split that resolves the cash-vs-electronic confusion: commissions on electronic
 * sales are pure benefit — they reduce the cash debt without any cash having entered the box.
 */
export function CommissionsCard({ commissions }: { commissions: CommissionBreakdown }) {
  return (
    <Card variant="outlined">
      <CardContent>
        <Typography variant="overline" color="text.secondary">
          Comisiones ganadas
        </Typography>
        <Typography variant="h4" sx={{ fontWeight: 600 }}>
          {formatMoney(commissions.total)}
        </Typography>

        <Stack spacing={0.5} sx={{ mt: 1.5 }}>
          <Stack direction="row" sx={{ justifyContent: 'space-between' }}>
            <Typography variant="body2" color="text.secondary">
              De ventas en efectivo
            </Typography>
            <Typography variant="body2">{formatMoney(commissions.cash)}</Typography>
          </Stack>
          <Stack direction="row" sx={{ justifyContent: 'space-between' }}>
            <Typography variant="body2" color="text.secondary">
              De ventas electrónicas
            </Typography>
            <Typography variant="body2">{formatMoney(commissions.electronic)}</Typography>
          </Stack>
        </Stack>

        {commissions.electronic > 0 && (
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1.5 }}>
            Tus comisiones ya están descontadas de tu caja. Las de ventas electrónicas reducen
            tu deuda de efectivo — son ganancia directa.
          </Typography>
        )}
      </CardContent>
    </Card>
  )
}
