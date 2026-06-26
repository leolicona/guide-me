import { type ReactNode } from 'react'
import Box from '@mui/material/Box'
import Container from '@mui/material/Container'
import Card from '@mui/material/Card'
import CardContent from '@mui/material/CardContent'
import Typography from '@mui/material/Typography'
import Fade from '@mui/material/Fade'

interface AuthLayoutProps {
  children: ReactNode
  title?: string
  footer?: ReactNode
}

export function AuthLayout({ children, title, footer }: AuthLayoutProps) {
  return (
    <Box
      sx={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        bgcolor: 'background.default',
        py: 4,
      }}
    >
      <Container maxWidth="sm">
        <Fade in timeout={400}>
          <Box>
            <Box sx={{ mb: 4, textAlign: 'center' }}>
              <Typography
                variant="h5"
                color="primary"
                sx={{ fontWeight: 700, letterSpacing: -0.5 }}
              >
                GuideMe
              </Typography>
              {title && (
                <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
                  {title}
                </Typography>
              )}
            </Box>
            {/* Structure-first: hairline border, no shadow (elevation 0), container radius. */}
            <Card
              elevation={0}
              sx={{
                border: '1px solid',
                borderColor: 'divider',
                borderRadius: 'var(--radius-lg, 16px)',
              }}
            >
              <CardContent sx={{ p: 4, '&:last-child': { pb: 4 } }}>
                {children}
              </CardContent>
            </Card>
            {footer && (
              <Box sx={{ mt: 3, textAlign: 'center' }}>{footer}</Box>
            )}
          </Box>
        </Fade>
      </Container>
    </Box>
  )
}

export default AuthLayout
