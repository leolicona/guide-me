# GuideMe — Product Specification

## Product Vision

GuideMe is a multi-tenant, mobile-optimized SaaS platform that centralizes the sale of tourist services, real-time inventory control, commission calculation, and access validation via QR codes. It is designed so that tourism companies (organizations) can operate agilely in the field, ensuring financial control and a modern digital experience for the tourist.

**Problem solved:** Tourism sales teams operate with spreadsheets, informal WhatsApp, and untraceable cash. GuideMe replaces this chaos with a mobile-first tool that prevents overbooking, controls commissions, and automatically delivers digital receipts.

---

## Design Principles

- **Mobile-first:** The entire agent interface is designed for field use on mobile phones, without relying on a desktop.
- **Online QR validation (MVP):** The scanner requires an internet connection (3G/4G/WiFi) to validate and consume tickets in real-time against the server. Offline capabilities will be introduced post-MVP.
- **Authentication via email and password for admins and agents:** Both administrators and sales agents log in using their email and password. Clients do not log in directly in this phase.
- **Email ownership verification:** Account verification for admins (on registration) and agents (on accepting invitations) is done via magic links sent through Resend.
- **Real-time inventory:** No agent can sell more spots than those available at a given time slot.
- **Multitenancy:** Each organization operates in a completely isolated manner (data, catalog, staff).

---

## System Roles

| Role | Description | Authentication |
|---|---|---|
| `admin` | Full control of the organization: catalog, staff, reports, finances | Email + password (verification via Resend magic link) |
| `agent` | Sells services, manages daily cash drawers, scans access QRs | Email + password (onboarding/verification via Resend magic link) |
| `client` | Receives digital tickets and QR codes via Email. Does not interact directly with the app in this phase | No authentication |

---

## User Stories

### Administrator

### Authentication and Account

- **US-A01** — As an admin, I want to register with my name, email, password, and company name to create my organization in GuideMe.
- **US-A02** — As an admin, I want to verify my email by clicking on a magic link sent via Resend to activate my account.
- **US-A03** — As an admin, I want to log in with email and password to access my dashboard.
- **US-A04** — As an admin, I want to recover my password via email in case I forget it.

#### Staff Management

- **US-A05** — As an admin, I want to invite a sales agent by email to join my organization.
- **US-A06** — As an admin, I want to see the list of active agents in my organization with their assigned commission percentage.
- **US-A07** — As an admin, I want to edit an agent's profile and base commission percentage.
- **US-A08** — As an admin, I want to deactivate (suspend) an agent so they lose access to the platform without deleting their history.

#### Service Catalog

- **US-A09** — As an admin, I want to create a tour/service (e.g., "Canyon Sunrise Tour") with a name, description, base price, minimum selling price, and maximum capacity per time slot.
- **US-A10** — As an admin, I want to define recurring schedules or specific dates for each service, with its independent capacity per slot.
- **US-A11** — As an admin, I want to add optional "extras" to a service (e.g., "Professional photo", "Travel insurance") with their individual price.
- **US-A12** — As an admin, I want to define an additional commission bonus per specific service, which is added to the agent's base %.
- **US-A13** — As an admin, I want to edit or deactivate a service in the catalog without affecting already sold tickets (folios).

#### Dashboard and Monitoring

- **US-A14** — As an admin, I want to see a visual occupancy dashboard showing the status (available / close to capacity / full) of all active schedules for the day.
- **US-A15** — As an admin, I want to see in real-time how many spots remain available per service and schedule.
- **US-A16** — As an admin, I want to see a summary of the day's sales: total collected, number of folios, and sales per agent.

#### Financial Reports and Commissions

- **US-A17** — As an admin, I want to generate a commission report per agent for a range of dates, showing total sales, base commission, service bonuses, and total commission to pay.
- **US-A18** — As an admin, I want to see a performance comparison between agents (folios sold, total amount) in a given period.
- **US-A19** — As an admin, I want to review and validate the daily cash drawer closures submitted by agents.
- **US-A20** — As an admin, I want to export sales and commission reports (CSV or PDF) for external processing.

#### Cancellations

- **US-A21** — As an admin, I want to cancel an entire folio to automatically release the spots for all included services and record the cancellation.
- **US-A22** — As an admin, I want to partially cancel specific spots/services within a folio, releasing only the corresponding inventory without cancelling the whole group.
- **US-A23** — As an admin, I want to mark a cancelled folio (or partial cancellation) as "refunded" to track if the physical cash has been returned to the client.
- **US-A24** — As an admin, I want to see an audit timeline on the folio details page showing who created it, when it was cancelled, and by whom, with the associated reason.

---

### Sales Agent

#### Authentication

- **US-AG01** — As an agent, I want to accept my invitation by clicking the link received via email to activate my account, verify my email ownership, and set my password.
- **US-AG02** — As an agent, I want to log in with my email and password to access the app.
- **US-AG18** — As an agent, I want to recover my password via email in case I forget it.

#### Point of Sale

