import { QueryClient } from '@tanstack/react-query'

// Single shared instance so non-React modules (e.g. the 401 interceptor in
// services/authService.ts) can manipulate the cache through the same client the
// React tree renders from.
export const queryClient = new QueryClient()
