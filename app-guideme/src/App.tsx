import { Suspense, lazy } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import Box from '@mui/material/Box'
import CircularProgress from '@mui/material/CircularProgress'
import { ROUTES } from './config/routes'
import { AuthGuard } from './features/auth/components/AuthGuard'
import { RoleGuard } from './features/auth/components/RoleGuard'
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
            <Route path={ROUTES.DASHBOARD} element={<DashboardPage />} />
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

            {/* Agent point of sale (US-AG03–AG08) */}
            <Route
              path={ROUTES.POS}
              element={
                <RoleGuard role="agent">
                  <PosCatalogPage />
                </RoleGuard>
              }
            />
            <Route
              path={ROUTES.POS_SERVICE}
              element={
                <RoleGuard role="agent">
                  <PosServicePage />
                </RoleGuard>
              }
            />
            <Route
              path={ROUTES.POS_CHECKOUT}
              element={
                <RoleGuard role="agent">
                  <PosCheckoutPage />
                </RoleGuard>
              }
            />
            <Route
              path={ROUTES.FOLIO}
              element={
                <RoleGuard role="agent">
                  <FolioReceiptPage />
                </RoleGuard>
              }
            />

            {/* Agent access scanner (US-AG15, AG17, AG19) */}
            <Route
              path={ROUTES.SCAN}
              element={
                <RoleGuard role="agent">
                  <ScannerPage />
                </RoleGuard>
              }
            />

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
          <Route path="*" element={<Navigate to={ROUTES.LOGIN} replace />} />
        </Routes>
      </Suspense>
    </BrowserRouter>
  )
}

export default App
