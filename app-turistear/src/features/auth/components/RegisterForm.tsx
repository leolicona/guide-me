import { useState } from 'react';
import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Alert, TextField, Button, Box, CircularProgress, Link } from '@mui/material';
import { Link as RouterLink } from 'react-router-dom';
import { registerSchema } from '../schemas';
import type { RegisterFormData } from '../schemas';
import { useRegister } from '../hooks/useRegister';
import { ROUTES } from '../../../config/routes';
import { ServiceError } from '../../../services/authService';
import { EmailCodeForm } from './EmailCodeForm';

const SUBMIT = 'Registrarse';

/**
 * A new admin registers an organization (passkey-auth US3, FR-030): name, email, company and phone —
 * no password. The API creates the organization and its admin and mails a sign-in code (D10); the
 * code step follows here, and entering it verifies the address and signs the admin in.
 */
export function RegisterForm() {
  const [registeredEmail, setRegisteredEmail] = useState<string | null>(null);
  const registerMutation = useRegister();

  const { control, handleSubmit, setError, formState: { errors } } = useForm<RegisterFormData>({
    resolver: zodResolver(registerSchema),
    defaultValues: { name: '', email: '', company_name: '', phone: '' }
  });

  const onSubmit = (data: RegisterFormData) => {
    registerMutation.mutate(data, {
      onSuccess: () => {
        setRegisteredEmail(data.email);
      },
      onError: (error) => {
        if (error instanceof ServiceError) {
          if (error.status === 409) {
            setError('email', { type: 'manual', message: 'Este correo ya está registrado' });
          } else if (error.status === 400) {
            setError('root', { type: 'manual', message: 'Los datos proporcionados son inválidos' });
          }
        }
      }
    });
  };

  if (registeredEmail) {
    return <EmailCodeForm codeSentTo={registeredEmail} />;
  }

  const isLoading = registerMutation.isPending;

  return (
    <Box component="form" onSubmit={handleSubmit(onSubmit)} noValidate>
      {errors.root && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {errors.root.message}
        </Alert>
      )}

      <Controller
        name="name"
        control={control}
        render={({ field }) => (
          <TextField
            {...field}
            inputRef={field.ref}
            fullWidth
            label="Nombre"
            margin="normal"
            autoComplete="name"
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
            inputRef={field.ref}
            fullWidth
            label="Correo electrónico"
            type="email"
            margin="normal"
            autoComplete="email"
            disabled={isLoading}
            error={!!errors.email}
            helperText={errors.email?.message ?? 'Ahí te enviaremos un código para entrar.'}
          />
        )}
      />

      <Controller
        name="company_name"
        control={control}
        render={({ field }) => (
          <TextField
            {...field}
            inputRef={field.ref}
            fullWidth
            label="Nombre de la empresa"
            margin="normal"
            autoComplete="organization"
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
            inputRef={field.ref}
            fullWidth
            label="Teléfono"
            type="tel"
            margin="normal"
            autoComplete="tel"
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
        // BUG-022 (as in FormSheet) — the spinner replaces the label, so the name is stated.
        aria-label={isLoading ? SUBMIT : undefined}
        aria-busy={isLoading}
        sx={{ mt: 3, mb: 3 }}
      >
        {isLoading ? <CircularProgress size={24} color="inherit" aria-hidden /> : SUBMIT}
      </Button>

      <Box sx={{ textAlign: 'center' }}>
        <Link component={RouterLink} to={ROUTES.LOGIN} variant="body2" underline="hover">
          ¿Ya tienes cuenta? Inicia sesión
        </Link>
      </Box>
    </Box>
  );
}
