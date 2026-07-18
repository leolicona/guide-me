import type { ReactNode } from 'react'
import { Card, CardContent, Box, Typography, Stack, Divider } from '@mui/material'
import { Link as RouterLink } from 'react-router-dom'

export interface ListRowProps {
  /** Row identity — rendered bold, truncated, and (when `titleTo`/`onTitleClick` is set) tappable. */
  title: string
  /** Navigate on title tap (detail page). Mutually exclusive with `onTitleClick`. */
  titleTo?: string
  /** Act on title tap when the entity has no detail page (e.g. agents → edit sheet). */
  onTitleClick?: () => void
  /** Subtitle lines / metadata under the title (Typography body2 nodes). */
  meta?: ReactNode
  /** Top-right corner control — the entity's ONE general-edit affordance (an IconButton).
   *  Rendered neutral (text.secondary): teal stays reserved for the status switch and the
   *  page's single primary CTA. */
  cornerAction?: ReactNode
  /** Chip row under the meta (category / capability tags). */
  tags?: ReactNode
  /** Footer LEFT cluster: type-specific quick-edit shortcuts (text buttons). A Button left at
   *  its default color is de-emphasized to a neutral tone (see the footer `sx` below) — pass an
   *  explicit semantic `color` (e.g. "error") only for a genuinely destructive action. */
  footerActions?: ReactNode
  /** Footer RIGHT cluster: the estado switch (and e.g. Eliminar beside it when applicable). */
  footerStatus?: ReactNode
  /** Dims the whole card (inactive/suspended entities). */
  inactive?: boolean
}

// One title style for all three variants (link / button / plain). `display: block` is what lets
// noWrap's ellipsis work — on an inline element a long title overflows the card instead of
// truncating (375px). The button-reset keys are harmless on the link/plain variants.
const titleSx = {
  display: 'block',
  maxWidth: '100%',
  fontFamily: 'inherit',
  fontWeight: 600,
  fontSize: '1rem',
  lineHeight: 1.5,
  textAlign: 'left',
  color: 'text.primary',
  bgcolor: 'transparent',
  border: 0,
  p: 0,
  textDecoration: 'none',
} as const

const interactiveTitleSx = {
  ...titleSx,
  cursor: 'pointer',
  WebkitTapHighlightColor: 'transparent',
  // Reach: pad the hit area to ~48px and cancel it with margin so the layout doesn't shift.
  py: 1.5,
  my: -1.5,
  '&:hover': { textDecoration: 'underline' },
  // Keyboard affordance — the system's teal focus bloom (same token as inputs).
  '&:focus-visible': {
    outline: 'none',
    boxShadow: 'var(--shadow-focus, 0 0 0 3px rgba(15, 118, 110, 0.28))',
    borderRadius: 'var(--radius-sm, 8px)',
    textDecoration: 'underline',
  },
} as const

/**
 * The standard entity list row (Elegant Field Minimalism), shared by the Catálogo / Agentes /
 * Afiliados lists so every list in the system reads and behaves identically. One stacked
 * anatomy at every width:
 *
 *   Title (tappable)            [✎]   ← identity + the corner general-edit control
 *   meta line(s)
 *   (tag) (tag)                       ← optional chip row
 *   ─────────────────────────────
 *   [quick actions]    Activo ⬤──    ← footer: shortcuts left · status right
 *
 * Explicit controls only — no CardActionArea, so nested controls stay independently tappable.
 */
export function ListRow({
  title,
  titleTo,
  onTitleClick,
  meta,
  cornerAction,
  tags,
  footerActions,
  footerStatus,
  inactive,
}: ListRowProps) {
  const hasFooter = Boolean(footerActions || footerStatus)

  return (
    <Card sx={{ opacity: inactive ? 0.6 : 1, transition: 'opacity 160ms ease' }}>
      <CardContent>
        {/* Header: identity left, corner control right. */}
        <Box sx={{ display: 'flex', gap: 1.5, alignItems: 'flex-start' }}>
          <Box sx={{ flex: 1, minWidth: 0 }}>
            {titleTo ? (
              <Typography component={RouterLink} to={titleTo} sx={interactiveTitleSx} noWrap>
                {title}
              </Typography>
            ) : onTitleClick ? (
              <Typography
                component="button"
                type="button"
                onClick={onTitleClick}
                sx={interactiveTitleSx}
                noWrap
              >
                {title}
              </Typography>
            ) : (
              <Typography sx={titleSx} noWrap>
                {title}
              </Typography>
            )}
            {meta}
          </Box>

          {cornerAction && (
            <Box
              sx={{
                flexShrink: 0,
                // Pull the (≥44px) icon button toward the card corner so its GLYPH sits on the
                // content edge without inflating the card's padding.
                mt: -1,
                mr: -1,
                '& .MuiIconButton-root': { color: 'text.secondary' },
              }}
            >
              {cornerAction}
            </Box>
          )}
        </Box>

        {tags && (
          <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap', mt: 1 }}>
            {tags}
          </Stack>
        )}

        {hasFooter && (
          <>
            <Divider sx={{ mt: 1.5, mb: 0.5 }} />
            <Box
              sx={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                flexWrap: 'wrap',
                columnGap: 1,
                rowGap: 0.5,
                // Field-usable touch targets on mobile (≥44px); compact on desktop.
                '& .MuiButton-root': { minHeight: { xs: 44, sm: 32 } },
                // Hierarchy (one-confident-accent law, theme.ts): teal is reserved for the
                // row's true selected/interactive-state control (the status Switch) and the
                // page's one primary CTA — never for a repeated-per-row utility shortcut.
                // MUI's default Button color is "primary", which this theme maps to teal, so
                // an unstyled action Button here is de-emphasized to a neutral tone. Buttons
                // that opt into an explicit semantic color (e.g. color="error" on Eliminar)
                // are untouched — this only targets the *default*-color text-button classes.
                // (MUI v6 dropped the old `MuiButton-textPrimary` combo class — the color is
                // carried by `MuiButton-colorPrimary` alongside the `MuiButton-text` variant.)
                '& .MuiButton-text.MuiButton-colorPrimary, & .MuiButton-text.MuiButton-colorSecondary':
                  {
                    color: 'text.secondary',
                  },
              }}
            >
              <Stack direction="row" spacing={0.5} useFlexGap sx={{ flexWrap: 'wrap', alignItems: 'center' }}>
                {footerActions}
              </Stack>
              <Stack
                direction="row"
                spacing={1}
                useFlexGap
                sx={{ flexWrap: 'wrap', alignItems: 'center', ml: 'auto' }}
              >
                {footerStatus}
              </Stack>
            </Box>
          </>
        )}
      </CardContent>
    </Card>
  )
}
