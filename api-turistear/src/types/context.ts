export type UserRole = 'admin' | 'agent' | 'affiliate'

export interface UserPayload {
  userId: string
  name: string
  email: string
  role: UserRole
  organizationId: string
  // Set only for an `affiliate` user (their partner company); null for admin/agent. The portal
  // catalog filter + commission resolution key on it (affiliate-portal.spec.md §4.2).
  affiliateCompanyId: string | null
}

// Set ONLY on an operator (shift-cashier) session (US-OP01/OP02). When present, `user` is the
// operator's owning manager (the borrowed affiliate identity — D5) and this names who is actually
// at the register, stamped onto folios.operator_id. Absent on a real manager/agent/admin session.
export interface OperatorPayload {
  operatorId: string
  name: string
  affiliateCompanyId: string
}

export interface AppVariables {
  user: UserPayload
  operator?: OperatorPayload
}
