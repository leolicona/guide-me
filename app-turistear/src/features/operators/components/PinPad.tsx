import { Box, ButtonBase, Stack } from '@mui/material'
import BackspaceRounded from '@mui/icons-material/BackspaceRounded'

// US-OP01/OP02 — the field-ergonomic 4-digit PIN entry. Big numeric targets (≥64px), sunlight-
// legible, one confident accent only on the filled dots. No text keyboard (design-system: outdoor,
// one-handed). Controlled: the parent owns the digit string and reacts to it reaching `length`.

interface PinPadProps {
  value: string
  onChange: (next: string) => void
  length?: number
  disabled?: boolean
  /** Shake/clear signal handled by the parent; here we just render the dots + keys. */
  error?: boolean
}

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9']

export function PinPad({ value, onChange, length = 4, disabled = false, error = false }: PinPadProps) {
  const press = (digit: string) => {
    if (disabled || value.length >= length) return
    onChange(value + digit)
  }
  const backspace = () => {
    if (disabled || value.length === 0) return
    onChange(value.slice(0, -1))
  }

  return (
    <Stack spacing={4} sx={{ alignItems: 'center', width: '100%' }}>
      {/* Filled dots */}
      <Stack direction="row" spacing={2.5} aria-hidden>
        {Array.from({ length }).map((_, i) => {
          const filled = i < value.length
          return (
            <Box
              key={i}
              sx={{
                width: 18,
                height: 18,
                borderRadius: '50%',
                transition: 'background-color 120ms ease, border-color 120ms ease',
                border: '2px solid',
                borderColor: error ? 'error.main' : filled ? 'secondary.main' : 'grey.400',
                bgcolor: filled ? (error ? 'error.main' : 'secondary.main') : 'transparent',
              }}
            />
          )
        })}
      </Stack>

      {/* Keypad */}
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: 'repeat(3, 1fr)',
          gap: 1.5,
          width: '100%',
          maxWidth: 300,
        }}
      >
        {KEYS.map((k) => (
          <ButtonBase
            key={k}
            onClick={() => press(k)}
            disabled={disabled}
            aria-label={k}
            sx={{
              height: 72,
              borderRadius: 'var(--radius-md, 12px)',
              fontSize: 28,
              fontWeight: 600,
              color: 'text.primary',
              border: '1px solid',
              borderColor: 'grey.300',
              transition: 'background-color 120ms ease, transform 80ms ease',
              '&:hover': { bgcolor: 'action.hover' },
              '&:active': { transform: 'scale(0.97)' },
              '&.Mui-disabled': { opacity: 0.5 },
            }}
          >
            {k}
          </ButtonBase>
        ))}
        {/* Spacer · 0 · backspace */}
        <Box />
        <ButtonBase
          onClick={() => press('0')}
          disabled={disabled}
          aria-label="0"
          sx={{
            height: 72,
            borderRadius: 'var(--radius-md, 12px)',
            fontSize: 28,
            fontWeight: 600,
            color: 'text.primary',
            border: '1px solid',
            borderColor: 'grey.300',
            transition: 'background-color 120ms ease, transform 80ms ease',
            '&:hover': { bgcolor: 'action.hover' },
            '&:active': { transform: 'scale(0.97)' },
            '&.Mui-disabled': { opacity: 0.5 },
          }}
        >
          0
        </ButtonBase>
        <ButtonBase
          onClick={backspace}
          disabled={disabled || value.length === 0}
          aria-label="Borrar"
          sx={{
            height: 72,
            borderRadius: 'var(--radius-md, 12px)',
            color: 'text.secondary',
            '&:active': { transform: 'scale(0.97)' },
            '&.Mui-disabled': { opacity: 0.4 },
          }}
        >
          <BackspaceRounded />
        </ButtonBase>
      </Box>
    </Stack>
  )
}
