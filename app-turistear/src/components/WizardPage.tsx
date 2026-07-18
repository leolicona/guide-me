import { Box } from '@mui/material'
import { WizardChrome, type WizardChromeProps } from './WizardShell'

export type WizardPageProps = WizardChromeProps

/**
 * The multi-step full-page host: `WizardChrome` on a route of its own (no nav shell) — an
 * immersive full-viewport surface on mobile, a centered card with a hairline border on desktop.
 * Per the design system it is a resting surface, not an overlay, so no shadow. Used by the
 * Service Creation wizard (US-A38–A44) at /catalog/new.
 */
export function WizardPage(props: WizardPageProps) {
  return (
    <Box
      sx={{
        minHeight: '100dvh',
        bgcolor: 'background.default',
        display: 'flex',
        justifyContent: 'center',
        alignItems: { xs: 'stretch', sm: 'center' },
        py: { xs: 0, sm: 3 },
      }}
    >
      <Box
        sx={{
          width: '100%',
          maxWidth: { sm: 640 },
          height: { xs: '100dvh', sm: 'min(88vh, 860px)' },
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          bgcolor: 'background.paper',
          border: { xs: 'none', sm: '1px solid' },
          borderColor: { sm: 'divider' },
          borderRadius: { xs: 0, sm: 'var(--radius-lg, 16px)' },
        }}
      >
        <WizardChrome {...props} />
      </Box>
    </Box>
  )
}
