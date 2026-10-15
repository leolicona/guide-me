import { AuthLayout } from '../layout/AuthLayout';
import { LegacyLinkNotice } from '../features/auth/components/LegacyLinkNotice';

// passkey-auth FR-063 — /verify, /forgot-password and /reset-password, from links mailed before
// cutover.
export default function LegacyLinkPage() {
  return (
    <AuthLayout title="Iniciar sesión">
      <LegacyLinkNotice />
    </AuthLayout>
  );
}
