import { Typography } from '@mui/material'
import type { TypographyProps } from '@mui/material'

const mxn = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' })

/** minor units (150000) → "$1,500.00". Self-contained so the shared layer stays feature-free. */
function formatCents(cents: number): string {
  return mxn.format(cents / 100)
}

type MoneySemantic = 'neutral' | 'positive' | 'negative'

export interface MoneyTextProps extends Omit<TypographyProps, 'children' | 'color'> {
  /** Amount in minor units (cents). */
  cents: number
  /**
   * Color semantics — NEVER teal (money is meaning, the accent is action):
   * neutral = ink, positive = success green, negative/owed = error red.
   * Pass an explicit semantic, or set `signed` to derive from the sign.
   */
  semantic?: MoneySemantic
  /** If true, derive semantic from the sign (>=0 positive, <0 negative). Default false → neutral. */
  signed?: boolean
  /** Show the absolute value (e.g. a debt rendered as a magnitude). */
  absolute?: boolean
  /** Accessible label, e.g. "Saldo a entregar". Announced with the amount for screen readers. */
  srLabel?: string
}

const SEMANTIC_COLOR: Record<MoneySemantic, string> = {
  neutral: 'text.primary',
  positive: 'success.main',
  negative: 'error.main',
}

/**
 * The system's signature element: financial figures in tabular-lining Manrope so digits align
 * and don't jitter as values change. Money reads first. Defaults to a prominent display size;
 * override via `variant` for inline/secondary figures.
 */
export function MoneyText({
  cents,
  semantic,
  signed = false,
  absolute = false,
  srLabel,
  variant = 'h2',
  sx,
  ...rest
}: MoneyTextProps) {
  const resolved: MoneySemantic = semantic ?? (signed ? (cents >= 0 ? 'positive' : 'negative') : 'neutral')
  const value = absolute ? Math.abs(cents) : cents
  const display = formatCents(value)

  return (
    <Typography
      component="span"
      variant={variant}
      className="numeric"
      sx={{ fontWeight: 700, color: SEMANTIC_COLOR[resolved], ...sx }}
      aria-label={srLabel ? `${srLabel}: ${display}` : undefined}
      {...rest}
    >
      {display}
    </Typography>
  )
}
