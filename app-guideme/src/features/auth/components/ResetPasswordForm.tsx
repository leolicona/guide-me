import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Button, Box, CircularProgress } from '@mui/material';
import { CheckCircle, ErrorOutlined } from '@mui/icons-material';
import { resetPasswordSchema } from '../schemas';
import type { ResetPasswordFormData } from '../schemas';
import { useResetPassword } from '../hooks/useResetPassword';
import { ROUTES } from '../../../config/routes';
import { ServiceError } from '../../../services/authService';
import { PasswordInput } from './PasswordInput';
import { SuccessScreen } from './SuccessScreen';

export function ResetPasswordForm({ token }: { token: string }) {
  const [isSuccess, setIsSuccess] = useState(false);
  const [isInvalidToken, setIsInvalidToken] = useState(false);
  const resetPasswordMutation = useResetPassword();

  const { control, handleSubmit } = useForm<ResetPasswordFormData>({
    resolver: zodResolver(resetPasswordSchema),
    defaultValues: { password: '', confirmPassword: '' }
  });

  const onSubmit = (data: ResetPasswordFormData) => {
    resetPasswordMutation.mutate({ token, password: data.password }, {
      onSuccess: () => {
        setIsSuccess(true);
      },
      onError: (error) => {
        if (error instanceof ServiceError && error.status === 400) {
          setIsInvalidToken(true);
        }
      }
    });
  };

  if (isSuccess) {
    return (
      <SuccessScreen
        icon={<CheckCircle sx={{ fontSize: 64 }} color="success" />}
        title="Contraseña actualizada"
        description="Tu contraseña fue actualizada exitosamente."
        action={{ label: 'Iniciar sesión', href: ROUTES.LOGIN }}
      />
    );
  }

  if (isInvalidToken) {
    return (
      <SuccessScreen
        icon={<ErrorOutlined sx={{ fontSize: 64 }} color="error" />}
        title="Error al recuperar"
        description="El enlace es inválido o ha expirado."
        action={{ label: 'Solicitar nuevo enlace', href: ROUTES.FORGOT_PASSWORD }}
      />
    );
  }

  return (
    <Box component="form" onSubmit={handleSubmit(onSubmit)} noValidate>
      <PasswordInput
        name="password"
        control={control}
        label="Nueva contraseña"
        disabled={resetPasswordMutation.isPending}
      />

      <PasswordInput
        name="confirmPassword"
        control={control}
        label="Confirmar contraseña"
        disabled={resetPasswordMutation.isPending}
      />

      <Button
        type="submit"
        fullWidth
        variant="contained"
        size="large"
        disabled={resetPasswordMutation.isPending}
        sx={{ mt: 3, mb: 1 }}
      >
        {resetPasswordMutation.isPending ? <CircularProgress size={24} color="inherit" /> : 'Actualizar contraseña'}
      </Button>
    </Box>
  );
}
