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
  AFFILIATES: '/affiliates', // admin — affiliate companies list (US-A48)
  AFFILIATE_DETAIL: '/affiliates/:id', // admin — affiliate detail/edit (US-A48/A50/A52)
  CATALOG: '/catalog',
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
  FOLIO_DETAIL: '/folios/:id',
  BALANCE: '/balance', // agent — running balance, expenses, hand-ins
  CASH: '/cash', // admin — outstanding balances + drops review queue
  CASH_DROP_DETAIL: '/cash/drops/:id', // admin — one drop's detail
} as const
