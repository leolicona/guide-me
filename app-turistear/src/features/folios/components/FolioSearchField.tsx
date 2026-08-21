import { IconButton, InputAdornment, TextField } from '@mui/material'
import { SearchRounded, CloseRounded } from '@mui/icons-material'

// US-A83 (D1) — the search field: fixed above the filter strip, never behind a magnifier tap.
//
// It filters on every keystroke and is deliberately NOT debounced: the pass runs in memory over a
// payload that is already loaded, so there is nothing to wait for and a debounce would add latency
// to an operation that has none. (The server FALLBACK is debounced — that one crosses the network.)
export function FolioSearchField({
  value,
  onChange,
}: {
  value: string
  onChange: (next: string) => void
}) {
  return (
    <TextField
      fullWidth
      size="small"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder="Cliente, teléfono, tour, folio o vendedor"
      // The placeholder names all five fields on purpose: it is the only place the user learns that
      // typing a tour name works at all, and that is the case the Express sale depends on.
      sx={{ mb: 2 }}
      slotProps={{
        htmlInput: { 'aria-label': 'Buscar folios', enterKeyHint: 'search' },
        input: {
          startAdornment: (
            <InputAdornment position="start">
              <SearchRounded fontSize="small" />
            </InputAdornment>
          ),
          endAdornment: value ? (
            <InputAdornment position="end">
              <IconButton aria-label="Limpiar búsqueda" size="small" onClick={() => onChange('')}>
                <CloseRounded fontSize="small" />
              </IconButton>
            </InputAdornment>
          ) : null,
        },
      }}
    />
  )
}
