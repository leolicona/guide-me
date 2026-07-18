import { useSearchParams } from 'react-router-dom';
import { Box, CircularProgress, Typography, Paper } from '@mui/material';
import { ErrorOutlined } from '@mui/icons-material';
import { AuthLayout } from '../layout/AuthLayout';
import { InviteCompleteForm } from '../features/auth/components/InviteCompleteForm';
import { SuccessScreen } from '../features/auth/components/SuccessScreen';
import { useInviteAccept } from '../features/auth/hooks/useInviteAccept';

export default function InviteAcceptPage() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token');
  const { data, isLoading, isError } = useInviteAccept(token || '');

  if (!token) {
    return (
      <AuthLayout title="Aceptar invitación">
        <SuccessScreen
          icon={<ErrorOutlined sx={{ fontSize: 64 }} color="error" />}
          title="Enlace inválido"
          description="No se proporcionó un token."
        />
      </AuthLayout>
    );
  }

  if (isLoading) {
    return (
      <AuthLayout title="Aceptar invitación">
        <Box sx={{ textAlign: 'center', py: 4 }}>
          <CircularProgress sx={{ mb: 2 }} />
          <Typography color="text.secondary">Cargando invitación...</Typography>
        </Box>
      </AuthLayout>
    );
  }

  if (isError || !data) {
    return (
      <AuthLayout title="Aceptar invitación">
        <SuccessScreen
          icon={<ErrorOutlined sx={{ fontSize: 64 }} color="error" />}
          title="Invitación inválida"
          description="La invitación es inválida, ha expirado o ya fue utilizada. Contacta a tu administrador."
        />
      </AuthLayout>
    );
  }

  const { identity, organization_name, invitation_type, company_name } = data.invitation;
  const isAffiliate = invitation_type === 'affiliate';

  return (
    <AuthLayout title="Aceptar invitación">
      <Paper variant="outlined" sx={{ p: 2, mb: 3, bgcolor: 'background.default' }}>
        <Typography variant="body2" color="text.secondary">
          {isAffiliate ? 'Vender los servicios de' : 'Unirse a la organización'}
        </Typography>
        <Typography variant="subtitle1" sx={{ fontWeight: 500 }} gutterBottom>
          {organization_name}
        </Typography>
        {isAffiliate && company_name && (
          <>
            <Typography variant="body2" color="text.secondary">
              Como afiliado de
            </Typography>
            <Typography variant="subtitle1" sx={{ fontWeight: 500 }} gutterBottom>
              {company_name}
            </Typography>
          </>
        )}
        <Typography variant="body2" color="text.secondary">
          Correo electrónico
        </Typography>
        <Typography variant="subtitle1" sx={{ fontWeight: 500 }}>
          {identity}
        </Typography>
      </Paper>

      <InviteCompleteForm token={token} isAffiliate={isAffiliate} />
    </AuthLayout>
  );
}
