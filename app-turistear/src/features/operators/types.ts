// US-AF10–AF13 / US-OP01–OP02 — affiliate shift operators (docs/affiliate-operators/spec.md).

export type OperatorStatus = 'active' | 'removed'

// Manager-facing operator (never carries the PIN). `access_url` is the durable WhatsApp link.
export interface Operator {
  id: string
  name: string
  phone: string
  status: OperatorStatus
  pin_set: boolean
  locked: boolean
  access_url: string | null
  created_at: number
}

export interface CreateOperatorInput {
  name: string
  phone: string
}

// The operator-facing resolution of a saved access link (/o/:token).
export interface OperatorAccess {
  name: string
  hotel_name: string
  pin_set: boolean // false ⇒ first-run (set PIN); true ⇒ returning (enter PIN)
  locked: boolean
}
