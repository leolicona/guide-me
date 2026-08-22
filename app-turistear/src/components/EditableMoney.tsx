import { useState } from 'react'
import { TextField, useTheme } from '@mui/material'
import type { TypographyProps } from '@mui/material'
import { MoneyText } from './MoneyText'
import { formatCents } from './money'

export interface EditableMoneyProps {
  /** Current amount, minor units. */
  cents: number
  /** Inclusive bounds, minor units. When `min >= max` the control degrades to a plain MoneyText. */
  min: number
  max: number
  /** Called with the clamped amount when the edit commits (blur). Never called mid-keystroke. */
  onCommit: (cents: number) => void
  /** Field label ("Total", "Precio unitario"). */
  label: string
  /** What the upper bound is called in the helper — "base" for a tour, "cotizado" for a stay. */
  maxLabel: string
  /** Accessible name, e.g. "Total de la estancia". */
  srLabel: string
  /** Typography scale, shared with MoneyText so the two read as one element. */
  variant?: TypographyProps['variant']
  disabled?: boolean
}

/**
 * The editable twin of `MoneyText` — the same figure, in the same tabular Manrope, that happens to
 * accept a new value. At rest it renders "$1,200.00"; on focus it drops to the raw major-unit
 * number so a thumb can retype it without fighting separators; on blur it clamps into
 * `[min, max]`, commits, and reformats. There is no "$" adornment: the formatting already says it.
 *
 * When `min >= max` the amount cannot move, so the border disappears and this IS a `MoneyText` —
 * a control that can only ever reject the agent's input is noise on a counter. The border is the
 * whole signal: it means "this can be negotiated".
 *
 * Money is never teal (`DESIGN_TOKENS.md`) — the accent belongs to action; the error state below
 * is the one exception the system already makes for an invalid control.
 */
export function EditableMoney({
  cents,
  min,
  max,
  onCommit,
  label,
  maxLabel,
  srLabel,
  variant = 'subtitle2',
  disabled = false,
}: EditableMoneyProps) {
  const theme = useTheme()
  // `null` ⇒ not editing, so the input shows the formatted figure. A string ⇒ the agent's raw
  // keystrokes, held locally so the clamp does not fight them until they are done.
  const [draft, setDraft] = useState<string | null>(null)

  if (min >= max) {
    return <MoneyText cents={cents} variant={variant} srLabel={srLabel} />
  }

  const parsed = draft === null || draft.trim() === '' ? NaN : Math.round(Number(draft) * 100)
  const belowMin = parsed < min
  const aboveMax = parsed > max
  const invalid = draft !== null && draft !== '' && (Number.isNaN(parsed) || belowMin || aboveMax)

  const commit = () => {
    const next = Number.isNaN(parsed) ? cents : Math.min(Math.max(parsed, min), max)
    onCommit(next)
    setDraft(null)
  }

  return (
    <TextField
      label={label}
      value={draft ?? formatCents(cents)}
      onFocus={() => setDraft(String(cents / 100))}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      disabled={disabled}
      error={invalid}
      helperText={
        belowMin
          ? `Mínimo ${formatCents(min)}`
          : aboveMax
            ? `Máximo ${formatCents(max)}`
            : `Mín ${formatCents(min)} · ${maxLabel} ${formatCents(max)}`
      }
      slotProps={{
        inputLabel: { shrink: true },
        htmlInput: {
          // `text`, not `number`: a number input cannot render "$1,200.00" at rest. The numeric
          // keypad still comes up on a phone via inputMode.
          inputMode: 'decimal',
          'aria-label': srLabel,
          style: { textAlign: 'right' },
        },
      }}
      sx={{
        width: 160,
        // The figure itself reads as money — same scale, same tabular lining, same 700 as
        // MoneyText — so the bordered and borderless states are one element with and without
        // an affordance.
        '& .MuiInputBase-input': {
          ...theme.typography[variant as 'subtitle2'],
          fontWeight: 700,
          fontVariantNumeric: 'tabular-nums lining-nums',
        },
      }}
    />
  )
}
