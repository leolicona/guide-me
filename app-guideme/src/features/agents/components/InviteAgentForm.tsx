import { useState } from 'react';
import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { TextField, Button, Box, CircularProgress, Alert, Link } from '@mui/material';
import { Link as RouterLink } from 'react-router-dom';
import { Email } from '@mui/icons-material';
import { useQueryClient } from '@tanstack/react-query';
import { inviteAgentSchema } from '../schemas';
import type { InviteAgentFormData } from '../schemas';
import { useInviteAgent } from '../hooks/useInviteAgent';
import { ServiceError } from '../../../services/authService';
import { ROUTES } from '../../../config/routes';
import { SuccessScreen } from '../../auth/components/SuccessScreen';

export function InviteAgentForm() {
  const [isSuccess, setIsSuccess] = useState(false);
  const [forbidden, setForbidden] = useState(false);
  const queryClient = useQueryClient();
  const inviteMutation = useInviteAgent();

  const { control, handleSubmit, reset, setError, formState: { errors } } = useForm<InviteAgentFormData>({
    resolver: zodResolver(inviteAgentSchema),
    defaultValues: { identity: '' },
  });

  const onSubmit = (data: InviteAgentFormData) => {
    setForbidden(false);
    inviteMutation.mutate(data, {
      onSuccess: () => {
        setIsSuccess(true);
      },
      onError: (error) => {
        if (error instanceof ServiceError) {
          if (error.status === 409) {
            setError('identity', { type: 'manual', message: 'Este correo electrónico ya está registrado' });
          } else if (error.status === 403) {
            setForbidden(true);
            queryClient.invalidateQueries({ queryKey: ['me'] });
          } else if (error.status === 400) {
            setError('identity', { type: 'manual', message: 'Correo electrónico inválido' });
          }
        }
      },
    });
  };

  if (isSuccess) {
    return (
      <SuccessScreen
        icon={<Email sx={{ fontSize: 64 }} />}
        title="Invitación enviada"
        description="El agente recibirá un correo electrónico con instrucciones."
        action={{
          label: 'Enviar otra',
          onClick: () => {
            reset();
            setIsSuccess(false);
          },
        }}
      />
    );
  }

  const isLoading = inviteMutation.isPending;

  return (
    <Box component="form" onSubmit={handleSubmit(onSubmit)} noValidate>
      {forbidden && (
        <Alert severity="error" sx={{ mb: 1 }}>
          No tienes permiso para realizar esta acción.
        </Alert>
      )}

      <Controller
        name="identity"
        control={control}
        render={({ field }) => (
          <TextField
            {...field}
            fullWidth
            label="Correo electrónico del agente"
            type="email"
            margin="normal"
            disabled={isLoading}
            error={!!errors.identity}
            helperText={errors.identity?.message}
          />
        )}
      />

      <Button
        type="submit"
        fullWidth
        variant="contained"
        size="large"
        disabled={isLoading}
        sx={{ mt: 3, mb: 3 }}
      >
        {isLoading ? <CircularProgress size={24} color="inherit" /> : 'Enviar invitación'}
      </Button>

      <Box sx={{ textAlign: 'center' }}>
        <Link component={RouterLink} to={ROUTES.DASHBOARD} variant="body2" underline="hover">
          Volver al dashboard
        </Link>
      </Box>
    </Box>
  );
}
