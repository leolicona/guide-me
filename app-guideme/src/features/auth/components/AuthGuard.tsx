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
  // cached user yet. The latter covers the post-login case: a prior 401 leaves
  // the ['me'] query in an `error` state, and login success invalidates it.
  // During that refetch React Query keeps the stale error (isLoading is false),
  // so without this guard AuthGuard would bounce back to /login on the stale
  // error before the refetch resolves to the now-authenticated user.
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
