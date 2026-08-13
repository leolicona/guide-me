import { describe, it, expect } from 'vitest'
import {
  deliveryState,
  fillTemplate,
  ticketWhatsAppUrl,
  DEFAULT_TICKET_TEMPLATE,
  DEFAULT_REMINDER_TEMPLATE,
  TEMPLATE_PLACEHOLDERS,
  type TemplateContext,
} from './delivery'

const ctx = (over: Partial<TemplateContext['folio']> = {}): TemplateContext => ({
  folio: {
    id: 'abcdef12-3456-7890-abcd-ef1234567890',
    customer_name: 'Ana',
    customer_phone: '9981234567',
    total: 150_000,
    amount_paid: 50_000,
    lines: [
      { service_name: 'Tour Isla', slot_date: '2026-08-05', slot_start_time: '09:00', quantity: 2 },
    ],
    ...over,
  },
  agentName: 'Luis',
  orgName: 'Turistear Ya',
  portalLink: 'https://app.turistearya.com/t/xyz',
})

// The delivery axis: a folio only joins it once a portal link exists. viewed > sent > pending.
describe('deliveryState', () => {
  it('is off-axis with neither a portal link nor deliverable', () => {
    expect(deliveryState({})).toBe('none')
    expect(deliveryState({ portal_link: null, deliverable: false })).toBe('none')
  })

  it('is off-axis even when timestamps exist, if nothing puts it on the axis', () => {
    // A pre-feature folio can carry a sent_at without a link; it must not read as "Enviado".
    expect(deliveryState({ tickets_sent_at: 1_700_000_000 })).toBe('none')
  })

  it('is pending once on the axis by either route', () => {
    expect(deliveryState({ portal_link: 'https://…' })).toBe('pending')
    expect(deliveryState({ deliverable: true })).toBe('pending')
  })

  it('reads sent, then viewed, as the timestamps land', () => {
    expect(deliveryState({ deliverable: true, tickets_sent_at: 1 })).toBe('sent')
    expect(deliveryState({ deliverable: true, tickets_sent_at: 1, tickets_viewed_at: 2 })).toBe(
      'viewed',
    )
  })

  it('reads viewed even if sent_at was never recorded — viewed outranks sent', () => {
    expect(deliveryState({ deliverable: true, tickets_viewed_at: 2 })).toBe('viewed')
  })
})

