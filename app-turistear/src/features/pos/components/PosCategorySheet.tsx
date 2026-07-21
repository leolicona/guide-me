import { Box, Typography, Button, ButtonBase } from '@mui/material'
import { BottomSheet } from '../../../components'
import { filterChipSx } from '../../filters'
import { categoryLabel, type ServiceCategory } from '../../catalog/categories'

interface PosCategorySheetProps {
  open: boolean
  onClose: () => void
  /** US-A37 — only the categories present in the current catalog are worth offering. */
  categories: ServiceCategory[]
  /** The active multi-select set (empty = "Todas", no filter). */
  active: ServiceCategory[]
  onToggle: (c: ServiceCategory) => void
  onClear: () => void
}

// US-A37 — the category filter, lifted off the inline strip into a Bottom Sheet so the strip
// stays a tidy two-button row. Multi-select applies live (the catalog behind the sheet re-filters
// as chips toggle); "Listo" just dismisses. Chips reuse the strip's 48px `filterChipSx` for the
// same one-handed touch target, wrapped instead of scrolled.
export function PosCategorySheet({
  open,
  onClose,
  categories,
  active,
  onToggle,
  onClear,
}: PosCategorySheetProps) {
  const header = (
    <Box sx={{ px: 3, pt: 1, pb: 2 }}>
      <Typography sx={{ fontWeight: 600, fontSize: 17 }}>Categorías</Typography>
    </Box>
  )

  const footer = (
    <Box sx={{ px: 3, py: 2 }}>
      <Button fullWidth variant="contained" onClick={onClose}>
        Listo
      </Button>
    </Box>
  )

  return (
    <BottomSheet open={open} onClose={onClose} header={header} footer={footer}>
      <Box sx={{ px: 3, pb: 2, display: 'flex', flexWrap: 'wrap', gap: 1 }}>
        {/* "Todas" clears the filter; each category toggles independently. */}
        <ButtonBase onClick={onClear} sx={filterChipSx(active.length === 0)}>
          Todas
        </ButtonBase>
        {categories.map((c) => (
          <ButtonBase
            key={c}
            onClick={() => onToggle(c)}
            sx={filterChipSx(active.includes(c))}
          >
            {categoryLabel(c)}
          </ButtonBase>
        ))}
      </Box>
    </BottomSheet>
  )
}
