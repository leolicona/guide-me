import { useParams, useLocation, Link as RouterLink } from 'react-router-dom'
import {
  Box,
  Typography,
  Button,
  Card,
  CardContent,
  CircularProgress,
  Alert,
  Fade,
  Stack,
  Divider,
} from '@mui/material'
import { useFolio, useFolioCancellationQuote } from '../features/pos/hooks'
import { PaymentBreakdown } from '../features/pos/components/PaymentBreakdown'
import {
  ReceiptPaymentChip,
  ReceiptPaymentStatus,
  ReceiptVerificationNote,
} from '../features/pos/components/ReceiptPaymentStatus'
import { TicketQr } from '../features/pos/components/TicketQr'
import {
  BookingActions,
  ExpiredBookingBanner,
  TicketWhatsAppButton,
  DeliveryBadge,
} from '../features/bookings'
import { PaymentLinkCard, type PaymentLinkError } from '../features/devolada'
import { useMyOrganization } from '../features/organization'
import { useMe } from '../features/auth/hooks/useMe'
import { formatMoney } from '../features/catalog/types'
import { folioLineMeta } from '../features/folios/folioLineLabel'
import { FolioStatusChip } from '../features/folios'
import { SectionCard } from '../components'
import { ROUTES } from '../config/routes'
import type { DisplayMethod } from '../features/pos/types'

const PAYMENT_METHOD_LABEL: Record<DisplayMethod, string> = {
  cash: 'Efectivo',
  transfer: 'Transferencia',
  card: 'Tarjeta',
  link: 'Link de pago',
  Mixto: 'Mixto', // US-LG08 — a folio collected by more than one method
}

