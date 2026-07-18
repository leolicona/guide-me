import { useMutation } from '@tanstack/react-query'
import { resetPassword, type ResetPasswordInput } from '../../../services/authService'

export function useResetPassword() {
  return useMutation({
    mutationFn: (data: ResetPasswordInput) => resetPassword(data),
  })
}
