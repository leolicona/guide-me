import { createTheme } from '@mui/material/styles'
import type { Shadows } from '@mui/material/styles'

// ─────────────────────────────────────────────────────────────────────────────
// Turistear Ya! — "Elegant Field Minimalism"
// Canonical tokens: .design/design-system/DESIGN_TOKENS.md (every value AA-verified there).
//
// A trustworthy field instrument: sophisticated minimalism hardened for outdoor, one-handed,
// cash-in-hand use. Three laws:
//   1. Legible in sunlight  → strong contrast, large numerals, ≥48px targets.
//   2. One confident accent → teal marks action/active state ONLY; never carries meaning.
//   3. Reach & repetition   → bottom-anchored actions, generous touch comfort.
//
// Elevation is STRUCTURE-FIRST: resting surfaces use a hairline border + surface tint (reads in
// any light); real shadow is reserved for true overlays (menus, dialogs, bottom sheets).
// Replaces the prior indigo "Luminous SaaS" theme (docs/DESING.md, now retired).
// ─────────────────────────────────────────────────────────────────────────────

// Brand — Teal / deep cyan (the single confident accent)
const TEAL = '#0F766E' // ★ primary — white-on 5.47:1, text-on-white 5.47:1 (AA✓)
const TEAL_HOVER = '#115E59' // primary hover (filled)
const TEAL_ACTIVE = '#134E4A' // primary active/pressed
const TEAL_SURFACE = '#F0FDFA' // selected row / active-nav indicator bg

// Neutrals — daylight-tuned cool slate
const INK = '#0F172A' // primary text — 17.85:1 on white
const SLATE = '#475569' // secondary text — 7.58:1 on white
const SLATE_MUTED = '#94A3B8' // placeholder / disabled (non-essential)
const HAIRLINE = '#E2E8F0' // card edge / divider (decorative)
const CONTROL_BORDER = '#CBD5E1' // resting input/control edge
const BG = '#F8FAFC' // foundation background (never pure white)

// Functional — meaning only, muted, always icon-paired, never teal
const SUCCESS = '#15803D' // availability / ok / paid — white-on 5.02:1
const WARNING = '#B45309' // caution / nearing expiry — white-on 5.02:1
const ERROR = '#B91C1C' // urgency / dispute / cancel — white-on 6.47:1
const INFO = '#0369A1' // rare neutral notice (NOT the teal brand)

// Elevation — overlays only
const SHADOW_OVERLAY_SM = '0 4px 12px rgba(15,23,42,0.08), 0 1px 2px rgba(15,23,42,0.04)' // menus/popovers
const SHADOW_OVERLAY_MD = '0 12px 32px rgba(15,23,42,0.14)' // dialogs

