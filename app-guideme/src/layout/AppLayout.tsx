import { Suspense, useState } from 'react'
import { Outlet, Link as RouterLink, useLocation } from 'react-router-dom'
import {
  Avatar,
  Box,
  Badge,
  ButtonBase,
  BottomNavigation,
  BottomNavigationAction,
  CircularProgress,
  useMediaQuery,
} from '@mui/material'
import { alpha, useTheme } from '@mui/material/styles'
import type { SvgIconComponent } from '@mui/icons-material'
import AccountBalanceWalletRounded from '@mui/icons-material/AccountBalanceWalletRounded'
import PointOfSaleRounded from '@mui/icons-material/PointOfSaleRounded'
import QrCodeScannerRounded from '@mui/icons-material/QrCodeScannerRounded'
import ReceiptLongRounded from '@mui/icons-material/ReceiptLongRounded'
import TodayRounded from '@mui/icons-material/TodayRounded'
import { useCurrentUser } from '../features/auth/CurrentUserContext'
import { usePendingAckCount, usePendingDropCount } from '../features/cash/hooks'
import { usePendingCancellationCount } from '../features/folios/hooks'
import { ROUTES } from '../config/routes'
import { AccountMenu } from './AccountMenu'
import { AccountAvatarChip } from './AccountAvatarChip'

interface NavItem {
  label: string
  to: string
  icon: SvgIconComponent
  /** When set, the destination is only shown to that role. */
  role?: 'admin' | 'agent'
}

// US-UX02 — destinations named by CONCEPT, shared across roles. Routes diverge by role where
// the underlying surface differs (Ventas: agent /history vs admin /folios; Caja: agent
// /balance vs admin /cash), but the label, icon, and slot are identical — so the admin nav is
// exactly the agent nav plus "Hoy". Array order is the render order; the role filter preserves
// it, yielding agent [Vender, Escáner, Ventas, Caja] and admin [Hoy, Vender, Escáner, Ventas,
// Caja]. Occasional admin tools (Agentes, Catálogo, …) live in the account surface, not here.
const NAV_ITEMS: NavItem[] = [
  { label: 'Hoy', to: ROUTES.DASHBOARD, icon: TodayRounded, role: 'admin' },
  { label: 'Vender', to: ROUTES.POS, icon: PointOfSaleRounded },
  { label: 'Escáner', to: ROUTES.SCAN, icon: QrCodeScannerRounded },
  { label: 'Ventas', to: ROUTES.HISTORY, icon: ReceiptLongRounded, role: 'agent' },
  { label: 'Ventas', to: ROUTES.FOLIOS, icon: ReceiptLongRounded, role: 'admin' },
  { label: 'Caja', to: ROUTES.BALANCE, icon: AccountBalanceWalletRounded, role: 'agent' },
  { label: 'Caja', to: ROUTES.CASH, icon: AccountBalanceWalletRounded, role: 'admin' },
]

const RAIL_WIDTH = 88

const initialsOf = (name: string) =>
  name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('') || '?'

/**
 * Authenticated app shell. No top bar (US-UX03): the rail (md+) runs full-height with a
 * monogram on top, the daily destination pills in the middle, and a bottom-pinned avatar that
 * opens the account surface; on mobile a bottom navigation bar plus a fixed top-right avatar
 * chip. The active destination gets an indigo (`secondary`) pill — the single accent reserved
 * for active states.
 */
