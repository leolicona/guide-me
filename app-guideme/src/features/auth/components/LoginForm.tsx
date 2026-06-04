import { useState } from 'react';
import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { TextField, Button, Alert, Box, CircularProgress, Link } from '@mui/material';
import { Link as RouterLink, useNavigate, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { loginSchema } from '../schemas';
import type { LoginFormData } from '../schemas';
import { useLogin } from '../hooks/useLogin';
import { ROUTES } from '../../../config/routes';
import { ServiceError, getMe } from '../../../services/authService';
import { PasswordInput } from './PasswordInput';

export function LoginForm() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const rawRedirect = searchParams.get('redirect') ?? '';
  const redirectPath = rawRedirect.startsWith('/') && !rawRedirect.startsWith('//')
    ? rawRedirect
    : ROUTES.DASHBOARD;
  const loginMutation = useLogin();
  const queryClient = useQueryClient();

  // Set by the global interceptor when a suspended account is bounced (US-A08).
  const wasSuspended = searchParams.get('reason') === 'suspended';
  const [authError, setAuthError] = useState<string | null>(
    wasSuspended
      ? 'Your account has been suspended. Contact your administrator.'
      : null,
  );

  const { control, handleSubmit, setValue, setFocus, formState: { errors } } = useForm<LoginFormData>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: '', password: '' }
  });

  const onSubmit = (data: LoginFormData) => {
    setAuthError(null);
    loginMutation.mutate(data, {
      onSuccess: async () => {
        // Resolve the session query BEFORE navigating, so the route guard mounts
        // on an already-authenticated, success state. Otherwise a stale/empty
        // ['me'] state (e.g. left over from a prior 401) makes the guard bounce
        // straight back to /login while the refetch is still in flight.
        try {
          await queryClient.fetchQuery({
            queryKey: ['me'],
            queryFn: getMe,
            staleTime: 0,
          });
        } catch {
          // If /api/me fails right after a successful login it's a real session
          // problem (not a race); let the guard handle the redirect.
        }
        navigate(redirectPath, { replace: true });
      },
      onError: (error) => {
        if (error instanceof ServiceError) {
          if (error.status === 401) {
            setAuthError('Incorrect email or password');
            setValue('password', '');
            setFocus('password');
          } else if (error.status === 403) {
            setAuthError('Your account has not been verified. Check your email.');
          } else {
            setAuthError(error.message || 'An error occurred during login');
          }
        } else {
          setAuthError('An unexpected error occurred');
        }
      }
    });
  };

  return (
    <Box component="form" onSubmit={handleSubmit(onSubmit)} noValidate>
      {authError && (
        <Alert severity="error" sx={{ mb: 3 }}>
          {authError}
        </Alert>
      )}

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
            autoComplete="email"
            error={!!errors.email}
            helperText={errors.email?.message}
          />
        )}
      />

      <PasswordInput
        name="password"
        control={control}
        label="Password"
        disabled={loginMutation.isPending}
      />

      <Box sx={{ mt: 1, mb: 3, display: 'flex', justifyContent: 'flex-end' }}>
        <Link component={RouterLink} to={ROUTES.FORGOT_PASSWORD} variant="body2" underline="hover">
          Forgot your password?
        </Link>
      </Box>

      <Button
        type="submit"
        fullWidth
        variant="contained"
        size="large"
        disabled={loginMutation.isPending}
        sx={{ mb: 3 }}
      >
        {loginMutation.isPending ? <CircularProgress size={24} color="inherit" /> : 'Log in'}
      </Button>

      <Box sx={{ textAlign: 'center' }}>
        <Link component={RouterLink} to={ROUTES.REGISTER} variant="body2" underline="hover">
          Don't have an account? Sign up
        </Link>
      </Box>
    </Box>
  );
}
