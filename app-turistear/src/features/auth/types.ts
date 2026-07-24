export type UserRole = 'admin' | 'agent' | 'affiliate'

// US-OP01/OP02 — present ONLY on an operator (shift-cashier) session: `user` is then the operator's
// owning affiliate manager, and this names who is actually at the register. The UI uses it to show
// "Operador: {name}", offer "Cambiar PIN", and hide the operators-management surface (D6).
export interface SessionOperator {
  operatorId: string
  name: string
  affiliateCompanyId: string
}

export interface UserPayload {
  userId: string
  name: string
  email: string
  role: UserRole
  organizationId: string
  // Set only for an `affiliate` user; null for admin/agent.
  affiliateCompanyId?: string | null
  // Set only on an operator shift session (see SessionOperator).
  operator?: SessionOperator | null
}
