import { Box, Fade, Typography } from '@mui/material'
import { BalanceScreen } from '../features/cash/components/BalanceScreen'
import { useCurrentUser } from '../features/auth/CurrentUserContext'

// Route assembly only (`CLAUDE.md` § Frontend Layered Folder Structure). The screen lives in
// `features/cash/components/BalanceScreen.tsx`; this page is the chrome around it — the fade, the
// column width, the `h1` — which belongs to whoever owns the route.
export default function BalancePage() {
  // D2′ — the admin reads their own caja here too. `surface` is about who authorizes their own
  // money moves, which is the one thing that genuinely differs.
  const user = useCurrentUser()
  return (
    <Fade in timeout={400}>
      <Box sx={{ maxWidth: 680, mx: 'auto' }}>
        <Typography variant="h4" component="h1" sx={{ mb: 3 }}>
          Caja
        </Typography>
        <BalanceScreen surface={user.role === 'admin' ? 'admin' : 'self'} />
      </Box>
    </Fade>
  )
}
