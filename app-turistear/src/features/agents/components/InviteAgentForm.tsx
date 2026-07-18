import { useState } from 'react';
import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { TextField, Button, Box, CircularProgress, Alert } from '@mui/material';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { inviteAgentSchema } from '../schemas';
import type { InviteAgentFormData } from '../schemas';
import { useInviteAgent } from '../hooks/useInviteAgent';
import { ServiceError } from '../../../services/authService';
import { ROUTES } from '../../../config/routes';

export function InviteAgentForm() {
  const [forbidden, setForbidden] = useState(false);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const inviteMutation = useInviteAgent();

  const { control, handleSubmit, setError, formState: { errors } } = useForm<InviteAgentFormData>({
    resolver: zodResolver(inviteAgentSchema),
    defaultValues: { identity: '' },
  });

  const onSubmit = (data: InviteAgentFormData) => {
    setForbidden(false);
    inviteMutation.mutate(data, {
      // Return to the agents list with a success toast (unified with the service/affiliate flows).
      onSuccess: () => {
        navigate(ROUTES.AGENTS, { replace: true, state: { agentInvited: true } });
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
            autoFocus
            label="Correo electrónico del agente"
            type="email"
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
        disableElevation
        size="large"
        disabled={isLoading}
        sx={{ mt: 3 }}
      >
        {isLoading ? <CircularProgress size={24} color="inherit" /> : 'Enviar invitación'}
      </Button>
    </Box>
  );
}
