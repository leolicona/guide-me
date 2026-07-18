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
      <AuthLayout title="Verificación de cuenta">
        <SuccessScreen
          icon={<ErrorOutlined sx={{ fontSize: 64 }} color="error" />}
          title="Enlace inválido"
          description="No se proporcionó un token de verificación."
          action={{ label: 'Volver al inicio de sesión', href: ROUTES.LOGIN }}
        />
      </AuthLayout>
    );
  }

  if (isLoading) {
    return (
      <AuthLayout title="Verificación de cuenta">
        <Box sx={{ textAlign: 'center', py: 4 }}>
          <CircularProgress sx={{ mb: 2 }} />
          <Typography color="text.secondary">Verificando tu cuenta...</Typography>
        </Box>
      </AuthLayout>
    );
  }

  if (isError) {
    return (
      <AuthLayout title="Verificación de cuenta">
        <SuccessScreen
          icon={<ErrorOutlined sx={{ fontSize: 64 }} color="error" />}
          title="Verificación fallida"
          description="El enlace es inválido o ha expirado."
          action={{ label: 'Registrarse', href: ROUTES.REGISTER }}
        />
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title="Verificación de cuenta">
      <SuccessScreen
        icon={<CheckCircle sx={{ fontSize: 64 }} color="success" />}
        title={`¡Cuenta verificada, ${data?.user?.name || 'Usuario'}!`}
        description="Serás redirigido al dashboard en breve."
      />
    </AuthLayout>
  );
}
