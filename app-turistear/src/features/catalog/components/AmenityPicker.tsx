import { Box, Chip, Typography } from '@mui/material'
import CheckRounded from '@mui/icons-material/CheckRounded'
import { AMENITY_OPTIONS, type AmenityKey } from '../lodging'

interface AmenityPickerProps {
  value: AmenityKey[]
  onChange: (value: AmenityKey[]) => void
  disabled?: boolean
}

// A wrap-flow of selectable amenity chips. Selection is the one place chips may use the teal
// accent (selection = teal, per the design system): selected = teal-50 surface + teal-700 text
// + check icon. Chips are aria-pressed toggle buttons for screen readers.
export function AmenityPicker({ value, onChange, disabled }: AmenityPickerProps) {
  const toggle = (key: AmenityKey) =>
    onChange(value.includes(key) ? value.filter((k) => k !== key) : [...value, key])

  return (
    <Box>
      <Typography variant="subtitle2" color="text.secondary" sx={{ mb: 1 }}>
        Amenidades
      </Typography>
      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
        {AMENITY_OPTIONS.map((opt) => {
          const selected = value.includes(opt.value)
          return (
            <Chip
              key={opt.value}
              label={opt.label}
              clickable={!disabled}
              disabled={disabled}
              onClick={() => toggle(opt.value)}
              icon={selected ? <CheckRounded /> : undefined}
              aria-pressed={selected}
              sx={{
                height: 40,
                borderRadius: 'var(--radius-full, 9999px)',
                fontWeight: 600,
                border: '1px solid',
                borderColor: selected ? 'var(--teal-700, #0F766E)' : 'var(--slate-300, #CBD5E1)',
                backgroundColor: selected ? 'var(--teal-50, #F0FDFA)' : 'transparent',
                color: selected ? 'var(--teal-700, #0F766E)' : 'text.secondary',
                '& .MuiChip-icon': { color: 'var(--teal-700, #0F766E)' },
                '&:hover': {
                  backgroundColor: selected ? 'var(--teal-50, #F0FDFA)' : 'var(--slate-100, #F1F5F9)',
                },
              }}
            />
          )
        })}
      </Box>
    </Box>
  )
}
