import { type ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { Box, CircularProgress } from '@mui/material';
import { useMe } from '../hooks/useMe';
import { CurrentUserProvider } from '../CurrentUserContext';

interface AuthGuardProps {
  children: ReactNode;
}

export function AuthGuard({ children }: AuthGuardProps) {
  const { data: user, isLoading, isFetching, isError } = useMe();
  const location = useLocation();

  // Show the loader on the first load AND while a refetch is in flight without a
  // cached user yet. LoginForm resolves ['me'] via fetchQuery BEFORE navigating, so
  // the normal post-login mount finds a fresh success state; this guard remains for
  // the residual paths (e.g. the 401 interceptor removed the query and a refetch is
  // in flight) where React Query keeps a stale error (isLoading is false) — without
  // it, AuthGuard would bounce back to /login before the refetch resolves.
  if (isLoading || (isFetching && !user)) {
    return (
      <Box sx={{ display: 'flex', minHeight: '100vh', alignItems: 'center', justifyContent: 'center' }}>
        <CircularProgress />
      </Box>
    );
  }

  if (isError || !user) {
    return <Navigate to={`/login?redirect=${encodeURIComponent(location.pathname + location.search)}`} replace />;
  }

  // Publish the resolved user so descendants (RoleGuard, AppLayout, pages) read
  // the exact value gated on here — no separately-synced store, no one-tick lag.
  return <CurrentUserProvider value={user}>{children}</CurrentUserProvider>;
}
