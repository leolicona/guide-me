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
  CATALOG_DETAIL: '/catalog/:id',
  POS: '/pos',
  POS_SERVICE: '/pos/service/:id',
  POS_CHECKOUT: '/pos/checkout',
  FOLIO: '/pos/folio/:id',
  SCAN: '/scan',
  FOLIOS: '/folios',
  FOLIO_DETAIL: '/folios/:id',
  BALANCE: '/balance', // agent — running balance, expenses, hand-ins
  CASH: '/cash', // admin — outstanding balances + drops review queue
  CASH_DROP_DETAIL: '/cash/drops/:id', // admin — one drop's detail
} as const
