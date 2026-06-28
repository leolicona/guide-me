import type { SxProps, Theme } from '@mui/material/styles'

// A single floating circular control for the persistent top-right cluster: white paper, hairline
// border, soft overlay shadow (it floats over content), pill radius, ≥48px touch target. Shared
// by the account avatar and any page-injected action (e.g. the POS cart) so each reads as its own
// distinct circle rather than fusing into one chip. Structure-first per DESIGN_TOKENS §7/§9:
// hairline border carries structure, overlay-sm shadow is allowed because the cluster floats.
export const floatingControlSx = {
  width: 48,
  height: 48,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  borderRadius: '9999px',
  bgcolor: 'background.paper',
  border: '1px solid',
  borderColor: 'divider',
  boxShadow: 'var(--shadow-overlay-sm)',
} satisfies SxProps<Theme>
