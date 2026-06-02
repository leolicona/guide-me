import { useState } from 'react';
import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { TextField, Button, Box, CircularProgress, Link } from '@mui/material';
import { Link as RouterLink } from 'react-router-dom';
import { Email } from '@mui/icons-material';
import { registerSchema } from '../schemas';
import type { RegisterFormData } from '../schemas';
import { useRegister } from '../hooks/useRegister';
import { ROUTES } from '../../../config/routes';
import { ServiceError } from '../../../services/authService';
import { PasswordInput } from './PasswordInput';
import { PasswordStrength } from './PasswordStrength';
import { SuccessScreen } from './SuccessScreen';

export function RegisterForm() {
  const [isSuccess, setIsSuccess] = useState(false);
  const registerMutation = useRegister();

  const { control, handleSubmit, watch, setError, formState: { errors } } = useForm<RegisterFormData>({
    resolver: zodResolver(registerSchema),
    defaultValues: { name: '', email: '', password: '', company_name: '', phone: '' }
  });

  const passwordValue = watch('password');

  const onSubmit = (data: RegisterFormData) => {
    registerMutation.mutate(data, {
      onSuccess: () => {
        setIsSuccess(true);
      },
      onError: (error) => {
        if (error instanceof ServiceError) {
          if (error.status === 409) {
            setError('email', { type: 'manual', message: 'This email is already registered' });
          } else if (error.status === 400) {
            setError('root', { type: 'manual', message: 'Invalid data provided' });
          }
        }
      }
    });
  };

  if (isSuccess) {
    return (
      <SuccessScreen
        icon={<Email sx={{ fontSize: 64 }} />}
        title="Registration successful"
        description="Check your email to verify your account."
      />
    );
  }

  const isLoading = registerMutation.isPending;

  return (
    <Box component="form" onSubmit={handleSubmit(onSubmit)} noValidate>
      <Controller
        name="name"
        control={control}
        render={({ field }) => (
          <TextField
            {...field}
            fullWidth
            label="Name"
            margin="normal"
            disabled={isLoading}
            error={!!errors.name}
            helperText={errors.name?.message}
          />
        )}
      />

      <Controller
        name="email"
        control={control}
        render={({ field }) => (
          <TextField
            {...field}
            fullWidth
            label="Email"
            type="email"
            margin="normal"
            disabled={isLoading}
            error={!!errors.email}
            helperText={errors.email?.message}
          />
        )}
      />

      <Box sx={{ mt: 2, mb: 1 }}>
        <PasswordInput
          name="password"
          control={control}
          label="Password"
          disabled={isLoading}
        />
        <PasswordStrength password={passwordValue} />
      </Box>

      <Controller
        name="company_name"
        control={control}
        render={({ field }) => (
          <TextField
            {...field}
            fullWidth
            label="Company Name"
            margin="normal"
            disabled={isLoading}
            error={!!errors.company_name}
            helperText={errors.company_name?.message}
          />
        )}
      />

      <Controller
        name="phone"
        control={control}
        render={({ field }) => (
          <TextField
            {...field}
            fullWidth
            label="Phone"
            margin="normal"
            disabled={isLoading}
            error={!!errors.phone}
            helperText={errors.phone?.message}
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
        {isLoading ? <CircularProgress size={24} color="inherit" /> : 'Sign Up'}
      </Button>

      <Box sx={{ textAlign: 'center' }}>
        <Link component={RouterLink} to={ROUTES.LOGIN} variant="body2" underline="hover">
          Already have an account? Log in
        </Link>
      </Box>
    </Box>
  );
}
