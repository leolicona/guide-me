import { useSearchParams } from 'react-router-dom';
import { ErrorOutlined } from '@mui/icons-material';
import { AuthLayout } from '../layout/AuthLayout';
import { ResetPasswordForm } from '../features/auth/components/ResetPasswordForm';
import { SuccessScreen } from '../features/auth/components/SuccessScreen';
import { ROUTES } from '../config/routes';

export default function ResetPasswordPage() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token');

  if (!token) {
    return (
      <AuthLayout title="Recuperar contraseña">
        <SuccessScreen
          icon={<ErrorOutlined sx={{ fontSize: 64 }} color="error" />}
          title="Enlace inválido"
          description="No se proporcionó un token."
          action={{ label: 'Volver a recuperar contraseña', href: ROUTES.FORGOT_PASSWORD }}
        />
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title="Restablecer contraseña">
      <ResetPasswordForm token={token} />
    </AuthLayout>
  );
}
