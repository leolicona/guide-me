import { useState } from 'react';
import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Alert, TextField, Button, Box, CircularProgress } from '@mui/material';
import { inviteCompleteSchema } from '../schemas';
import type { InviteCompleteFormData } from '../schemas';
import { useInviteComplete } from '../hooks/useInviteComplete';
import { ServiceError } from '../../../services/authService';
import { EmailCodeForm } from './EmailCodeForm';

const SUBMIT = 'Aceptar invitación';

/**
 * An invited agent joins with their name (passkey-auth US4, FR-031) — no password. Accepting
 * creates the agent and mails a sign-in code to the invited address (D11); the code step follows
 * here, then the offer of a llave de acceso.
 */
export function InviteCompleteForm({ token }: { token: string }) {
  const [codeSentTo, setCodeSentTo] = useState<string | null>(null);
  const inviteCompleteMutation = useInviteComplete();

  const { control, handleSubmit, setError, formState: { errors } } = useForm<InviteCompleteFormData>({
    resolver: zodResolver(inviteCompleteSchema),
    defaultValues: { name: '' }
  });

  const onSubmit = (data: InviteCompleteFormData) => {
    inviteCompleteMutation.mutate(
      { token, name: data.name },
      {
        onSuccess: ({ email }) => {
          setCodeSentTo(email);
        },
        onError: (error) => {
          if (error instanceof ServiceError && error.status === 409) {
            setError('root', {
              type: 'manual',
              message: 'Ya existe una cuenta con este correo. Entra con tu llave de acceso o con un código por correo.',
            });
          } else if (error instanceof ServiceError && error.status === 400) {
            setError('root', { type: 'manual', message: 'La invitación es inválida o ha expirado. Contacta a tu administrador.' });
          } else {
            setError('root', { type: 'manual', message: 'No pudimos aceptar la invitación. Inténtalo de nuevo.' });
          }
        }
      }
    );
  };

  if (codeSentTo) {
    return <EmailCodeForm codeSentTo={codeSentTo} />;
  }

  const isLoading = inviteCompleteMutation.isPending;

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
            helperText={errors.name?.message ?? 'Te enviaremos un código al correo de la invitación.'}
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
        sx={{ mt: 3, mb: 1 }}
      >
        {isLoading ? <CircularProgress size={24} color="inherit" aria-hidden /> : SUBMIT}
      </Button>
    </Box>
  );
}