export function AppLayout() {
  const theme = useTheme()
  const isDesktop = useMediaQuery(theme.breakpoints.up('md'))
  const location = useLocation()
  const user = useCurrentUser()
  // US-AG27/AG28 — admin money-moves awaiting the agent's signature, surfaced on the agent's
  // Caja destination. Agents only.
  const { data: pendingAckCount = 0 } = usePendingAckCount(user.role === 'agent')
  // US-T04 — tourists' cancellation requests awaiting review, surfaced on the admin's Ventas
  // destination. Admins only.
  const { data: pendingCancellationCount = 0 } = usePendingCancellationCount(
    user.role === 'admin',
  )
  // US-UX06 — agent cash drops awaiting confirmation, surfaced on the admin's Caja destination.
  // Admins only; the admin's own (self-authorized) drops never count.
  const { data: pendingDropCount = 0 } = usePendingDropCount(user.role === 'admin')

  // US-UX01 — both roles land on their first daily action; the monogram links there too.
  const landingRoute = user.role === 'admin' ? ROUTES.DASHBOARD : ROUTES.POS

  const [accountAnchor, setAccountAnchor] = useState<HTMLElement | null>(null)

  const items = NAV_ITEMS.filter((i) => !i.role || i.role === user.role)
  const isActive = (to: string) => location.pathname.startsWith(to)
  const activeValue = items.find((i) => isActive(i.to))?.to ?? false
  const badgeFor = (to: string) => {
    if (to === ROUTES.BALANCE) return pendingAckCount
    if (to === ROUTES.FOLIOS) return pendingCancellationCount
    if (to === ROUTES.CASH) return pendingDropCount
    return 0
  }

  return (
    <Box
      sx={{
        minHeight: '100vh',
        display: 'flex',
        bgcolor: 'background.default',
      }}
    >
      {isDesktop && (
        <Box
          component="nav"
          aria-label="Primary"
          sx={{
            width: RAIL_WIDTH,
            flexShrink: 0,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            borderRight: '1px solid',
            borderColor: 'divider',
            bgcolor: 'background.paper',
            py: 2,
            position: 'sticky',
            top: 0,
            height: '100vh',
          }}
        >
          {/* Monogram → role landing */}
          <ButtonBase
            component={RouterLink}
            to={landingRoute}
            aria-label="Inicio"
            sx={{
              width: 44,
              height: 44,
              borderRadius: 2.5,
              mb: 2,
              fontWeight: 700,
              fontSize: 18,
              color: 'primary.contrastText',
              bgcolor: 'primary.main',
            }}
          >
            G
          </ButtonBase>

          {/* Daily destinations */}
          <Box
            sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1 }}
          >
            {items.map((item) => {
              const active = isActive(item.to)
              const Icon = item.icon
              return (
                <ButtonBase
                  key={item.to}
                  component={RouterLink}
                  to={item.to}
                  aria-current={active ? 'page' : undefined}
                  sx={{
                    width: 64,
                    py: 1,
                    borderRadius: 3,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 0.5,
                    color: active ? 'secondary.main' : 'text.secondary',
                    transition: 'color 160ms ease',
                    '&:hover .nav-pill': {
                      bgcolor: (t) =>
                        alpha(t.palette.secondary.main, active ? 0.16 : 0.08),
                    },
                  }}
                >
                  <Box
                    className="nav-pill"
                    sx={{
                      px: 2.25,
                      py: 0.5,
                      borderRadius: 999,
                      display: 'flex',
                      bgcolor: (t) =>
                        active ? alpha(t.palette.secondary.main, 0.12) : 'transparent',
                      transition: 'background-color 160ms ease',
                    }}
                  >
                    <Badge badgeContent={badgeFor(item.to)} color="warning">
                      <Icon fontSize="small" />
                    </Badge>
                  </Box>
                  <Box
                    component="span"
                    sx={{
                      fontSize: 12,
                      fontWeight: active ? 600 : 500,
                      lineHeight: 1,
                    }}
                  >
                    {item.label}
                  </Box>
                </ButtonBase>
              )
            })}
          </Box>

          {/* Spacer pushes the account avatar to the bottom of the rail */}
          <Box sx={{ flex: 1 }} />

          {/* Account surface trigger (identity · Gestión · Configuración · Cerrar sesión) */}
          <ButtonBase
            onClick={(e) => setAccountAnchor(e.currentTarget)}
            aria-label={`Cuenta de ${user.name}`}
            sx={{ borderRadius: 999, p: 0.5 }}
          >
            <Avatar sx={{ bgcolor: 'secondary.main', width: 36, height: 36, fontSize: 14 }}>
              {initialsOf(user.name)}
            </Avatar>
          </ButtonBase>
          <AccountMenu
            variant="popover"
            open={Boolean(accountAnchor)}
            anchorEl={accountAnchor}
            onClose={() => setAccountAnchor(null)}
          />
        </Box>
      )}

      <Box
        component="main"
        sx={{
          flex: 1,
          minWidth: 0,
          p: { xs: 2, md: 4 },
          pb: { xs: 12, md: 4 },
        }}
      >
        {/* Boundary lives *inside* the shell so lazy page chunks load without tearing down the
            nav — only the content area shows the loader. */}
        <Suspense
          fallback={
            <Box sx={{ display: 'flex', justifyContent: 'center', pt: 8 }}>
              <CircularProgress />
            </Box>
          }
        >
          <Outlet />
        </Suspense>
      </Box>

      {/* Mobile: the account chip is the fixed top-right overlay — except on the POS catalog,
          whose right-aligned top bar renders the avatar inline (as a Cart sibling), so the
          floating chip is suppressed there to avoid a duplicate. */}
      {!isDesktop && location.pathname !== ROUTES.POS && <AccountAvatarChip />}

      {!isDesktop && (
        <BottomNavigation
          value={activeValue}
          showLabels
          sx={{
            position: 'fixed',
            bottom: 0,
            left: 0,
            right: 0,
            borderTop: '1px solid',
            borderColor: 'divider',
            bgcolor: 'background.paper',
            zIndex: (t) => t.zIndex.appBar,
          }}
        >
          {items.map((item) => {
            const Icon = item.icon
            return (
              <BottomNavigationAction
                key={item.to}
                label={item.label}
                value={item.to}
                icon={
                  <Badge badgeContent={badgeFor(item.to)} color="warning">
                    <Icon />
                  </Badge>
                }
                component={RouterLink}
                to={item.to}
                sx={{
                  '&.Mui-selected': { color: 'secondary.main' },
                  '&.Mui-selected .MuiBottomNavigationAction-label': {
                    fontWeight: 600,
                  },
                }}
              />
            )
          })}
        </BottomNavigation>
      )}
    </Box>
  )
}
