import { AuthLayout } from '../layout/AuthLayout';
import { SignInScreen } from '../features/auth/components/SignInScreen';

export default function LoginPage() {
  return (
    <AuthLayout title="Iniciar sesión">
      <SignInScreen />
    </AuthLayout>
  );
}
