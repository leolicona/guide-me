import { createTheme } from '@mui/material/styles'
import type { Shadows } from '@mui/material/styles'

// Luminous SaaS (docs/DESING.md) — Modern Minimalism with a soft-tech, accent-led feel.
// "Vitality through color without saturation": hierarchy comes from tonal layering +
// ambient shadows rather than heavy borders.
//
// Indigo Premium is the brand PRIMARY — the main action / active-state color. Charcoal is
// demoted to ink (headings + body anchor). Functional color is reserved for meaning:
// green = availability, red = urgency. Both stay muted, never neon.
const INDIGO = '#5850EC' // Primary — Indigo Premium
const CHARCOAL = '#111827' // Ink — headings / strong text
const SLATE = '#6B7280' // Slate Gray — body / labels
const GREEN = '#1E9E6A' // Functional — availability
const RED = '#BA1A1A' // Functional — urgency
const BG = '#F9FAFB' // Foundation background
const HAIRLINE = '#E5E7EB' // 1px card/input border

// Tonal Layering & Ambient Shadows (Elevation & Depth):
const ELEVATION_1 = '0px 4px 20px rgba(0,0,0,0.03)' // surface cards
const ELEVATION_2 = '0px 10px 30px rgba(0,0,0,0.08)' // modals / floating menus

export const theme = createTheme({
  cssVariables: true,
  palette: {
    primary: {
      main: INDIGO,
      contrastText: '#FFFFFF',
    },
    // No distinct secondary brand tone in the system — kept on Indigo so the existing
    // `color="secondary"` accent CTAs (POS, etc.) stay on-brand.
    secondary: {
      main: INDIGO,
      contrastText: '#FFFFFF',
    },
    success: {
      main: GREEN,
      contrastText: '#FFFFFF',
    },
    error: {
      main: RED,
      contrastText: '#FFFFFF',
    },
    background: {
      default: BG,
      paper: '#FFFFFF',
    },
    text: {
      primary: CHARCOAL,
      secondary: SLATE,
    },
    divider: HAIRLINE,
  },
  typography: {
    // Manrope — balanced, geometric, strong with numeric/data densities. Contrast is
    // achieved through weight rather than drastic size jumps.
    fontFamily: '"Manrope", "Inter", sans-serif',
    h4: { fontWeight: 700, letterSpacing: '-0.02em' },
    h5: { fontWeight: 700, letterSpacing: '-0.01em' },
    h6: { fontWeight: 600 },
    subtitle1: { fontWeight: 600 },
    subtitle2: { fontWeight: 600 },
    button: { fontWeight: 600 },
  },
  shape: {
    // 8px for standard components (inputs, small buttons); containers/modals lift to 16px
    // via their own component overrides.
    borderRadius: 8,
  },
  shadows: [
    'none',
    ELEVATION_1,
    ELEVATION_2,
    ELEVATION_2, ELEVATION_2, ELEVATION_2, ELEVATION_2, ELEVATION_2,
    ELEVATION_2, ELEVATION_2, ELEVATION_2, ELEVATION_2, ELEVATION_2,
    ELEVATION_2, ELEVATION_2, ELEVATION_2, ELEVATION_2, ELEVATION_2,
    ELEVATION_2, ELEVATION_2, ELEVATION_2, ELEVATION_2, ELEVATION_2,
    ELEVATION_2, ELEVATION_2,
  ] as Shadows,
  components: {
    MuiButton: {
      styleOverrides: {
        root: {
          borderRadius: 8,
          textTransform: 'none',
          fontWeight: 600,
        },
      },
    },
    MuiOutlinedInput: {
      styleOverrides: {
        root: ({ theme }) => ({
          borderRadius: 8,
          backgroundColor: '#FFFFFF',
          // Focus "bloom": border shifts to the Indigo primary with a soft 3px outer glow.
          '&.Mui-focused .MuiOutlinedInput-notchedOutline': {
            borderColor: theme.palette.primary.main,
            borderWidth: 1,
          },
          '&.Mui-focused': {
            boxShadow: `0 0 0 3px ${theme.palette.primary.main}26`,
          },
        }),
      },
    },
    MuiCard: {
      styleOverrides: {
        root: ({ theme }) => ({
          // Tonal layering: a hairline border + soft ambient elevation-1 shadow.
          boxShadow: ELEVATION_1,
          border: `1px solid ${theme.palette.divider}`,
          // DESING.md "Container Radius: 1rem" — cards, section wrappers, modals.
          borderRadius: 16,
        }),
      },
    },
    MuiCardContent: {
      styleOverrides: {
        // DESING.md "internal padding generous (minimum 24px)" for the premium, uncluttered
        // feel — replaces MUI's default 16px. The last-child override keeps the bottom symmetric
        // (MUI otherwise pads the final child to 24px and the rest to 16px).
        root: {
          padding: 24,
          '&:last-child': { paddingBottom: 24 },
        },
      },
    },
    MuiLink: {
      styleOverrides: {
        root: {
          textDecoration: 'none',
          '&:hover': {
            textDecoration: 'underline',
          },
        },
      },
    },
    MuiCssBaseline: {
      styleOverrides: {
        body: {
          backgroundColor: BG,
        },
      },
    },
  },
})
