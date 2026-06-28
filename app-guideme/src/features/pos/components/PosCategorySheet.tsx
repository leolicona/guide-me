import { Box, Typography } from '@mui/material'
import { alpha } from '@mui/material/styles'
import { BottomSheet } from '../../../components'
import {
  SERVICE_CATEGORIES,
  categoryLabel,
  type ServiceCategory,
} from '../../catalog/categories'

interface PosCategorySheetProps {
  open: boolean
  onClose: () => void
  activeCategory: ServiceCategory | null
  onPick: (category: ServiceCategory | null) => void
}

const ALL_OPTIONS = [null, ...SERVICE_CATEGORIES] as const

export function PosCategorySheet({
  open,
  onClose,
  activeCategory,
  onPick,
}: PosCategorySheetProps) {
  return (
    <BottomSheet open={open} onClose={onClose}>
      <Box sx={{ px: 3, pb: 3 }}>
        <Typography sx={{ fontWeight: 600, fontSize: 17, mb: 2 }}>
          Categoría
        </Typography>
        <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 1 }}>
          {ALL_OPTIONS.map((cat) => {
            const isSelected = cat === activeCategory
            const label = cat === null ? 'Todos' : categoryLabel(cat)
            return (
              <Box
                key={cat ?? 'todos'}
                component="button"
                type="button"
                onClick={() => {
                  onPick(cat)
                  onClose()
                }}
                sx={{
                  appearance: 'none',
                  font: 'inherit',
                  cursor: 'pointer',
                  aspectRatio: '1 / 1',
                  borderRadius: 2,
                  border: '1px solid',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  textAlign: 'center',
                  px: 1,
                  fontSize: 13,
                  fontWeight: isSelected ? 700 : 500,
                  lineHeight: 1.3,
                  transition: 'background-color 160ms ease, color 160ms ease',
                  color: isSelected ? 'primary.contrastText' : 'text.primary',
                  bgcolor: isSelected ? 'primary.main' : 'background.paper',
                  borderColor: isSelected ? 'transparent' : 'divider',
                  '&:hover': {
                    bgcolor: (t) =>
                      isSelected
                        ? t.palette.primary.main
                        : alpha(t.palette.primary.main, 0.08),
                  },
                }}
              >
                {label}
              </Box>
            )
          })}
        </Box>
      </Box>
    </BottomSheet>
  )
}
