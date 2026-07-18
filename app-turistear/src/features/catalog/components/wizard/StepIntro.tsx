import { Box, Typography } from '@mui/material'

/** A short, muted lead-in at the top of each wizard step — keeps the body breathable and
 * tells the operator what this step is for without crowding the fixed header. */
export function StepIntro({
  title,
  subtitle,
}: {
  title: string
  subtitle: string
}) {
  return (
    <Box>
      <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
        {title}
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
        {subtitle}
      </Typography>
    </Box>
  )
}
