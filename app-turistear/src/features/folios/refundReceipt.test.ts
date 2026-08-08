import { describe, it, expect } from 'vitest'
import { refundReceiptText, refundReceiptUrl, retainedCents } from './refundReceipt'

// US-AG51 — S-11. The receipt is what the customer keeps after the cash is in their pocket.
// Spec: docs/folios/folio-state-machine.spec.md (D12, D20, business rule 13).

const aRefund = (over: Partial<Parameters<typeof refundReceiptText>[0]> = {}) => ({
  id: '9f3c1b7e-0000-4000-8000-000000000001',
  customer_name: 'María González',
  customer_phone: '+52 998 123 4567',
  amount_paid: 300000,
  refund_amount: 180000,
  ...over,
})

describe('US-AG51 — the refund receipt says where the money went', () => {
  it('spells out paid, returned AND retained — the third is the point', () => {
    const text = refundReceiptText(aRefund())
    expect(text).toContain('$3,000.00')
    expect(text).toContain('$1,800.00')
    // The figure that is shown nowhere else in the product. Without it the message is a receipt
    // for money the customer already counted, and answers nothing.
    expect(text).toContain('$1,200.00')
  })

  it('a full refund retains nothing, and says so rather than going quiet', () => {
    const text = refundReceiptText(aRefund({ amount_paid: 300000, refund_amount: 300000 }))
    expect(retainedCents(aRefund({ amount_paid: 300000, refund_amount: 300000 }))).toBe(0)
    expect(text).toContain('se retuvo $0.00')
  })

  it('the ladder keeping everything is stated, not hidden', () => {
    // The US-A76 case: a 30% deposit against a terminal tier returns nothing.
    const f = aRefund({ amount_paid: 90000, refund_amount: 0 })
    expect(retainedCents(f)).toBe(90000)
    expect(refundReceiptText(f)).toContain('te devolvimos $0.00')
  })

  it('a null refund_amount is read as zero, never as NaN on a customer’s screen', () => {
    expect(refundReceiptText(aRefund({ refund_amount: null }))).not.toContain('NaN')
  })

  it('retention can never go negative, whatever the columns say', () => {
    expect(retainedCents(aRefund({ amount_paid: 100, refund_amount: 999999 }))).toBe(0)
  })

  it('names the folio by the same short reference the rest of the app uses', () => {
    expect(refundReceiptText(aRefund())).toContain('9F3C1B7E')
  })

  it('builds a composer link from the phone, digits only', () => {
    const url = refundReceiptUrl(aRefund())!
    expect(url.startsWith('https://wa.me/525299812345')).toBe(false) // not a mangled prefix
    expect(url).toContain('https://wa.me/529981234567?text=')
    expect(decodeURIComponent(url)).toContain('se retuvo')
  })

  it('no phone → no link, rather than a broken one', () => {
    expect(refundReceiptUrl(aRefund({ customer_phone: null }))).toBeNull()
    expect(refundReceiptUrl(aRefund({ customer_phone: '   ' }))).toBeNull()
  })
})
