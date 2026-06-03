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
            setError('identity', { type: 'manual', message: 'This email is already registered' });
          } else if (error.status === 403) {
            setForbidden(true);
            queryClient.invalidateQueries({ queryKey: ['me'] });
          } else if (error.status === 400) {
            setError('identity', { type: 'manual', message: 'Invalid email provided' });
          }
        }
      },
    });
  };

  if (isSuccess) {
    return (
      <SuccessScreen
        icon={<Email sx={{ fontSize: 64 }} />}
        title="Invitation sent"
        description="The agent will receive an email with instructions."
        action={{
          label: 'Send another',
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
          You don't have permission to perform this action.
        </Alert>
      )}

      <Controller
        name="identity"
        control={control}
        render={({ field }) => (
          <TextField
            {...field}
            fullWidth
            label="Agent email"
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
        {isLoading ? <CircularProgress size={24} color="inherit" /> : 'Send invitation'}
      </Button>

      <Box sx={{ textAlign: 'center' }}>
        <Link component={RouterLink} to={ROUTES.DASHBOARD} variant="body2" underline="hover">
          Back to dashboard
        </Link>
      </Box>
    </Box>
  );
}
