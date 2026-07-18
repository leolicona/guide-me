import { Component, type ErrorInfo, type ReactNode } from 'react'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Typography from '@mui/material/Typography'

// BUG-015 — every route is a lazy() chunk; without a boundary, a rejected dynamic import
// (typically a stale chunk hash right after a redeploy) unmounts the whole root and leaves
// a permanently blank page. <Suspense> only covers the *pending* state — rejections land here.

const RELOAD_FLAG = 'gm:chunk-reload-at'
// Minimum gap between automatic reloads. Bounds a genuinely broken deploy to one reload
// per window instead of a reload loop, while still self-healing the common stale-chunk case.
const RELOAD_MIN_INTERVAL_MS = 10_000

const isChunkLoadError = (error: unknown): boolean =>
  error instanceof Error &&
  /failed to fetch dynamically imported module|error loading dynamically imported module|importing a module script failed|chunkloaderror/i.test(
    error.message + ' ' + error.name,
  )

interface AppErrorBoundaryProps {
  children: ReactNode
}

interface AppErrorBoundaryState {
  error: Error | null
}

export class AppErrorBoundary extends Component<
  AppErrorBoundaryProps,
  AppErrorBoundaryState
> {
  state: AppErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): AppErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[AppErrorBoundary]', error, info.componentStack)

    // A stale-chunk failure self-heals with a reload: the fresh index.html references the
    // new hashes (and the session cookie set before the crash is preserved).
    if (isChunkLoadError(error)) {
      const lastReload = Number(sessionStorage.getItem(RELOAD_FLAG) ?? 0)
      if (Date.now() - lastReload > RELOAD_MIN_INTERVAL_MS) {
        sessionStorage.setItem(RELOAD_FLAG, String(Date.now()))
        window.location.reload()
      }
    }
  }

  render() {
    if (!this.state.error) return this.props.children

    return (
      <Box
        sx={{
          minHeight: '100vh',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 2,
          px: 3,
          textAlign: 'center',
        }}
      >
        <Typography variant="h6" component="h1">
          Algo salió mal
        </Typography>
        <Typography color="text.secondary">
          Ocurrió un error inesperado. Recarga la página para continuar.
        </Typography>
        <Button variant="contained" disableElevation onClick={() => window.location.reload()}>
          Recargar
        </Button>
      </Box>
    )
  }
}
