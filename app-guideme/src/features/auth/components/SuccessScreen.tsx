import { type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import Box from '@mui/material/Box'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import Button from '@mui/material/Button'

interface SuccessAction {
  label: string
  href?: string
  onClick?: () => void
}

interface SuccessScreenProps {
  icon: ReactNode
  title: string
  description: string
  action?: SuccessAction
}

export function SuccessScreen({ icon, title, description, action }: SuccessScreenProps) {
  const navigate = useNavigate()

  const handleAction = () => {
    if (action?.onClick) {
      action.onClick()
    } else if (action?.href) {
      navigate(action.href)
    }
  }

  return (
    <Stack spacing={2} sx={{ py: 2, alignItems: 'center', textAlign: 'center' }}>
      <Box sx={{ fontSize: 56, lineHeight: 1, color: 'primary.main', display: 'flex' }}>
        {icon}
      </Box>
      <Typography variant="h6" sx={{ fontWeight: 600 }}>
        {title}
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ maxWidth: 320 }}>
        {description}
      </Typography>
      {action && (
        <Button
          variant="contained"
          disableElevation
          onClick={handleAction}
          sx={{ mt: 1 }}
        >
          {action.label}
        </Button>
      )}
    </Stack>
  )
}
