---
name: Luminous SaaS
colors:
  surface: '#f9f9ff'
  surface-dim: '#d3daea'
  surface-bright: '#f9f9ff'
  surface-container-lowest: '#ffffff'
  surface-container-low: '#f0f3ff'
  surface-container: '#e7eefe'
  surface-container-high: '#e2e8f8'
  surface-container-highest: '#dce2f3'
  on-surface: '#151c27'
  on-surface-variant: '#464555'
  inverse-surface: '#2a313d'
  inverse-on-surface: '#ebf1ff'
  outline: '#777587'
  outline-variant: '#c7c4d8'
  surface-tint: '#4e44e2'
  primary: '#3e32d3'
  on-primary: '#ffffff'
  primary-container: '#5850ec'
  on-primary-container: '#e9e5ff'
  inverse-primary: '#c3c0ff'
  secondary: '#5c5f60'
  on-secondary: '#ffffff'
  secondary-container: '#e1e3e4'
  on-secondary-container: '#626566'
  tertiary: '#495061'
  on-tertiary: '#ffffff'
  tertiary-container: '#61687a'
  on-tertiary-container: '#e1e8fd'
  error: '#ba1a1a'
  on-error: '#ffffff'
  error-container: '#ffdad6'
  on-error-container: '#93000a'
  primary-fixed: '#e2dfff'
  primary-fixed-dim: '#c3c0ff'
  on-primary-fixed: '#0f0069'
  on-primary-fixed-variant: '#3424ca'
  secondary-fixed: '#e1e3e4'
  secondary-fixed-dim: '#c5c7c8'
  on-secondary-fixed: '#191c1d'
  on-secondary-fixed-variant: '#454748'
  tertiary-fixed: '#dce2f7'
  tertiary-fixed-dim: '#c0c6db'
  on-tertiary-fixed: '#141b2b'
  on-tertiary-fixed-variant: '#404758'
  background: '#f9f9ff'
  on-background: '#151c27'
  surface-variant: '#dce2f3'
typography:
  headline-xl:
    fontFamily: Manrope
    fontSize: 40px
    fontWeight: '700'
    lineHeight: 48px
    letterSpacing: -0.02em
  headline-lg:
    fontFamily: Manrope
    fontSize: 32px
    fontWeight: '700'
    lineHeight: 40px
    letterSpacing: -0.02em
  headline-md:
    fontFamily: Manrope
    fontSize: 24px
    fontWeight: '600'
    lineHeight: 32px
  body-lg:
    fontFamily: Manrope
    fontSize: 18px
    fontWeight: '400'
    lineHeight: 28px
  body-md:
    fontFamily: Manrope
    fontSize: 16px
    fontWeight: '400'
    lineHeight: 24px
  label-md:
    fontFamily: Manrope
    fontSize: 14px
    fontWeight: '500'
    lineHeight: 20px
    letterSpacing: 0.01em
  label-sm:
    fontFamily: Manrope
    fontSize: 12px
    fontWeight: '600'
    lineHeight: 16px
rounded:
  sm: 0.25rem
  DEFAULT: 0.5rem
  md: 0.75rem
  lg: 1rem
  xl: 1.5rem
  full: 9999px
spacing:
  base: 8px
  xs: 4px
  sm: 12px
  md: 24px
  lg: 40px
  xl: 64px
  gutter: 16px
  margin-mobile: 20px
  margin-desktop: 48px
---

## Brand & Style

The design system is rooted in **Modern Minimalism** with a sophisticated SaaS aesthetic. It targets professional users who require clarity and efficiency in high-utility environments. The visual narrative balances airy, open layouts with high-precision functional elements.

By leveraging significant white space and a "soft-tech" approach, the UI evokes a sense of calm control. The style focuses on content hierarchy rather than decorative flourishes, using subtle depth to guide the user's eye toward critical actions and data points.

## Colors

