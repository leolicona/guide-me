import { useState } from 'react';
import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { TextField, Button, Box, CircularProgress, Link } from '@mui/material';
import { Link as RouterLink } from 'react-router-dom';
import { Email } from '@mui/icons-material';
import { forgotPasswordSchema } from '../schemas';
import type { ForgotPasswordFormData } from '../schemas';
import { useForgotPassword } from '../hooks/useForgotPassword';
import { ROUTES } from '../../../config/routes';
import { SuccessScreen } from './SuccessScreen';

export function ForgotPasswordForm() {
  const [isSuccess, setIsSuccess] = useState(false);
  const forgotPasswordMutation = useForgotPassword();

  const { control, handleSubmit, formState: { errors } } = useForm<ForgotPasswordFormData>({
    resolver: zodResolver(forgotPasswordSchema),
    defaultValues: { email: '' }
  });

  const onSubmit = (data: ForgotPasswordFormData) => {
    forgotPasswordMutation.mutate(data.email, {
      onSettled: () => {
        setIsSuccess(true);
      }
    });
  };

  if (isSuccess) {
    return (
      <SuccessScreen
        icon={<Email sx={{ fontSize: 64 }} />}
        title="Revisa tu email"
        description="Si el email está registrado, recibirás instrucciones para recuperar tu contraseña."
      />
    );
  }

  return (
    <Box component="form" onSubmit={handleSubmit(onSubmit)} noValidate>
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
            disabled={forgotPasswordMutation.isPending}
            error={!!errors.email}
            helperText={errors.email?.message}
          />
        )}
      />

      <Button
        type="submit"
        fullWidth
        variant="contained"
        size="large"
        disabled={forgotPasswordMutation.isPending}
        sx={{ mt: 3, mb: 3 }}
      >
        {forgotPasswordMutation.isPending ? <CircularProgress size={24} color="inherit" /> : 'Enviar enlace de recuperación'}
      </Button>

      <Box sx={{ textAlign: 'center' }}>
        <Link component={RouterLink} to={ROUTES.LOGIN} variant="body2" underline="hover">
          Volver al inicio de sesión
        </Link>
      </Box>
    </Box>
  );
}
