import { Suspense, lazy } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import Box from '@mui/material/Box'
import CircularProgress from '@mui/material/CircularProgress'
import { ROUTES } from './config/routes'
import { AuthGuard } from './features/auth/components/AuthGuard'
import { RoleGuard } from './features/auth/components/RoleGuard'

const LoginPage = lazy(() => import('./pages/LoginPage'))
const RegisterPage = lazy(() => import('./pages/RegisterPage'))
const VerifyPage = lazy(() => import('./pages/VerifyPage'))
const ForgotPasswordPage = lazy(() => import('./pages/ForgotPasswordPage'))
const ResetPasswordPage = lazy(() => import('./pages/ResetPasswordPage'))
const InviteAcceptPage = lazy(() => import('./pages/InviteAcceptPage'))
const DashboardPage = lazy(() => import('./pages/DashboardPage'))
const InviteAgentPage = lazy(() => import('./pages/InviteAgentPage'))

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
          <Route path={ROUTES.DASHBOARD} element={<AuthGuard><DashboardPage /></AuthGuard>} />
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
