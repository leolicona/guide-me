import { useEffect } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { Box, CircularProgress, Typography } from '@mui/material';
import { CheckCircle, ErrorOutlined } from '@mui/icons-material';
import { AuthLayout } from '../layout/AuthLayout';
import { SuccessScreen } from '../features/auth/components/SuccessScreen';
import { useVerify } from '../features/auth/hooks/useVerify';
import { ROUTES } from '../config/routes';

export default function VerifyPage() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token');
  const navigate = useNavigate();

  const { data, isLoading, isError } = useVerify(token || '');

  useEffect(() => {
    if (data?.user) {
      const timer = setTimeout(() => {
        navigate(ROUTES.DASHBOARD, { replace: true });
      }, 2500);
      return () => clearTimeout(timer);
    }
  }, [data, navigate]);

  if (!token) {
    return (
      <AuthLayout title="Account Verification">
        <SuccessScreen
          icon={<ErrorOutlined sx={{ fontSize: 64 }} color="error" />}
          title="Invalid link"
          description="No verification token was provided."
          action={{ label: 'Back to login', href: ROUTES.LOGIN }}
        />
      </AuthLayout>
    );
  }

  if (isLoading) {
    return (
      <AuthLayout title="Account Verification">
        <Box sx={{ textAlign: 'center', py: 4 }}>
          <CircularProgress sx={{ mb: 2 }} />
          <Typography color="text.secondary">Verifying your account...</Typography>
        </Box>
      </AuthLayout>
    );
  }

  if (isError) {
    return (
      <AuthLayout title="Account Verification">
        <SuccessScreen
          icon={<ErrorOutlined sx={{ fontSize: 64 }} color="error" />}
          title="Verification failed"
          description="The link is invalid or has expired."
          action={{ label: 'Sign up', href: ROUTES.REGISTER }}
        />
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title="Account Verification">
      <SuccessScreen
        icon={<CheckCircle sx={{ fontSize: 64 }} color="success" />}
        title={`Account verified, ${data?.user?.name || 'User'}!`}
        description="You will be redirected to the dashboard shortly."
      />
    </AuthLayout>
  );
}
