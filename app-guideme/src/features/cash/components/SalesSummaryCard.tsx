import { Box, Card, CardContent, Chip, Stack, Typography } from '@mui/material'
import type { SalesBreakdown } from '../types'
import { formatMoney } from '../../catalog/types'
import { ELECTRONIC_METHODS, METHOD_LABEL } from './paymentPresentation'

/**
 * US-AG29 block 2 — "Mis ventas": the shift's sales with the cash-vs-electronic split,
 * so a strong card/transfer day is visible as performance even when it adds no cash debt.
 */
export function SalesSummaryCard({ sales }: { sales: SalesBreakdown }) {
  const count = sales.cash_count + sales.electronic_count
  // The proportion bar only makes sense for positive figures (a settled-cancellation
  // reversal can drive sales.cash negative; the amounts still tell the story).
  const showBar = sales.total > 0 && sales.cash >= 0

  return (
    <Card variant="outlined">
      <CardContent>
        <Typography variant="overline" color="text.secondary">
          Ventas del turno
        </Typography>
        <Stack direction="row" spacing={1} sx={{ alignItems: 'baseline' }}>
          <Typography variant="h5" sx={{ fontWeight: 600 }}>
            {formatMoney(sales.total)}
          </Typography>
          <Typography variant="body2" color="text.secondary">
            {count === 1 ? '1 venta' : `${count} ventas`}
          </Typography>
        </Stack>

        {showBar && (
          <Stack direction="row" spacing={0.25} sx={{ mt: 1.5, height: 6 }}>
            {sales.cash > 0 && (
              <Box
                sx={{
                  flexGrow: sales.cash,
                  bgcolor: 'secondary.main',
                  borderRadius: 3,
                }}
              />
            )}
            {sales.electronic > 0 && (
              <Box sx={{ flexGrow: sales.electronic, bgcolor: 'grey.300', borderRadius: 3 }} />
            )}
          </Stack>
        )}

        <Stack direction="row" spacing={3} sx={{ mt: 2 }}>
          <Box sx={{ flex: 1 }}>
            <Typography variant="caption" color="text.secondary">
              Efectivo · {sales.cash_count}
            </Typography>
            <Typography sx={{ fontWeight: 500 }}>{formatMoney(sales.cash)}</Typography>
          </Box>
          <Box sx={{ flex: 1 }}>
            <Typography variant="caption" color="text.secondary">
              Electrónico · {sales.electronic_count}
            </Typography>
            <Typography sx={{ fontWeight: 500 }}>{formatMoney(sales.electronic)}</Typography>
          </Box>
        </Stack>

        {sales.electronic > 0 && (
          <>
            <Stack direction="row" spacing={1} sx={{ mt: 1.5, flexWrap: 'wrap', gap: 0.5 }}>
              {ELECTRONIC_METHODS.filter((m) => sales.by_method[m] > 0).map((m) => (
                <Chip
                  key={m}
                  size="small"
                  variant="outlined"
                  label={`${METHOD_LABEL[m]} · ${formatMoney(sales.by_method[m])}`}
                />
              ))}
            </Stack>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
              Lo electrónico no entra a tu caja — lo cobra la empresa.
            </Typography>
          </>
        )}
      </CardContent>
    </Card>
  )
}
