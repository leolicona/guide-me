import { request } from '@playwright/test'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const here = dirname(fileURLToPath(import.meta.url))
const ctx = await request.newContext({ baseURL: 'https://api-dev.turistearya.com', storageState: resolve(here, '.auth/agent.json') })

// Pick the cheapest available tour + its first slot.
const j = await (await ctx.get('/api/pos/services')).json()
const svc = (j.services ?? []).filter(s => s.has_availability && s.item_type === 'tour').sort((a,b)=>a.base_price-b.base_price)[0]
const det = (await (await ctx.get(`/api/pos/services/${svc.id}?from=2026-07-25&to=2026-08-31`)).json()).service
const slot = det.slots.find(s => s.remaining > 0)
const total = det.base_price // qty 1
console.log('service:', det.name, 'price', total, 'slot', slot.id, slot.date, slot.start_time)

// Cash deposit ≈ 50% → creates a booking (apartado) with a pending balance.
let deposit = Math.round(total * 0.5)
const body = {
  customer_name: 'E2E Apartado Cliente',
  customer_phone: '5512349999',
  payment_method: 'cash',
  down_payment: deposit,
  lines: [{ slot_id: slot.id, quantity: 1, unit_price: total }],
}
let res = await ctx.post('/api/pos/folios', { data: body })
if (!res.ok()) {
  console.log('first attempt', res.status(), await res.text())
  // bump the deposit if below the org minimum
  body.down_payment = Math.round(total * 0.7)
  res = await ctx.post('/api/pos/folios', { data: body })
}
console.log('POST /api/pos/folios', res.status())
const out = await res.json()
const f = out.folio ?? out
console.log('APARTADO:', JSON.stringify({ id: f.id, status: f.status, total: f.total, amount_paid: f.amount_paid, pending_balance: f.pending_balance, payment_method: f.payment_method }))
await ctx.dispose()
