import { useMutation } from '@tanstack/react-query'
import { register, type RegisterInput } from '../../../services/authService'

export function useRegister() {
  return useMutation({
    mutationFn: (data: RegisterInput) => register(data),
  })
}