export default function FolioReceiptPage() {
  const { id } = useParams<{ id: string }>()
  const { data: folio, isLoading, isError } = useFolio(id)
  // Same request as above (shared query key) — US-A76: what cancelling now would cost.
  const { data: quote, isLoading: quoteLoading } = useFolioCancellationQuote(id)
  // devolada-transfer-verification D16 — the enlace's message carries the names the ticket's does
  // (TicketWhatsAppButton), and its expiry reads in the organization's zone.
  const { data: org } = useMyOrganization()
  const { data: me } = useMe()
  // D6 — why the checkout got no enlace, when it answered one (PosCheckoutPage passes it).
  const location = useLocation()
  const paymentLinkError = (location.state as { paymentLinkError?: PaymentLinkError } | null)
    ?.paymentLinkError

  const isBooking = folio?.status === 'booking'
  // A cancelled folio that carries a booking expiry was an apartado (US-AG07.5 late arrival).
  const isExpiredBooking =
    folio?.status === 'cancelled' && folio?.booking_expires_at != null

  return (
    <Fade in timeout={400}>
      <Box sx={{ maxWidth: 640, mx: 'auto' }}>
        {isLoading && (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
            <CircularProgress />
          </Box>
        )}

        {isError && (
          <Alert severity="error">No se pudo cargar esta venta. Inténtalo de nuevo.</Alert>
        )}

        {folio && (
          <Stack spacing={3}>
            <Box sx={{ textAlign: 'center' }}>
              {/* devolada-transfer-verification D16 — never «Venta confirmada» for a transfer
                  nobody has verified; and the sale is a Venta, so no «Folio {id}» line
                  (constitution VII). */}
              <ReceiptPaymentStatus folio={folio} />
              {folio.customer_email && (
                <Typography variant="body2" color="success" sx={{ mt: 1 }}>
                  📧 {isBooking ? 'Comprobante de apartado enviado a' : 'Recibo enviado a'}{' '}
                  {folio.customer_email}
                </Typography>
              )}
            </Box>

            {/* devolada-transfer-verification D16 — the sale's latest enlace, a failed one
                included, right under the status: sending it is how the seller collects (FR-008).
                When the checkout could create none, the card says why (FR-010). It renders
                nothing for a sale without Devolada. */}
            <PaymentLinkCard
              link={folio.payment_links?.[0] ?? null}
              error={paymentLinkError ?? null}
              message={{
                folio,
                agentName: me?.name ?? '',
                orgName: org?.name ?? 'Turistear Ya!',
                timezone: org?.timezone,
              }}
            />

            <ExpiredBookingBanner folio={folio} />

            {/* US-A67 — a transfer whose money an admin hasn't verified yet: no QR, no delivery. */}
            <ReceiptVerificationNote folio={folio} />

            {/* whatsapp-qr-delivery — the primary post-payment action: send the portal link (QR +
                itinerary) over WhatsApp. Leads the receipt for a paid folio; the QR below is the
                in-person fallback. Pendiente → Enviado → Visto shown alongside. */}
            {folio.status === 'paid' && folio.portal_link && (
              <SectionCard>
                <Stack spacing={1.5}>
                  <Stack
                    direction="row"
                    sx={{ alignItems: 'center', justifyContent: 'space-between' }}
                  >
                    <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
                      Entregar boletos
                    </Typography>
                    <DeliveryBadge folio={folio} />
                  </Stack>
                  <TicketWhatsAppButton folio={folio} surface="seller" variant="primary" />
                  {/* The "Pendiente de enviar" chip above already states this fact — a second
                      amber line saying it again is noise (design review, Should Fix 1). */}
                </Stack>
              </SectionCard>
            )}

            <Card>
              <CardContent>
                <Stack
                  direction="row"
                  sx={{ justifyContent: 'space-between', alignItems: 'center', mb: 2 }}
                >
                  <Typography variant="h6">Recibo</Typography>
                  <ReceiptPaymentChip folio={folio} />
                </Stack>

                {(folio.customer_name || folio.customer_email) && (
                  <Typography variant="body2" color="textSecondary" sx={{ mb: 2 }}>
                    {folio.customer_name}
                    {folio.customer_name && folio.customer_email ? ' · ' : ''}
                    {folio.customer_email}
                  </Typography>
                )}

                <Stack spacing={2} divider={<Divider flexItem />}>
                  {folio.lines.map((line) => (
                    <Box key={line.id}>
                      <Stack
                        direction="row"
                        sx={{ justifyContent: 'space-between', alignItems: 'flex-start' }}
                      >
                        <Box sx={{ minWidth: 0 }}>
                          <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                            <Typography variant="subtitle2">{line.service_name}</Typography>
                            {/* US-AG54 — the line's own state, only when it differs from the
                                folio's: a mixed apartado names the odd one out. */}
                            {line.money_state && line.money_state !== folio.status && (
                              <FolioStatusChip status={line.money_state} />
                            )}
                          </Stack>
                          <Typography variant="caption" color="textSecondary">
                            {folioLineMeta(line)} · {formatMoney(line.unit_price)}
                          </Typography>
                          {line.extras.map((e) => (
                            <Typography
                              key={e.id}
                              variant="caption"
                              color="textSecondary"
                              sx={{ display: 'block' }}
                            >
                              + {e.quantity}× {e.name} ({formatMoney(e.price)})
                            </Typography>
                          ))}
                        </Box>
                        <Typography variant="subtitle2">
                          {formatMoney(line.line_total)}
                        </Typography>
                      </Stack>
                    </Box>
                  ))}
                </Stack>

                <Divider sx={{ my: 2 }} />
                <Stack spacing={1}>
                  <Stack direction="row" sx={{ justifyContent: 'space-between' }}>
                    <Typography color="textSecondary">Subtotal</Typography>
                    <Typography>{formatMoney(folio.subtotal)}</Typography>
                  </Stack>
                  {folio.discount_total > 0 && (
                    <Stack direction="row" sx={{ justifyContent: 'space-between' }}>
                      <Typography color="textSecondary">Descuento</Typography>
                      <Typography>−{formatMoney(folio.discount_total)}</Typography>
                    </Stack>
                  )}
                  <Stack direction="row" sx={{ justifyContent: 'space-between' }}>
                    <Typography variant="h6">Total</Typography>
                    <Typography variant="h6">{formatMoney(folio.total)}</Typography>
                  </Stack>
                  <Stack direction="row" sx={{ justifyContent: 'space-between' }}>
                    <Typography color="textSecondary">{isBooking ? 'Anticipo' : 'Pagado'}</Typography>
                    <Typography>{formatMoney(folio.amount_paid)}</Typography>
                  </Stack>
                  {isBooking && (
                    <Stack direction="row" sx={{ justifyContent: 'space-between' }}>
                      <Typography color="textSecondary">Saldo pendiente</Typography>
                      <Typography color="primary">
                        {formatMoney(folio.pending_balance ?? folio.total - folio.amount_paid)}
                      </Typography>
                    </Stack>
                  )}
                  <Stack direction="row" sx={{ justifyContent: 'space-between' }}>
                    <Typography color="textSecondary">Método de pago</Typography>
                    <Typography>{PAYMENT_METHOD_LABEL[folio.payment_method]}</Typography>
                  </Stack>
                </Stack>

                {/* US-LG08 — the per-payment breakdown (deposit vs balance, each method), when the
                    folio was collected in more than one movement. */}
                {folio.payments && folio.payments.length > 1 && (
                  <>
                    <Divider sx={{ my: 2 }} />
                    <PaymentBreakdown
                      payments={folio.payments}
                      verificationAuto={folio.verification_auto}
                    />
                  </>
                )}
              </CardContent>
            </Card>

            {/* Access QRs apply to scannable (tour) lines only — a lodging stay's access is its
                reservation, not a per-line QR, so it's excluded here. */}
            {folio.status === 'paid' && folio.lines.some((l) => l.qr_token) && (
              <Box>
                <Typography variant="h6" sx={{ mb: 1.5 }}>
                  Boletos de acceso
                </Typography>
                <Typography variant="body2" color="textSecondary" sx={{ mb: 2 }}>
                  Un QR por servicio. El cliente lo presenta a la entrada; un agente lo escanea
                  para canjear un pase.
                </Typography>
                <Stack spacing={2}>
                  {folio.lines
                    .filter((line) => line.qr_token)
                    .map((line) => (
                      <TicketQr key={line.id} line={line} />
                    ))}
                </Stack>
              </Box>
            )}

            {/* US-AG07/07.4/07.5 — Liquidar/Cancelar (live) or Reactivar (expired). Shared with
                the Ventas folio detail so both stay in sync. */}
            <BookingActions folio={folio} quote={quote} quoteLoading={quoteLoading} />

            <Button
              variant={isBooking || isExpiredBooking ? 'text' : 'contained'}
              disableElevation
              component={RouterLink}
              to={ROUTES.POS}
            >
              Nueva venta
            </Button>
          </Stack>
        )}
      </Box>
    </Fade>
  )
}
