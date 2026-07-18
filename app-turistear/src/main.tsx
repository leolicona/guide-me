import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ThemeProvider } from '@mui/material/styles'
import CssBaseline from '@mui/material/CssBaseline'
import { QueryClientProvider } from '@tanstack/react-query'
import { theme } from './config/theme'
import { queryClient } from './config/queryClient'
import { AppErrorBoundary } from './layout/AppErrorBoundary'
import './styles/tokens.css'
import './index.css'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <QueryClientProvider client={queryClient}>
        {/* BUG-015 — catches rejected lazy-chunk imports (post-deploy stale hashes) that
            would otherwise unmount the root into a blank page; auto-reloads once. */}
        <AppErrorBoundary>
          <App />
        </AppErrorBoundary>
      </QueryClientProvider>
    </ThemeProvider>
  </StrictMode>,
)
