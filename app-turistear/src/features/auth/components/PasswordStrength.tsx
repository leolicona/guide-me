import Box from '@mui/material/Box'
import LinearProgress from '@mui/material/LinearProgress'
import Typography from '@mui/material/Typography'

function computeScore(password: string): number {
  let score = 0
  if (password.length >= 8) score++
  if (/[A-Z]/.test(password)) score++
  if (/[a-z]/.test(password)) score++
  if (/[0-9]/.test(password)) score++
  if (/[^A-Za-z0-9]/.test(password)) score++
  return score
}

interface PasswordStrengthProps {
  password: string
}

export function PasswordStrength({ password }: PasswordStrengthProps) {
  if (!password) return null

  const score = computeScore(password)
  const value = (score / 5) * 100

  let color: 'error' | 'warning' | 'success'
  let label: string

  if (score <= 2) {
    color = 'error'
    label = 'Débil'
  } else if (score <= 3) {
    color = 'warning'
    label = 'Regular'
  } else {
    color = 'success'
    label = 'Fuerte'
  }

  return (
    <Box sx={{ mt: 1 }}>
      <LinearProgress
        variant="determinate"
        value={value}
        color={color}
        sx={{ borderRadius: 4, height: 4 }}
      />
      <Typography variant="caption" color={`${color}.main`} sx={{ mt: 0.5, display: 'block' }}>
        {label}
      </Typography>
    </Box>
  )
}
