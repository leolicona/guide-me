import { useMutation } from '@tanstack/react-query'
import { login, type LoginInput } from '../../../services/authService'

export function useLogin() {
  return useMutation({
    mutationFn: (data: LoginInput) => login(data),
  })
}
