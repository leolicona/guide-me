import { Suspense, lazy } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import Box from '@mui/material/Box'
import CircularProgress from '@mui/material/CircularProgress'
import { ROUTES } from './config/routes'
import { AuthGuard } from './features/auth/components/AuthGuard'
import { RoleGuard } from './features/auth/components/RoleGuard'
import { useMe } from './features/auth/hooks/useMe'
import { AppLayout } from './layout/AppLayout'

const LoginPage = lazy(() => import('./pages/LoginPage'))
const RegisterPage = lazy(() => import('./pages/RegisterPage'))
const VerifyPage = lazy(() => import('./pages/VerifyPage'))
const ForgotPasswordPage = lazy(() => import('./pages/ForgotPasswordPage'))
const ResetPasswordPage = lazy(() => import('./pages/ResetPasswordPage'))
const InviteAcceptPage = lazy(() => import('./pages/InviteAcceptPage'))
const DashboardPage = lazy(() => import('./pages/DashboardPage'))
const AgentsListPage = lazy(() => import('./pages/AgentsListPage'))
const InviteAgentPage = lazy(() => import('./pages/InviteAgentPage'))
const CatalogListPage = lazy(() => import('./pages/CatalogListPage'))
const CatalogDetailPage = lazy(() => import('./pages/CatalogDetailPage'))
const PosCatalogPage = lazy(() => import('./pages/PosCatalogPage'))
const PosServicePage = lazy(() => import('./pages/PosServicePage'))
const PosCheckoutPage = lazy(() => import('./pages/PosCheckoutPage'))
const FolioReceiptPage = lazy(() => import('./pages/FolioReceiptPage'))
const FolioHistoryPage = lazy(() => import('./pages/FolioHistoryPage'))
const FolioHistoryDetailPage = lazy(() => import('./pages/FolioHistoryDetailPage'))
const ScannerPage = lazy(() => import('./pages/ScannerPage'))
const FoliosListPage = lazy(() => import('./pages/FoliosListPage'))
const FolioDetailPage = lazy(() => import('./pages/FolioDetailPage'))
const BalancePage = lazy(() => import('./pages/BalancePage'))
const CashBalancesPage = lazy(() => import('./pages/CashBalancesPage'))
const CashDropDetailPage = lazy(() => import('./pages/CashDropDetailPage'))

function PageLoader() {
  return (
    <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '100vh' }}>
      <CircularProgress />
    </Box>
  )
}

// BUG-004 — the catch-all is session-aware: an authenticated user opening the bare domain
// or an unknown path lands on their role's home (US-UX01), not on the login form (which
// used to read as "my session was lost"). Logged out (or /api/me failing) still → /login.
function RootRedirect() {
  const { data: user, isLoading, isFetching } = useMe()
  if (isLoading || (isFetching && !user)) return <PageLoader />
  if (!user) return <Navigate to={ROUTES.LOGIN} replace />
  return <Navigate to={user.role === 'admin' ? ROUTES.DASHBOARD : ROUTES.POS} replace />
}

function App() {
  return (
    <BrowserRouter>
      <Suspense fallback={<PageLoader />}>
        <Routes>
          <Route path={ROUTES.LOGIN} element={<LoginPage />} />
          <Route path={ROUTES.REGISTER} element={<RegisterPage />} />
          <Route path={ROUTES.VERIFY} element={<VerifyPage />} />
          <Route path={ROUTES.FORGOT_PASSWORD} element={<ForgotPasswordPage />} />
          <Route path={ROUTES.RESET_PASSWORD} element={<ResetPasswordPage />} />
          <Route path={ROUTES.INVITE_ACCEPT} element={<InviteAcceptPage />} />

          {/* Authenticated app — shares the AppLayout navigation shell */}
          <Route
            element={
              <AuthGuard>
                <AppLayout />
              </AuthGuard>
            }
          >
            {/* Admin "Hoy" landing — agents land on Vender, so this is admin-only */}
            <Route
              path={ROUTES.DASHBOARD}
              element={
                <RoleGuard role="admin">
                  <DashboardPage />
                </RoleGuard>
              }
            />
            <Route
              path={ROUTES.AGENTS}
              element={
                <RoleGuard role="admin">
                  <AgentsListPage />
                </RoleGuard>
              }
            />
            <Route
              path={ROUTES.CATALOG}
              element={
                <RoleGuard role="admin">
                  <CatalogListPage />
                </RoleGuard>
              }
            />
            <Route
              path={ROUTES.CATALOG_DETAIL}
              element={
                <RoleGuard role="admin">
                  <CatalogDetailPage />
                </RoleGuard>
              }
            />

            {/* Point of sale (US-AG03–AG08) — selling is a daily activity for BOTH roles
                (US-A31), so no RoleGuard: agents and admins run the same flow. */}
            <Route path={ROUTES.POS} element={<PosCatalogPage />} />
            <Route path={ROUTES.POS_SERVICE} element={<PosServicePage />} />
            <Route path={ROUTES.POS_CHECKOUT} element={<PosCheckoutPage />} />
            <Route path={ROUTES.FOLIO} element={<FolioReceiptPage />} />

            {/* Agent folio history — read-only list + detail (US-AG20, US-AG21) */}
            <Route
              path={ROUTES.HISTORY}
              element={
                <RoleGuard role="agent">
                  <FolioHistoryPage />
                </RoleGuard>
              }
            />
            <Route
              path={ROUTES.HISTORY_DETAIL}
              element={
                <RoleGuard role="agent">
                  <FolioHistoryDetailPage />
                </RoleGuard>
              }
            />

            {/* Access scanner (US-AG15, AG17, AG19) — granting access is a daily activity
                for BOTH roles (US-A32). */}
            <Route path={ROUTES.SCAN} element={<ScannerPage />} />

            {/* Agent running balance — expenses + cash hand-ins (US-AG12/13/14) */}
            <Route
              path={ROUTES.BALANCE}
              element={
                <RoleGuard role="agent">
                  <BalancePage />
                </RoleGuard>
              }
            />

            {/* Admin folio management — browse + total cancellation (US-A21) */}
            <Route
              path={ROUTES.FOLIOS}
              element={
                <RoleGuard role="admin">
                  <FoliosListPage />
                </RoleGuard>
              }
            />
            <Route
              path={ROUTES.FOLIO_DETAIL}
              element={
                <RoleGuard role="admin">
                  <FolioDetailPage />
                </RoleGuard>
              }
            />

            {/* Admin cash — outstanding balances, drops review, payouts (US-A19/A25) */}
            <Route
              path={ROUTES.CASH}
              element={
                <RoleGuard role="admin">
                  <CashBalancesPage />
                </RoleGuard>
              }
            />
            <Route
              path={ROUTES.CASH_DROP_DETAIL}
              element={
                <RoleGuard role="admin">
                  <CashDropDetailPage />
                </RoleGuard>
              }
            />
          </Route>

          {/* Focused form page — uses the centered AuthLayout, not the shell */}
          <Route
            path={ROUTES.INVITE_AGENT}
            element={
              <AuthGuard>
                <RoleGuard role="admin">
                  <InviteAgentPage />
                </RoleGuard>
              </AuthGuard>
            }
          />
          <Route path="*" element={<RootRedirect />} />
        </Routes>
      </Suspense>
    </BrowserRouter>
  )
}

export default App
