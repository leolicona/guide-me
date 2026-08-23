import { Box, Fade, Typography } from '@mui/material'
import { BalanceScreen } from '../features/cash/components/BalanceScreen'

// Route assembly only (`CLAUDE.md` § Frontend Layered Folder Structure). The screen itself lives in
// `features/cash/components/BalanceScreen.tsx`, where the admin's `/cash` host reads the same one.
// The page chrome — the fade, the column width, the `h1` — belongs to whoever owns the route.
export default function BalancePage() {
  return (
    <Fade in timeout={400}>
      <Box sx={{ maxWidth: 680, mx: 'auto' }}>
        <Typography variant="h4" component="h1" sx={{ mb: 3 }}>
          Caja
        </Typography>
        <BalanceScreen surface="self" />
      </Box>
    </Fade>
  )
}