- **US-AG03** — As an agent, I want to view the catalog of available services with their real-time availability (remaining spots per schedule) to choose what to sell.
- **US-AG04** — As an agent, I want to select a service, choose an available schedule, and add the number of people to start a sale.
- **US-AG05** — As an agent, I want to add optional extras to the sales cart (e.g., photo, insurance) to increase the average ticket size.
- **US-AG06** — As an agent, I want to apply a manual discount to a service's price, with the limit locked at the minimum price defined by the admin, to avoid selling below the allowed cost.
- **US-AG07** — As an agent, I want to register a sale as a "booking/down-payment" (apartado) with a partial amount received, to reserve the spots and collect the rest later.
- **US-AG08** — As an agent, I want to confirm the sale and generate a unique folio containing all services in the cart.
- **US-AG09** — As an agent, I want the client to automatically receive their purchase receipt, itinerary, and QR code via Email upon confirming the sale.

#### Real-Time Availability

- **US-AG10** — As an agent, I want to see a clear indication of how many spots remain per service/schedule on the sales screen to avoid selling full services.
- **US-AG11** — As an agent, I want the system to block my sale confirmation if the spot is no longer available at the time of confirmation (protection against race conditions).

#### Daily Cash Drawer

- **US-AG12** — As an agent, I want to see a summary of my daily sales: generated folios, total cash, total pending bookings to be collected.
- **US-AG13** — As an agent, I want to register daily operating expenses (e.g., gasoline, supplies) with amount and description so my cash drawer's net balance is accurate.
- **US-AG14** — As an agent, I want to generate my daily cash closure report with the breakdown of income, expenses, and net balance to submit it to the admin.

#### Access Scanner (QR)

- **US-AG15** — As an agent, I want to use my phone's camera to scan a client's QR code and validate their ticket in real-time against the server, decrementing one pass from the total spots purchased on that ticket.
- **US-AG16** — As an agent, I want the QR validation to work offline, marking the ticket as consumed on my device and syncing when connection is restored. *(Phase 2)*
- **US-AG17** — As an agent, I want to see a clear scan result screen: ✓ Valid (client name, service, schedule, and redemption progress e.g., "Pass 2 of 5 used") or ✗ Invalid (reason: all passes used, expired, fake).
- **US-AG19** — As an agent, I want to see a clear error message if I try to scan a QR code without internet connection, indicating that the validation requires network access.

---

### Client

> In this phase, the client does not interact directly with the app. Their experience is 100% via Email.

- **US-C01** — As a client, I want to automatically receive a purchase receipt via Email with details of my service, schedule, and amount paid at the time of sale.
- **US-C02** — As a client, I want to receive a unique QR code for each purchased service to present as an access ticket.
- **US-C03** — As a client, I want to receive an Email notification if my folio is cancelled to know that my booking is no longer active.

---

## Features by Phase

### Phase 1 — MVP (Initial Scope)

#### 🟢 MUST HAVE
*Critical features required to launch the MVP.*
- [x] **Auth (admin & agent via email/password, verification via Resend)** *(US-A01, US-A02, US-A03, US-A04, US-AG01, US-AG02, US-AG18)*
- [x] **Multitenancy (isolated organizations)** *(Global)* — `docs/multitenancy/multitenancy.spec.md`
- [x] **Staff management (invite via email, edit, deactivate agents)** *(US-A05, US-A06, US-A07, US-A08)* — `docs/staff/staff-management.spec.md`
- [x] **Service catalog with extras and minimum price** *(US-A09, US-A11, US-A13)* — `docs/catalog/service-catalog.spec.md`
- [x] **Schedules/slots with capacity by date and time** *(US-A10)* — `docs/schedules/schedules-slots.spec.md`
- [x] **Mobile point of sale with controlled discount** *(US-AG03, US-AG04, US-AG05, US-AG06, US-AG08)* — `docs/pos/pos-controlled-discount.spec.md`
- [x] **Folio generation with signed QR code (HMAC)** *(US-AG08, US-C02)* — `docs/qr/folio-qr-signing.spec.md`
- [x] **Online QR Scanner** *(US-AG15, US-AG17, US-AG19)* — `docs/scanner/online-qr-scanner.spec.md`
- [x] **Agent's daily cash drawer with operating expenses** *(US-AG12, US-AG13, US-AG14, US-A19)* — `docs/cash-drawer/cash-drawer.spec.md`
- [x] **Total folio cancellation** *(US-A21)* — `docs/cancellation/total-folio-cancellation.spec.md`

#### 🟡 SHOULD HAVE
*Important features that add great value, but the system could operate manually without them in the very first days.*
- [ ] **Bookings/down-payments (partial payment with spot reservation)** *(US-AG07)*
- [ ] **Sending receipt and QR code to client via Email (Resend)** *(US-AG09, US-C01, US-C03)*
- [ ] **Occupancy visual dashboard (admin)** *(US-A14, US-A15, US-A16)*
- [ ] **Commissions: base % per agent + bonus per service** *(US-A12)*
- [ ] **Commission report by period** *(US-A17, US-A18, US-A20)*

### Out of MVP (Phase 2+)

