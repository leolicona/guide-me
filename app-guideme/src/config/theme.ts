import { createTheme } from '@mui/material/styles'
import type { Shadows } from '@mui/material/styles'

const subtle = '0 2px 8px rgba(0,0,0,0.08)'

export const theme = createTheme({
  cssVariables: true,
  palette: {
    primary: {
      main: '#1C1C2E',
    },
    secondary: {
      main: '#4F46E5',
    },
    background: {
      default: '#F8F9FA',
      paper: '#FFFFFF',
    },
  },
  typography: {
    fontFamily: '"Inter", sans-serif',
    h5: { fontWeight: 600 },
    h6: { fontWeight: 600 },
  },
  shape: {
    borderRadius: 8,
  },
  shadows: [
    'none',
    '0 1px 3px rgba(0,0,0,0.06)',
    subtle,
    subtle, subtle, subtle, subtle, subtle,
    subtle, subtle, subtle, subtle, subtle,
    subtle, subtle, subtle, subtle, subtle,
    subtle, subtle, subtle, subtle, subtle,
    subtle, subtle,
  ] as Shadows,
  components: {
    MuiButton: {
      styleOverrides: {
        root: {
          borderRadius: 8,
          textTransform: 'none',
          fontWeight: 500,
        },
      },
    },
    MuiOutlinedInput: {
      styleOverrides: {
        root: {
          borderRadius: 8,
        },
      },
    },
    MuiCard: {
      styleOverrides: {
        root: ({ theme }) => ({
          boxShadow: 'none',
          border: `1px solid ${theme.palette.divider}`,
          borderRadius: 12,
        }),
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
          backgroundColor: '#F8F9FA',
        },
      },
    },
  },
})
