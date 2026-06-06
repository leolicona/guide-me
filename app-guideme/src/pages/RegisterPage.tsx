import { AuthLayout } from '../layout/AuthLayout';
import { RegisterForm } from '../features/auth/components/RegisterForm';

export default function RegisterPage() {
  return (
    <AuthLayout title="Crear cuenta">
      <RegisterForm />
    </AuthLayout>
  );
}
