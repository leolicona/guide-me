import { Outlet, Link as RouterLink, useLocation } from 'react-router-dom'
import {
  AppBar,
  Toolbar,
  Typography,
  Button,
  Box,
  ButtonBase,
  BottomNavigation,
  BottomNavigationAction,
  useMediaQuery,
} from '@mui/material'
import { alpha, useTheme } from '@mui/material/styles'
import type { SvgIconComponent } from '@mui/icons-material'
import AccountBalanceWalletRounded from '@mui/icons-material/AccountBalanceWalletRounded'
import DashboardRounded from '@mui/icons-material/DashboardRounded'
import GroupsRounded from '@mui/icons-material/GroupsRounded'
import MapRounded from '@mui/icons-material/MapRounded'
import PaymentsRounded from '@mui/icons-material/PaymentsRounded'
import PointOfSaleRounded from '@mui/icons-material/PointOfSaleRounded'
import QrCodeScannerRounded from '@mui/icons-material/QrCodeScannerRounded'
import ReceiptRounded from '@mui/icons-material/ReceiptRounded'
import { useAuthStore } from '../store/authStore'
import { useLogout } from '../features/auth/hooks/useLogout'
import { ROUTES } from '../config/routes'

interface NavItem {
  label: string
  to: string
  icon: SvgIconComponent
  /** When set, the destination is only shown to that role. */
  role?: 'admin' | 'agent'
}

// Single source of truth so the rail and the bottom bar never drift.
const NAV_ITEMS: NavItem[] = [
  { label: 'Dashboard', to: ROUTES.DASHBOARD, icon: DashboardRounded },
  { label: 'POS', to: ROUTES.POS, icon: PointOfSaleRounded, role: 'agent' },
  { label: 'Scanner', to: ROUTES.SCAN, icon: QrCodeScannerRounded, role: 'agent' },
  { label: 'Balance', to: ROUTES.BALANCE, icon: AccountBalanceWalletRounded, role: 'agent' },
  { label: 'Agentes', to: ROUTES.AGENTS, icon: GroupsRounded, role: 'admin' },
  { label: 'Catálogo', to: ROUTES.CATALOG, icon: MapRounded, role: 'admin' },
  { label: 'Folios', to: ROUTES.FOLIOS, icon: ReceiptRounded, role: 'admin' },
  { label: 'Cash', to: ROUTES.CASH, icon: PaymentsRounded, role: 'admin' },
]

const RAIL_WIDTH = 88

/**
 * Authenticated app shell: a Material-3-styled navigation rail (md and up) or a
 * bottom navigation bar (mobile). The active destination gets an indigo
 * (`secondary`) pill — the single accent reserved for active states. Built on
 * MUI v2 primitives (no first-class NavigationRail exists); MD3 is approximated.
 */
export function AppLayout() {
  const theme = useTheme()
  const isDesktop = useMediaQuery(theme.breakpoints.up('md'))
  const location = useLocation()
  const user = useAuthStore((s) => s.user)
  const { logout, isPending } = useLogout()

  const items = NAV_ITEMS.filter((i) => !i.role || i.role === user?.role)
  const isActive = (to: string) => location.pathname.startsWith(to)
  const activeValue = items.find((i) => isActive(i.to))?.to ?? false

  return (
    <Box
      sx={{
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        bgcolor: 'background.default',
      }}
    >
      <AppBar
        position="sticky"
        color="transparent"
        elevation={0}
        sx={{
          borderBottom: '1px solid',
          borderColor: 'divider',
          bgcolor: 'background.paper',
        }}
      >
        <Toolbar>
          <Typography
            variant="h6"
            component={RouterLink}
            to={ROUTES.DASHBOARD}
            sx={{
              flexGrow: 1,
              fontWeight: 700,
              color: 'primary.main',
              textDecoration: 'none',
            }}
          >
            GuideMe
          </Typography>
          {user && (
            <Typography
              variant="body2"
              color="text.secondary"
              sx={{ mr: 2, display: { xs: 'none', sm: 'block' } }}
            >
              {user.name} ({user.role})
            </Typography>
          )}
          <Button
            variant="outlined"
            size="small"
            onClick={logout}
            disabled={isPending}
          >
            Cerrar sesión
          </Button>
        </Toolbar>
      </AppBar>

      <Box sx={{ display: 'flex', flex: 1, minHeight: 0 }}>
        {isDesktop && (
          <Box
            component="nav"
            aria-label="Primary"
            sx={{
              width: RAIL_WIDTH,
              flexShrink: 0,
              borderRight: '1px solid',
              borderColor: 'divider',
              bgcolor: 'background.paper',
              py: 2,
            }}
          >
            <Box
              sx={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 1,
              }}
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
                          active
                            ? alpha(t.palette.secondary.main, 0.12)
                            : 'transparent',
                        transition: 'background-color 160ms ease',
                      }}
                    >
                      <Icon fontSize="small" />
                    </Box>
                    <Typography
                      variant="caption"
                      sx={{ fontWeight: active ? 600 : 500 }}
                    >
                      {item.label}
                    </Typography>
                  </ButtonBase>
                )
              })}
            </Box>
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
          <Outlet />
        </Box>
      </Box>

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
                icon={<Icon />}
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
