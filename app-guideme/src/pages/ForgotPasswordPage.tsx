import { AuthLayout } from '../layout/AuthLayout';
import { ForgotPasswordForm } from '../features/auth/components/ForgotPasswordForm';

export default function ForgotPasswordPage() {
  return (
    <AuthLayout title="Reset your password">
      <ForgotPasswordForm />
    </AuthLayout>
  );
}
