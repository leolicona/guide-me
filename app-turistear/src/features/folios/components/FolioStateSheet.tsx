import { Box, Button, ButtonBase, Stack, Typography } from '@mui/material'
import { BottomSheet } from '../../../components'
import { filterChipSx } from '../../filters'
import { facetsOf, SECTION_LABEL, type FacetKey, type FacetSection } from '../folioFacets'

const SECTIONS: FacetSection[] = ['pago', 'entrega', 'pendiente']

const SECTION_HINT: Record<FacetSection, string> = {
  pago: 'Qué pasó con el dinero',
  entrega: 'Si el cliente recibió sus boletos',
  pendiente: 'Lo que alguien tiene que hacer',
}

interface FolioStateSheetProps {
  open: boolean
  onClose: () => void
  active: FacetKey[]
  onToggle: (key: FacetKey) => void
  onClear: () => void
}

// US-A84 (D3) — the Estado sheet: three sections, one per real axis of the data.
//
// Multi-select WITHIN a section (OR) and AND BETWEEN sections, because that is what a folio is: it
// can be *cancelled* and *refund pending* at the same time, *booking* and *overdue* at the same
// time. The exclusive ToggleButtonGroup this replaces asserted a mutual exclusion the data never
// had, which is why "cancelled folios I have already paid back" could not be asked.
//
// Chips reuse the strip's 48px `filterChipSx` and the sheet reuses `BottomSheet`, in the shape
// `PosCategorySheet` already established — the filter language of this app is one language.
export function FolioStateSheet({ open, onClose, active, onToggle, onClear }: FolioStateSheetProps) {
  const header = (
    <Box sx={{ px: 3, pt: 1, pb: 2 }}>
      <Typography sx={{ fontWeight: 600, fontSize: 17 }}>Estado</Typography>
    </Box>
  )

  const footer = (
    <Stack direction="row" spacing={1} sx={{ px: 3, py: 2 }}>
      <Button fullWidth variant="text" onClick={onClear} disabled={active.length === 0}>
        Limpiar
      </Button>
      <Button fullWidth variant="contained" onClick={onClose}>
        Listo
      </Button>
    </Stack>
  )

  return (
    <BottomSheet open={open} onClose={onClose} title="Estado" header={header} footer={footer}>
      <Box sx={{ px: 3, pb: 2 }}>
        {SECTIONS.map((section) => (
          <Box key={section} sx={{ mb: 3 }}>
            <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>
              {SECTION_LABEL[section]}
            </Typography>
            {/* The hint is what makes the three sections learnable without a manual: each names the
                question it answers, so "Por verificar" is obviously work and not a payment state. */}
            <Typography variant="caption" color="textSecondary" sx={{ display: 'block', mb: 1 }}>
              {SECTION_HINT[section]}
            </Typography>
            <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
              {facetsOf(section).map((facet) => (
                <ButtonBase
                  key={facet.key}
                  onClick={() => onToggle(facet.key)}
                  sx={filterChipSx(active.includes(facet.key))}
                >
                  {facet.label}
                </ButtonBase>
              ))}
            </Box>
          </Box>
        ))}
      </Box>
    </BottomSheet>
  )
}