describe('fillTemplate', () => {
  it('substitutes every documented placeholder', () => {
    const filled = fillTemplate(TEMPLATE_PLACEHOLDERS.join('|'), ctx())
    for (const token of TEMPLATE_PLACEHOLDERS) {
      expect(filled, `${token} was left unsubstituted`).not.toContain(token)
    }
  })

  it('shortens the folio id to its 8-character reference', () => {
    expect(fillTemplate('{folio_ref}', ctx())).toBe('abcdef12')
  })

  it('derives the pending balance from total − paid when the folio does not carry one', () => {
    expect(fillTemplate('{pending_balance}', ctx({ total: 150_000, amount_paid: 50_000 }))).toContain(
      '1,000',
    )
  })

  it('prefers an explicit pending_balance over the derived one', () => {
    const filled = fillTemplate(
      '{pending_balance}',
      ctx({ total: 150_000, amount_paid: 50_000, pending_balance: 25_000 }),
    )
    expect(filled).toContain('250')
    expect(filled).not.toContain('1,000')
  })

  it('degrades a null customer name to the fallback addressee, never "null" or a blank (D29)', () => {
    // An Express folio has no name (D17); under WhatsApp-first the template renders on EVERY
    // sale, so the empty-string substitution that produced "Hola ," is retired.
    expect(fillTemplate('[{customer_name}]', ctx({ customer_name: null }))).toBe('[viajero]')
    expect(
      fillTemplate('Hola {customer_name}, te escribe {agent_name}.', ctx({ customer_name: null })),
    ).toBe('Hola viajero, te escribe Luis.')
  })

  it('an empty-string name degrades exactly like a null one', () => {
    expect(fillTemplate('[{customer_name}]', ctx({ customer_name: '' }))).toBe('[viajero]')
  })

  it('leaves an unknown {token} untouched rather than blanking it', () => {
    expect(fillTemplate('{not_a_placeholder}', ctx())).toBe('{not_a_placeholder}')
    expect(fillTemplate('Hola {customer_name} {nope}', ctx())).toBe('Hola Ana {nope}')
  })

  it('renders a tour itinerary line with date, time and pax', () => {
    expect(fillTemplate('{itinerary}', ctx())).toBe('• Tour Isla · 2026-08-05 · 09:00 · 2p')
  })

  it('renders a lodging itinerary line as a stay, with pluralised guests', () => {
    const one = fillTemplate(
      '{itinerary}',
      ctx({
        lines: [
          {
            service_name: 'Suite',
            line_type: 'stay',
            check_in: '2026-08-01',
            check_out: '2026-08-03',
            guests: 1,
            quantity: 1,
          },
        ],
      }),
    )
    expect(one).toBe('• Suite · 2026-08-01–2026-08-03 · 1 huésped')

    const many = fillTemplate(
      '{itinerary}',
      ctx({
        lines: [
          {
            service_name: 'Suite',
            check_in: '2026-08-01',
            check_out: '2026-08-03',
            guests: 3,
            quantity: 1,
          },
        ],
      }),
    )
    expect(many).toBe('• Suite · 2026-08-01–2026-08-03 · 3 huéspedes')
  })

  it('renders one bullet per line, newline-separated', () => {
    const filled = fillTemplate(
      '{itinerary}',
      ctx({
        lines: [
          { service_name: 'Tour Isla', slot_date: '2026-08-05', quantity: 2 },
          { service_name: 'Snorkel', slot_date: '2026-08-06', quantity: 4 },
        ],
      }),
    )
    expect(filled.split('\n')).toHaveLength(2)
  })

  it('renders both shipped default templates end to end with nothing left over', () => {
    for (const template of [DEFAULT_TICKET_TEMPLATE, DEFAULT_REMINDER_TEMPLATE]) {
      const filled = fillTemplate(template, ctx())
      expect(filled).not.toMatch(/\{[a-z_]+\}/)
      expect(filled).toContain('Ana')
      expect(filled).toContain('Turistear Ya')
    }
  })
})

describe('ticketWhatsAppUrl', () => {
  it('prefixes a bare 10-digit Mexican number with the country code', () => {
    const url = ticketWhatsAppUrl('Hola', ctx({ customer_phone: '998 123 4567' }))
    expect(url).toBe('https://wa.me/529981234567?text=Hola')
  })

  it('keeps a number that already carries a country code', () => {
    const url = ticketWhatsAppUrl('Hola', ctx({ customer_phone: '+1 305 555 0123' }))
    expect(url?.startsWith('https://wa.me/13055550123?text=')).toBe(true)
  })

  it('percent-encodes the message, including accents and newlines', () => {
    const url = ticketWhatsAppUrl('Hola {customer_name}\n¡Buen viaje!', ctx())!
    const text = new URL(url).searchParams.get('text')
    // Round-trips: the reader gets the real characters back, and the raw URL carries none of them.
    expect(text).toBe('Hola Ana\n¡Buen viaje!')
    expect(url).toContain('%0A') // newline
    expect(url).not.toContain('¡')
  })

  it('returns null when there is no phone at all', () => {
    expect(ticketWhatsAppUrl('Hola', ctx({ customer_phone: null }))).toBeNull()
    expect(ticketWhatsAppUrl('Hola', ctx({ customer_phone: '' }))).toBeNull()
    expect(ticketWhatsAppUrl('Hola', ctx({ customer_phone: 'no digits here' }))).toBeNull()
  })

  // NOTE — current behaviour, deliberately pinned rather than wished away: the guard is
  // `if (!phone)`, i.e. "any digits at all", NOT `normalizePhone(...).valid` (11–15 digits). So a
  // too-short number still yields a wa.me link that cannot resolve. Recorded in docs/BUGS.md (BUG-020);
  // when it is fixed, this expectation flips to `toBeNull()`.
  it('still builds a link for an undialable short number (known gap)', () => {
    expect(ticketWhatsAppUrl('Hola', ctx({ customer_phone: '123' }))).toBe(
      'https://wa.me/123?text=Hola',
    )
  })
})
