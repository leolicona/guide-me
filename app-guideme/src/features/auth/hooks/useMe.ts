import { useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { getMe } from '../../../services/authService'
import { useAuthStore } from '../../../store/authStore'

export function useMe() {
  const setUser = useAuthStore((s) => s.setUser)
  const clear = useAuthStore((s) => s.clear)

  const query = useQuery({
    queryKey: ['me'],
    queryFn: getMe,
    staleTime: 5 * 60 * 1000,
    retry: false,
  })

  useEffect(() => {
    if (query.data) {
      setUser(query.data)
    }
  }, [query.data, setUser])

  useEffect(() => {
    if (query.isError) {
      clear()
    }
  }, [query.isError, clear])

  return query
}