#### 🚀 PHASE 2: Core Enhancements
- [ ] **Offline-capable QR validation with post-sync** *(US-AG16)* - *Deferred from MVP to focus on real-time validation.*
- [ ] **Partial cancellations (per service within the folio)** *(US-A22)* - *Deferred to simplify inventory logic in MVP.*
- [ ] **Cash refund tracking** *(US-A23)* - *To ensure the admin can reconcile physical cash returns.*
- [ ] **Folio audit timeline** *(US-A24)* - *To track the lifecycle of a sale and resolve internal disputes.*

#### 🔵 COULD HAVE
*Nice-to-have features that improve UX if extra time is available.*
- [ ] **Report export (PDF/CSV)** - *Moved from Out of MVP if time permits.*

#### 🔴 WON'T HAVE THIS TIME
*Features explicitly discarded for the MVP.*
- [ ] **Integrated card payments (Stripe, Conekta)** - *Payment integration complexity*
- [ ] **Client self-service online purchase** - *Requires payment gateway and checkout flow*
- [ ] **Native App (iOS / Android)** - *Mobile-first PWA is sufficient for Phase 1*
- [ ] **Discarded: WhatsApp API Integration** - *For cost and speed, ticket delivery is handled via Email instead of WhatsApp.*
- [ ] **Multiple payment methods (card, wire transfer)** - *Cash only in Phase 1*

---

## Key Business Rules

### Inventory

- Each slot (service + date + time) has a `max_capacity` defined by the admin.
- Upon confirming a sale (including bookings), the spots are deducted immediately.
- If the capacity reaches 0 at the time of confirmation (race condition), the sale is rejected with a clear error.
- Upon cancelling a folio, all spots for the involved slots are released.

### Pricing and Discounts

- Each service has a `base_price` and a `minimum_price` (both defined by the admin).
- The agent can reduce the price down to the `minimum_price`, inclusive. Below this, the system blocks the sale.
- Extras have a fixed price; no discounts are applied to them.

### Commissions

- Each agent has a `base_commission` (%) assigned by the admin.
- Each service can have an additional `commission_bonus` (%) defined by the admin.
- Total commission per sales line = `(sold_price × base_commission) + (sold_price × commission_bonus)`.
- Commissions are calculated on the final sold price (post-discount), not on the base price.
- Bookings/down-payments generate commissions only on the amount actually collected until the cash closure.

### Bookings (Down-payment / Partial Payment)

- A booking reserves the slot capacity just like a full sale.
- The agent registers the received amount (`booking_amount`) and the pending balance is calculated automatically.
- The folio remains in a `booking` state until the remaining balance is collected, transitioning to `paid`.

### QR and Access Validation

- **Group Tickets (Partial Redemption):** A single QR code is generated per service in a folio, representing the total number of spots purchased (e.g., 5 passes for 5 friends). Each successful scan redeems exactly 1 pass. If the QR is scanned after all passes have been consumed, it throws an "✗ Invalid (All passes consumed)" error.
- **Prepared for Offline:** The QR contains a JSON payload signed with HMAC-SHA256 using a `QR_SECRET` per organization. This structure guarantees that Phase 2 offline validation can be implemented securely without changing the issued tickets.
- The payload includes: `folio_id`, `service_id`, `slot_id`, `client_identity`, `expires_at`. (The server knows the total purchased spots based on the folio).
- **Phase 1 (Strictly Online):** The agent app validates the QR exclusively against the server. The server tracks the redemption count in real-time. If there is no internet connection, the system throws a network error to the agent, refusing the scan.
- **Phase 2 (Offline capabilities):** Offline validation will verify the signature locally (invalid signature → ✗ Fake). Consumed tickets will be stored in `localStorage` of the scanning agent's device and synced to the server (`POST /api/tickets/sync`) once connection is restored. The server remains the single source of truth.

### Multitenancy

- All data (services, agents, folios, slots) belongs to an `organization_id`.
- An agent can only view and sell services from their own organization.
- The admin only manages their own organization.

---

## External Integrations

| Service | Purpose |
|---|---|
| **Agnostic Auth** (Cloudflare Worker) | JWT issuance for sessions (internal token generator) |
| **Resend** | Transactional emails: admin verification, agent invitation, password reset, and **client ticket delivery** |
| **Cloudflare D1** | Primary database (SQLite) |
| **Cloudflare Workers** | Backend runtime (Hono) |

---

## Glossary

| Term | Definition |
|---|---|
| **Folio** | Record of a complete sale. Can include one or more services. Has a unique ID and one QR code per service. |
| **Slot** | An instance of a service at a specific date and time, with its own maximum capacity. |
| **Extra** | Optional product or service added to a folio (e.g., photo, insurance). |
| **Booking (Apartado)** | Folio with a partial payment that reserves capacity but remains pending complete collection. |
| **Cash closure (Corte de caja)** | Agent's daily summary: sales, operating expenses, and net balance. |
| **Minimum price (Precio mínimo)** | Price floor per service defined by the admin. The agent cannot sell below it. |
| **Commission bonus (Bonus de comisión)** | Additional commission percentage defined by the admin for a specific service. |
