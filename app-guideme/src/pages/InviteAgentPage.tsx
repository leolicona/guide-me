import { AuthLayout } from '../layout/AuthLayout';
import { InviteAgentForm } from '../features/agents/components/InviteAgentForm';

export default function InviteAgentPage() {
  return (
    <AuthLayout title="Invite an agent">
      <InviteAgentForm />
    </AuthLayout>
  );
}
