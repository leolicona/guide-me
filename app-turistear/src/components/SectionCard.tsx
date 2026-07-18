import { Card, CardContent, Box, Typography } from '@mui/material'
import type { CardProps } from '@mui/material'
import type { ReactNode } from 'react'

export interface SectionCardProps extends Omit<CardProps, 'title'> {
  /** Optional section title rendered at the top of the card. */
  title?: ReactNode
  /** Optional element pinned to the top-right of the header row (e.g. an action or status chip). */
  action?: ReactNode
  /** When false, drops the generous 24px CardContent padding (e.g. for full-bleed list rows). */
  padded?: boolean
  children: ReactNode
}

/**
 * The default surface container (Elegant Field Minimalism): white, hairline border, 16px radius,
 * generous 24px padding, and — by design — NO resting shadow. Structure comes from the border,
 * which reads in any light. Replaces ad-hoc Card/Paper usage across features.
 */
export function SectionCard({ title, action, padded = true, children, sx, ...rest }: SectionCardProps) {
  return (
    <Card sx={{ borderRadius: 'var(--radius-lg, 16px)', ...sx }} {...rest}>
      <CardContent sx={padded ? undefined : { p: 0, '&:last-child': { pb: 0 } }}>
        {(title || action) && (
          <Box
            sx={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 2,
              mb: title ? 2 : 0,
            }}
          >
            {typeof title === 'string' ? (
              <Typography variant="h3" sx={{ fontWeight: 600 }}>
                {title}
              </Typography>
            ) : (
              title
            )}
            {action}
          </Box>
        )}
        {children}
      </CardContent>
    </Card>
  )
}