The palette is built on a foundation of **Foundation Whites** and **Subtle Grays** to maximize legibility and provide a "clean slate" feel. 

- **Base Surface:** Use a pure white (#FFFFFF) for the primary content containers to ensure maximum contrast with text. 
- **Background:** A very light gray (#F9FAFB) is used for the page background to define the boundaries of white cards and sections.
- **Accent:** An Electric Violet (#5850EC) serves as the primary action color. It is used sparingly for primary buttons, active states, and critical indicators to prevent visual fatigue.
- **Typography:** Deep Charcoal (#111827) is used for headings to provide a strong anchor, while a softer Slate Gray (#6B7280) is reserved for body text and labels.

## Typography

The design system utilizes **Manrope** for its balanced, geometric, and modern characteristics. It provides excellent legibility in SaaS environments where numerical data and text densities vary.

- **Scale:** Use tight letter spacing for large headlines to maintain a cohesive visual block.
- **Hierarchy:** Contrast is achieved primarily through weight (SemiBold/Bold for headers) rather than drastic size changes.
- **Mobile Adjustments:** For screens smaller than 768px, `headline-xl` should scale down to 32px and `headline-lg` to 24px to ensure fit and comfort.

## Layout & Spacing

This design system follows a **Fluid Grid** model with generous safe areas. The layout is designed to breathe, using whitespace as a functional tool to separate distinct logical groups.

- **Rhythm:** An 8px base unit governs all dimensions.
- **Desktop:** 12-column grid with 24px gutters. Max content width of 1280px.
- **Mobile:** Single column layout with 20px side margins.
- **Density:** High whitespace density is preferred. Cards and containers should use `md` (24px) or `lg` (40px) internal padding to maintain the premium, uncluttered feel inspired by the reference images.

## Elevation & Depth

Hierarchy is established through **Tonal Layering** and **Ambient Shadows**. Instead of heavy borders, surfaces are differentiated by subtle shifts in elevation.

- **The Foundation:** The background is the lowest level (`#F9FAFB`).
- **Surface Level:** Content cards sit at `elevation-1`, utilizing a very soft, diffused shadow: `0px 4px 20px rgba(0, 0, 0, 0.03)`.
- **Active Level:** Interactive elements like modals or floating menus sit at `elevation-2`, with a more pronounced shadow: `0px 10px 30px rgba(0, 0, 0, 0.08)`.
- **Glassmorphism:** For overlays and bottom sheets, use a 20px backdrop blur with a 90% white fill to maintain context without cluttering the view.

## Shapes

The shape language is **Rounded and Friendly**. This softens the "corporate" edge of the SaaS product, making it feel more approachable.

- **Primary Radius:** 0.5rem (8px) for standard components like inputs and small buttons.
- **Container Radius:** 1rem (16px) for cards, section wrappers, and modals.
- **Icon Wrappers:** Often use a circular or "squircle" background to distinguish them from functional buttons.

## Components

### Buttons
Primary buttons use the accent color with white text and a subtle 10% dark overlay on hover. Secondary buttons use a light gray ghost style with no background and a border that only appears on hover.

### Cards
Cards are the primary structural unit. They should have a subtle 1px border (`#E5E7EB`) and the standard `elevation-1` shadow. Ensure internal padding is generous (minimum 24px).

### Input Fields
Inputs use a white background, 8px radius, and a 1px border. On focus, the border transitions to the primary accent color with a 3px soft outer glow (bloom effect).

### Chips & Tags
Used for status indicators (e.g., "Disponible", "Pagado"). These use high-roundedness (pill-shaped) with low-saturation background tints of the status color (e.g., light green background with dark green text) to avoid visual noise.

### Bottom Navigation / Tabs
For mobile, the bottom navigation uses a white background with a subtle top border and `elevation-2`. Active states are marked by the primary accent color and a slight vertical offset or icon fill.

### List Items
Interactive list items should feature a subtle background color change (`#F3F4F6`) on hover or press to provide tactile feedback.