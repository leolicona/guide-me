import { useMemo, useState } from 'react'
import { Box, Stack, Typography, ButtonBase, TextField, InputAdornment, Skeleton } from '@mui/material'
import AddRounded from '@mui/icons-material/AddRounded'
import CheckRounded from '@mui/icons-material/CheckRounded'
import SearchRounded from '@mui/icons-material/SearchRounded'
import type { Service } from '../../types'
import { useUnits } from '../../hooks/useUnits'

/** The sentinel `value` meaning "none of these — create a property" (US-A91 D2). */
export const NEW_PROPERTY = 'new' as const

export type PropertyChoice = string | typeof NEW_PROPERTY | null

interface PropertyPickerProps {
  properties: Service[]
  value: PropertyChoice
  onChange: (value: PropertyChoice) => void
  /** True once the user tried to advance without choosing (US-A91 D6). */
  error?: boolean
}

/** Above this many properties the list gains a search field and a scroll region (D4). */
const SEARCH_THRESHOLD = 6

// The property's inventory line — what makes one row recognisable among several (D3). Shares
// `useUnits`' query key with the catalog list's LodgingSummary, so the cache is already warm.
function PropertySummary({ serviceId }: { serviceId: string }) {
  const { data: units, isLoading } = useUnits(serviceId)

  if (isLoading) return <Skeleton width={140} sx={{ fontSize: '0.875rem' }} />

  const active = (units ?? []).filter((u) => u.status === 'active')
  if (active.length === 0) {
    return (
      <Typography variant="body2" color="text.secondary">
        Sin unidades
      </Typography>
    )
  }
  const total = active.reduce((sum, u) => sum + u.inventory_count, 0)
  return (
    <Typography variant="body2" color="text.secondary" className="numeric">
      {active.length} unidad{active.length === 1 ? '' : 'es'} · {total} en total
    </Typography>
  )
}

function Row({
  selected,
  onClick,
  children,
}: {
  selected: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <ButtonBase
      onClick={onClick}
      aria-pressed={selected}
      sx={{
        width: '100%',
        minHeight: 64,
        px: 2,
        py: 1.5,
        justifyContent: 'flex-start',
        textAlign: 'left',
        borderRadius: 'var(--radius-md, 12px)',
        border: '1px solid',
        // Selection is the one sanctioned teal use — same grammar as AmenityPicker.
        borderColor: selected ? 'var(--teal-700, #0F766E)' : 'var(--slate-300, #CBD5E1)',
        backgroundColor: selected ? 'var(--teal-50, #F0FDFA)' : 'transparent',
        '&:hover': {
          backgroundColor: selected ? 'var(--teal-50, #F0FDFA)' : 'var(--slate-100, #F1F5F9)',
        },
      }}
    >
      {children}
    </ButtonBase>
  )
}

/**
 * US-A91 — the first question of the lodging wizard: which property does this unit belong to?
 * One control, not a mode toggle plus a field (D2): the org's active properties, with
 * "⊕ Crear una propiedad nueva" anchored BELOW the list — outside the scroll region and outside
 * the search filter (D5), so it can never be scrolled past or filtered away.
 */
export function PropertyPicker({ properties, value, onChange, error }: PropertyPickerProps) {
  const [query, setQuery] = useState('')
  const searchable = properties.length > SEARCH_THRESHOLD

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return properties
    return properties.filter((p) => p.name.toLowerCase().includes(q))
  }, [properties, query])

  return (
    <Box>
      <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
        ¿En qué lugar se renta?
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5, mb: 1.5 }}>
        Elige la propiedad a la que pertenece, o crea una nueva.
      </Typography>

      {searchable && (
        <TextField
          fullWidth
          size="small"
          placeholder="Buscar propiedad"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          sx={{ mb: 1.5 }}
          slotProps={{
            input: {
              startAdornment: (
                <InputAdornment position="start">
                  <SearchRounded fontSize="small" />
                </InputAdornment>
              ),
            },
          }}
        />
      )}

      <Stack
        spacing={1}
        sx={
          searchable
            ? { maxHeight: 264, overflowY: 'auto', pr: 0.5 }
            : undefined
        }
      >
        {visible.map((p) => {
          const selected = value === p.id
          return (
            <Row key={p.id} selected={selected} onClick={() => onChange(p.id)}>
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Typography
                  sx={{ fontWeight: 600, color: selected ? 'var(--teal-700, #0F766E)' : 'text.primary' }}
                  noWrap
                >
                  {p.name}
                </Typography>
                <PropertySummary serviceId={p.id} />
              </Box>
              {selected && <CheckRounded sx={{ color: 'var(--teal-700, #0F766E)', ml: 1 }} />}
            </Row>
          )
        })}
        {searchable && visible.length === 0 && (
          <Typography variant="body2" color="text.secondary" sx={{ py: 2 }}>
            Ninguna propiedad coincide con «{query.trim()}».
          </Typography>
        )}
      </Stack>

      {/* Anchored outside the scroll region and outside the filter (D5). */}
      <Box sx={{ mt: 1 }}>
        <Row selected={value === NEW_PROPERTY} onClick={() => onChange(NEW_PROPERTY)}>
          <AddRounded
            sx={{
              mr: 1.5,
              color: value === NEW_PROPERTY ? 'var(--teal-700, #0F766E)' : 'text.secondary',
            }}
          />
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Typography
              sx={{
                fontWeight: 600,
                color: value === NEW_PROPERTY ? 'var(--teal-700, #0F766E)' : 'text.primary',
              }}
            >
              Crear una propiedad nueva
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Un hotel o conjunto que aún no está en tu catálogo.
            </Typography>
          </Box>
        </Row>
      </Box>

      {error && (
        <Typography variant="body2" color="error" sx={{ mt: 1 }}>
          Elige dónde va esta unidad para continuar.
        </Typography>
      )}
    </Box>
  )
}
