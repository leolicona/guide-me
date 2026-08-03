import type { ReactElement, ReactNode } from 'react'
import { ThemeProvider } from '@mui/material/styles'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { render, type RenderOptions, type RenderResult } from '@testing-library/react'
import { theme } from '../config/theme'

export interface ProviderOptions extends Omit<RenderOptions, 'wrapper'> {
  /** Initial history entries for the MemoryRouter (default `['/']`). */
  initialEntries?: string[]
  /** Reuse a client across renders — only needed when a test seeds the cache itself. */
  queryClient?: QueryClient
}

// A fresh client per render: `retry: false` so an asserted error path fails in one tick instead of
// three, and gcTime 0 so nothing survives into the next test.
export function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: 0 },
      mutations: { retry: false },
    },
  })
}

export interface RenderWithProvidersResult extends RenderResult {
  queryClient: QueryClient
}

/**
 * The only render a test should call. Mounts under the REAL theme (component tests must see real
 * tokens — docs/TESTING.md § Conventions), a per-test QueryClient, and a MemoryRouter.
 */
export function renderWithProviders(
  ui: ReactElement,
  { initialEntries = ['/'], queryClient, ...options }: ProviderOptions = {},
): RenderWithProvidersResult {
  const client = queryClient ?? createTestQueryClient()

  const Wrapper = ({ children }: { children: ReactNode }) => (
    <ThemeProvider theme={theme}>
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={initialEntries}>{children}</MemoryRouter>
      </QueryClientProvider>
    </ThemeProvider>
  )

  return { ...render(ui, { wrapper: Wrapper, ...options }), queryClient: client }
}

/** Wrapper for renderHook — same providers, no router-dependent UI. */
export function withProviders(queryClient?: QueryClient) {
  const client = queryClient ?? createTestQueryClient()
  const wrapper = ({ children }: { children: ReactNode }) => (
    <ThemeProvider theme={theme}>
      <QueryClientProvider client={client}>
        <MemoryRouter>{children}</MemoryRouter>
      </QueryClientProvider>
    </ThemeProvider>
  )
  return { wrapper, queryClient: client }
}

export * from '@testing-library/react'
export { default as userEvent } from '@testing-library/user-event'
