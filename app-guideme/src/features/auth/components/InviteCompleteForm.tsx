import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { TextField, Button, Box, CircularProgress, Typography } from '@mui/material';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { inviteCompleteSchema } from '../schemas';
import type { InviteCompleteFormData } from '../schemas';
import { useInviteComplete } from '../hooks/useInviteComplete';
import { ROUTES } from '../../../config/routes';
import { ServiceError } from '../../../services/authService';
import { PasswordInput } from './PasswordInput';

export function InviteCompleteForm({ token }: { token: string }) {
  const navigate = useNavigate();
  const inviteCompleteMutation = useInviteComplete();
  const queryClient = useQueryClient();

  const { control, handleSubmit, setError, formState: { errors } } = useForm<InviteCompleteFormData>({
    resolver: zodResolver(inviteCompleteSchema),
    defaultValues: { name: '', password: '', confirmPassword: '' }
  });

  const onSubmit = (data: InviteCompleteFormData) => {
    inviteCompleteMutation.mutate({ token, name: data.name, password: data.password }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: ['me'] });
        navigate(ROUTES.DASHBOARD, { replace: true });
      },
      onError: (error) => {
        if (error instanceof ServiceError && error.status === 400) {
          setError('root', { type: 'manual', message: 'The invitation is invalid or has expired. Contact your administrator.' });
        }
      }
    });
  };

  return (
    <Box component="form" onSubmit={handleSubmit(onSubmit)} noValidate>
      {errors.root && (
        <Typography color="error" variant="body2" sx={{ mb: 2 }}>
          {errors.root.message}
        </Typography>
      )}

      <Controller
        name="name"
        control={control}
        render={({ field }) => (
          <TextField
            {...field}
            fullWidth
            label="Name"
            margin="normal"
            disabled={inviteCompleteMutation.isPending}
            error={!!errors.name}
            helperText={errors.name?.message}
          />
        )}
      />

      <PasswordInput
        name="password"
        control={control}
        label="Password"
        disabled={inviteCompleteMutation.isPending}
      />

      <PasswordInput
        name="confirmPassword"
        control={control}
        label="Confirm Password"
        disabled={inviteCompleteMutation.isPending}
      />

      <Button
        type="submit"
        fullWidth
        variant="contained"
        size="large"
        disabled={inviteCompleteMutation.isPending}
        sx={{ mt: 3, mb: 1 }}
      >
        {inviteCompleteMutation.isPending ? <CircularProgress size={24} color="inherit" /> : 'Complete Setup'}
      </Button>
    </Box>
  );
}