export const theme = createTheme({
  cssVariables: true,
  breakpoints: {
    // MUI defaults — documented for clarity (mobile-first).
    values: { xs: 0, sm: 600, md: 900, lg: 1200, xl: 1536 },
  },
  palette: {
    primary: { main: TEAL, dark: TEAL_HOVER, light: TEAL_SURFACE, contrastText: '#FFFFFF' },
    // No second brand tone — secondary stays on teal so existing color="secondary" CTAs are on-brand.
    secondary: { main: TEAL, dark: TEAL_HOVER, light: TEAL_SURFACE, contrastText: '#FFFFFF' },
    success: { main: SUCCESS, contrastText: '#FFFFFF' },
    warning: { main: WARNING, contrastText: '#FFFFFF' },
    error: { main: ERROR, contrastText: '#FFFFFF' },
    info: { main: INFO, contrastText: '#FFFFFF' },
    background: { default: BG, paper: '#FFFFFF' },
    text: { primary: INK, secondary: SLATE, disabled: SLATE_MUTED },
    divider: HAIRLINE,
  },
  typography: {
    // Manrope — geometric, strong with numeric/data densities. Hierarchy via weight, not size jumps.
    // Base 16px is deliberately large for outdoor legibility.
    fontFamily: '"Manrope", "Inter", system-ui, sans-serif',
    h1: { fontWeight: 700, fontSize: '2rem', lineHeight: 1.25, letterSpacing: '-0.02em' }, // 32
    h2: { fontWeight: 700, fontSize: '1.625rem', lineHeight: 1.23, letterSpacing: '-0.01em' }, // 26
    h3: { fontWeight: 600, fontSize: '1.375rem', lineHeight: 1.27, letterSpacing: '-0.01em' }, // 22
    h4: { fontWeight: 700, letterSpacing: '-0.02em' },
    h5: { fontWeight: 700, letterSpacing: '-0.01em' },
    h6: { fontWeight: 600 },
    subtitle1: { fontWeight: 600 },
    subtitle2: { fontWeight: 600 },
    body1: { fontSize: '1rem', lineHeight: 1.5 }, // 16
    body2: { fontSize: '0.875rem', lineHeight: 1.43 }, // 14
    button: { fontWeight: 600 },
    overline: { fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase' },
  },
  shape: {
    // Base stays 8 so ad-hoc `sx={{ borderRadius: n }}` across features keeps its intended scale
    // (MUI multiplies by this base). The system's 12px controls and 16px containers are pinned
    // explicitly in the component overrides below — not via this global multiplier.
    borderRadius: 8,
  },
  shadows: [
    'none',
    'none', // 1 — resting cards/surfaces are STRUCTURE-FIRST (border, no shadow)
    SHADOW_OVERLAY_SM, // 2 — menus / popovers
    ...(Array(6).fill(SHADOW_OVERLAY_SM) as string[]),
    ...(Array(16).fill(SHADOW_OVERLAY_MD) as string[]), // higher — dialogs / overlays
  ] as Shadows,
  components: {
    MuiButton: {
      defaultProps: { disableElevation: true },
      styleOverrides: {
        root: {
          borderRadius: 12,
          textTransform: 'none',
          fontWeight: 600,
          minHeight: 48, // touch comfort / reach
          boxShadow: 'none',
          // Contained-primary hover is handled by palette.primary.dark (TEAL_HOVER). Pressed
          // feedback on the primary action — the one confident teal CTA per screen.
          '&.MuiButton-containedPrimary:active': { backgroundColor: TEAL_ACTIVE },
        },
      },
    },
    MuiOutlinedInput: {
      styleOverrides: {
        root: ({ theme }) => ({
          borderRadius: 12,
          backgroundColor: '#FFFFFF',
          // Resting border is subtle; the control is identified by fill + the focus state
          // (WCAG 1.4.11 exception). Focus carries the high-contrast boundary.
          '& .MuiOutlinedInput-notchedOutline': { borderColor: CONTROL_BORDER },
          '&.Mui-focused .MuiOutlinedInput-notchedOutline': {
            borderColor: theme.palette.primary.main,
            borderWidth: 1,
          },
          // Focus "bloom": teal border + soft 3px outer glow, via a pseudo-element sized to
          // match the notched fieldset's own box (it sits 5px above the root on TOP only —
          // MUI's built-in offset that makes room for the floating-label notch cutout). Applying
          // box-shadow to `root` directly leaves a ~2px seam on the top edge only, where the
          // fieldset's opaque border and the glow don't share the same box (visible as a stray
          // hairline floating above the glow). Mirroring the fieldset's box here fixes it on all
          // four edges.
          '&.Mui-focused::after': {
            content: '""',
            position: 'absolute',
            top: -5,
            right: 0,
            bottom: 0,
            left: 0,
            borderRadius: 'inherit',
            boxShadow: `0 0 0 3px ${theme.palette.primary.main}47`, // ~28%
            pointerEvents: 'none',
          },
        }),
        input: { minHeight: 24, paddingTop: 12, paddingBottom: 12 },
      },
    },
    MuiCard: {
      styleOverrides: {
        root: ({ theme }) => ({
          // Structure-first: hairline border, NO resting shadow.
          boxShadow: 'none',
          border: `1px solid ${theme.palette.divider}`,
          borderRadius: 16, // container radius
        }),
      },
    },
    MuiPaper: {
      styleOverrides: {
        // Neutralize MUI's default elevation shadows on resting Paper; overlays opt back in
        // explicitly (Menu/Dialog/Drawer set their own elevation).
        rounded: { borderRadius: 16 },
        elevation1: { boxShadow: 'none' },
      },
    },
    MuiCardContent: {
      styleOverrides: {
        // Generous 24px padding (replaces MUI's 16) for the uncluttered, premium feel.
        root: { padding: 24, '&:last-child': { paddingBottom: 24 } },
      },
    },
    MuiChip: {
      styleOverrides: {
        root: { fontWeight: 600, borderRadius: 9999 },
      },
    },
    MuiLink: {
      styleOverrides: {
        root: {
          color: TEAL,
          textDecoration: 'none',
          '&:hover': { textDecoration: 'underline' },
        },
      },
    },
    MuiCssBaseline: {
      styleOverrides: {
        body: { backgroundColor: BG },
        // Tabular lining figures globally available via the .numeric utility (MoneyText uses it).
        '.numeric': { fontVariantNumeric: 'tabular-nums lining-nums', letterSpacing: '-0.01em' },
      },
    },
  },
})
