import { useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Alert,
  Avatar,
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Divider,
  Drawer,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Popover,
  Typography,
} from '@mui/material'
import type { SvgIconComponent } from '@mui/icons-material'
import GroupsRounded from '@mui/icons-material/GroupsRounded'
import LogoutRounded from '@mui/icons-material/LogoutRounded'
import MapRounded from '@mui/icons-material/MapRounded'
import SettingsRounded from '@mui/icons-material/SettingsRounded'
import { useCurrentUser } from '../features/auth/CurrentUserContext'
import { useLogout } from '../features/auth/hooks/useLogout'
import { ROUTES } from '../config/routes'

// US-UX03/UX04 — the single account surface that replaces the removed top bar. It holds the
// identity header, the admin's occasional "Gestión" tools (overflow), and the confirm-gated
// logout. Rendered by AppLayout as a popover anchored to the rail avatar (desktop) or a bottom
// sheet opened by the top-right chip (mobile); the inner content is identical for both.

interface ManagementLink {
  label: string
  to: string
  icon: SvgIconComponent
  /** Entry point reserved for a later feature — shown disabled so the IA reads complete. */
  disabled?: boolean
}

const MANAGEMENT_LINKS: ManagementLink[] = [
  { label: 'Agentes', to: ROUTES.AGENTS, icon: GroupsRounded },
  { label: 'Catálogo', to: ROUTES.CATALOG, icon: MapRounded },
  { label: 'Configuración', to: ROUTES.SETTINGS, icon: SettingsRounded },
]

const initialsOf = (name: string) =>
  name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('') || '?'

const roleLabel = (role: 'admin' | 'agent') =>
  role === 'admin' ? 'Administrador' : 'Agente'

interface AccountMenuProps {
  variant: 'popover' | 'sheet'
  open: boolean
  onClose: () => void
  /** Required for the desktop popover; ignored by the mobile sheet. */
  anchorEl?: HTMLElement | null
}

export function AccountMenu({ variant, open, onClose, anchorEl }: AccountMenuProps) {
  const user = useCurrentUser()
  const navigate = useNavigate()
  const { logout, isPending, isError } = useLogout()
  const [confirmOpen, setConfirmOpen] = useState(false)

  const go = (to: string) => {
    onClose()
    navigate(to)
  }

  const content: ReactNode = (
    <Box sx={{ minWidth: variant === 'popover' ? 260 : 'auto' }}>
      {/* Identity header */}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, px: 2, py: 1.75 }}>
        <Avatar sx={{ bgcolor: 'secondary.main', width: 40, height: 40, fontSize: 15 }}>
          {initialsOf(user.name)}
        </Avatar>
        <Box sx={{ minWidth: 0 }}>
          <Typography variant="subtitle2" noWrap sx={{ fontWeight: 600 }}>
            {user.name}
          </Typography>
          <Typography variant="caption" color="text.secondary" noWrap component="div">
            {roleLabel(user.role)}
          </Typography>
          <Typography variant="caption" color="text.secondary" noWrap component="div">
            {user.email}
          </Typography>
        </Box>
      </Box>

      <Divider />

      {/* Gestión — admin overflow (occasional tools) */}
      {user.role === 'admin' && (
        <>
          <Typography
            variant="overline"
            color="text.secondary"
            sx={{ px: 2, pt: 1.25, display: 'block', letterSpacing: 0.6 }}
          >
            Gestión
          </Typography>
          <List dense disablePadding>
            {MANAGEMENT_LINKS.map((item) => {
              const Icon = item.icon
              return (
                <ListItemButton
                  key={item.label}
                  onClick={() => go(item.to)}
                  disabled={item.disabled}
                  sx={{ px: 2 }}
                >
                  <ListItemIcon sx={{ minWidth: 36, color: 'text.secondary' }}>
                    <Icon fontSize="small" />
                  </ListItemIcon>
                  <ListItemText
                    primary={item.label}
                    secondary={item.disabled ? 'Próximamente' : undefined}
                  />
                </ListItemButton>
              )
            })}
          </List>
          <Divider />
        </>
      )}

      {/* Cerrar sesión — behind a confirm step */}
      <List dense disablePadding sx={{ pb: variant === 'sheet' ? 1 : 0 }}>
        <ListItemButton onClick={() => setConfirmOpen(true)} sx={{ px: 2 }}>
          <ListItemIcon sx={{ minWidth: 36, color: 'error.main' }}>
            <LogoutRounded fontSize="small" />
          </ListItemIcon>
          <ListItemText
            primary="Cerrar sesión"
            slotProps={{ primary: { color: 'error.main' } }}
          />
        </ListItemButton>
      </List>
    </Box>
  )

  return (
    <>
      {variant === 'popover' ? (
        <Popover
          open={open}
          anchorEl={anchorEl}
          onClose={onClose}
          anchorOrigin={{ vertical: 'top', horizontal: 'right' }}
          transformOrigin={{ vertical: 'bottom', horizontal: 'left' }}
          slotProps={{
            paper: {
              elevation: 0,
              sx: {
                mt: -1,
                ml: 1,
                border: '1px solid',
                borderColor: 'divider',
                borderRadius: 3,
                overflow: 'hidden',
              },
            },
          }}
        >
          {content}
        </Popover>
      ) : (
        <Drawer
          anchor="bottom"
          open={open}
          onClose={onClose}
          slotProps={{
            paper: {
              sx: {
                borderTopLeftRadius: 16,
                borderTopRightRadius: 16,
                pb: 'env(safe-area-inset-bottom)',
              },
            },
          }}
        >
          <Box sx={{ pt: 1 }}>
            {/* Grabber */}
            <Box
              sx={{
                width: 36,
                height: 4,
                borderRadius: 2,
                bgcolor: 'divider',
                mx: 'auto',
                mb: 0.5,
              }}
            />
            {content}
          </Box>
        </Drawer>
      )}

      {/* Logout confirmation — one tap-plus-confirm, on both form factors. */}
      <Dialog open={confirmOpen} onClose={() => setConfirmOpen(false)} maxWidth="xs" fullWidth>
        <DialogTitle>¿Cerrar sesión?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            Tendrás que iniciar sesión de nuevo para volver a entrar.
          </DialogContentText>
          {/* BUG-006 — a failed logout means the session is still alive on the server;
              say so instead of pretending the user is out. */}
          {isError && (
            <Alert severity="error" sx={{ mt: 2 }}>
              No se pudo cerrar la sesión. Revisa tu conexión e inténtalo de nuevo.
            </Alert>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmOpen(false)} disabled={isPending}>
            Cancelar
          </Button>
          <Button
            variant="contained"
            disableElevation
            color="error"
            onClick={logout}
            disabled={isPending}
          >
            {isPending ? (
              <CircularProgress size={22} color="inherit" />
            ) : (
              'Cerrar sesión'
            )}
          </Button>
        </DialogActions>
      </Dialog>
    </>
  )
}
