export const ROUTES = {
  LOGIN: '/login',
  REGISTER: '/register',
  VERIFY: '/verify',
  FORGOT_PASSWORD: '/forgot-password',
  RESET_PASSWORD: '/reset-password',
  INVITE_ACCEPT: '/invite/accept',
  DASHBOARD: '/dashboard',
  AGENTS: '/agents',
  INVITE_AGENT: '/agents/invite',
  CATALOG: '/catalog',
  CATALOG_NEW: '/catalog/new', // admin — full-page service creation wizard (US-A38–A44)
  CATALOG_DETAIL: '/catalog/:id',
  SETTINGS: '/settings', // admin — org booking policy (US-A46)
  POS: '/pos',
  POS_SERVICE: '/pos/service/:id',
  POS_CHECKOUT: '/pos/checkout',
  FOLIO: '/pos/folio/:id',
  SCAN: '/scan',
  HISTORY: '/history', // agent — own folio history list (US-AG20)
  HISTORY_DETAIL: '/history/:id', // agent — one folio, read-only (US-AG21)
  FOLIOS: '/folios',
  // US-A86 — the admin's outbox: the clock-produced half of the notifications, plus failures.
  OUTBOX: '/mensajes',
  FOLIO_DETAIL: '/folios/:id',
  // Every role's OWN caja — agent and admin alike. «Caja» means one thing
  // (caja-surface-parity D2′); the admin's oversight of everyone else's lives at CASH.
  BALANCE: '/balance',
  CASH: '/cash', // admin — CAJA DEL EQUIPO: who holds company cash + what needs confirming
  CASH_DROPS: '/cash/entregas', // admin — the drop history, faceted (D15)
  CASH_DROP_DETAIL: '/cash/drops/:id', // admin — one drop's detail
  REPORTS: '/reports', // admin — commission & settlement report by period (US-A17/A18/A20)
} as const
