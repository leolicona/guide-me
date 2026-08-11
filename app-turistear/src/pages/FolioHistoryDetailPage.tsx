import { useParams, Link as RouterLink } from 'react-router-dom'
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
  Chip,
} from '@mui/material'
import ArrowBackRounded from '@mui/icons-material/ArrowBackRounded'
import { useFolio, useFolioCancellationQuote, useFolioEvents } from '../features/pos/hooks'
import { useOrgDateFormatter } from '../features/organization'
import { TicketQr } from '../features/pos/components/TicketQr'
import { BookingActions, TicketWhatsAppButton, DeliveryBadge } from '../features/bookings'
import { FolioStatusChip, FolioTimeline, folioTimeChip, useNowSeconds } from '../features/folios'
import { MoneyText, SectionCard, StatusChip } from '../components'
import { formatMoney } from '../features/catalog/types'
import { folioLineMeta } from '../features/folios/folioLineLabel'
import { ROUTES } from '../config/routes'

const DATE_FMT: Intl.DateTimeFormatOptions = {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
}

// US-AG21 — read-only detail of one of the agent's own folios (answer customer queries,
// re-show the QR). Reuses GET /api/pos/folios/:id via useFolio. Status-aware framing; no
// cancel/edit affordance (cancellation is admin-only).
export default function FolioHistoryDetailPage() {
  const formatDate = useOrgDateFormatter(DATE_FMT) // US-A66 — org-local audit timestamps
  const { id } = useParams<{ id: string }>()
  const { data: folio, isLoading, isError } = useFolio(id)
  // Same request as above (shared query key) — US-A76: what cancelling now would cost.
  const { data: quote, isLoading: quoteLoading } = useFolioCancellationQuote(id)
  // US-AG53 — same request again: the narrative the admin reads, identical here (timeline D6).
  const { data: events } = useFolioEvents(id)
  // US-A84 D19 — the clock resolves in an effect, never `Date.now()` in render: this page sits
  // open while the agent talks to the customer, and a frozen countdown is a wrong screen.
  const nowSeconds = useNowSeconds()

  const isBooking = folio?.status === 'booking'
  // The same time channel the list card derives — one clock, whichever the folio runs against.
  const timeChip = folio ? folioTimeChip(folio, nowSeconds) : null

  return (
    <Fade in timeout={400}>
      <Box sx={{ maxWidth: 640, mx: 'auto' }}>
        <Button
          component={RouterLink}
          to={ROUTES.HISTORY}
          startIcon={<ArrowBackRounded />}
          sx={{ mb: 2 }}
        >
          Historial
        </Button>

        {isLoading && (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
            <CircularProgress />
          </Box>
        )}

        {isError && (
          <Alert severity="error">
            No se pudo cargar este folio. Inténtalo de nuevo.
          </Alert>
        )}

        {folio && (
          <Stack spacing={3}>
            {/* Stacked header, ONE chip row in the admin detail's fixed order — money ·
                clearance · time — so both surfaces teach the same position per axis (design
                review, Must Fix 2). */}
            <Box>
              <Typography variant="h5" component="h1" sx={{ pr: { xs: 7, md: 0 } }}>
                Folio
              </Typography>
              <Typography variant="caption" color="text.secondary">
                {folio.id} · {formatDate(folio.created_at)}
              </Typography>
              {/* Who the sale is for, with the identity — not inside the payment card, where a
                  shared border made the name parse as sale data (same move as the admin detail). */}
              {(folio.customer_name || folio.customer_email) && (
                <Typography variant="body2" sx={{ mt: 0.5 }}>
                  {folio.customer_name}
                  {folio.customer_name && folio.customer_email ? ' · ' : ''}
                  {folio.customer_email}
                </Typography>
              )}
              {/* One StatusChip per active axis, same vocabulary as the admin detail (D8): an
                  axis at its default value says nothing here. The time chip derives from
                  useNowSeconds (D19), never Date.now() in render. */}
              <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap', mt: 1 }}>
                <FolioStatusChip status={folio.status} />
                {folio.payment_verification === 'pending' && (
                  <StatusChip status="pending" label="Por verificar" />
                )}
                {timeChip && (
                  <Chip
                    size="small"
                    variant="outlined"
                    color={timeChip.tone}
                    label={timeChip.label}
                  />
                )}
              </Stack>
            </Box>

            {/* No banners: the cancellation notice moved into the Historial (D6: same anatomy as
                the admin detail) and `ExpiredBookingBanner` retired — the chips say the state,
                the `cancelled` row says when and why. */}

            {/* US-AG53 — the sale as a story, COLLAPSED between the state and the money (D6:
                identical placement to the admin detail). The POS detail carries no folio-level
                fulfilment, so the Salida marker ships date-only here. */}
            <FolioTimeline events={events} lines={folio.lines} collapsible />

            <Card>
              <CardContent>
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
                          <Typography variant="caption" color="text.secondary">
                            {folioLineMeta(line)} · {formatMoney(line.unit_price)}
                          </Typography>
                          {line.extras.map((e) => (
                            <Typography
                              key={e.id}
                              variant="caption"
                              color="text.secondary"
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
                    <Typography color="text.secondary">Subtotal</Typography>
                    <Typography>{formatMoney(folio.subtotal)}</Typography>
                  </Stack>
                  {folio.discount_total > 0 && (
                    <Stack direction="row" sx={{ justifyContent: 'space-between' }}>
                      <Typography color="text.secondary">Descuento</Typography>
                      <Typography>−{formatMoney(folio.discount_total)}</Typography>
                    </Stack>
                  )}
                  <Stack direction="row" sx={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
                    <Typography variant="h6">Total</Typography>
                    <MoneyText cents={folio.total} variant="h4" srLabel="Total" />
                  </Stack>
                  <Stack direction="row" sx={{ justifyContent: 'space-between' }}>
                    <Typography color="text.secondary">
                      {isBooking ? 'Anticipo' : 'Pagado'}
                    </Typography>
                    <Typography className="numeric">{formatMoney(folio.amount_paid)}</Typography>
                  </Stack>
                  {isBooking && (
                    <Stack direction="row" sx={{ justifyContent: 'space-between' }}>
                      <Typography color="text.secondary">Saldo pendiente</Typography>
                      {/* Owed by the customer — neutral ink, not teal. */}
                      <Typography className="numeric">
                        {formatMoney(folio.pending_balance ?? folio.total - folio.amount_paid)}
                      </Typography>
                    </Stack>
                  )}
                </Stack>
              </CardContent>
            </Card>

            {/* whatsapp-qr-delivery — re-send the tickets over WhatsApp from history. */}
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

            {/* QR access only exists once the folio is paid — a live/expired apartado has none. */}
            {folio.status === 'paid' && (
              <Box>
                <Typography variant="h6" sx={{ mb: 1.5 }}>
                  Boletos de acceso
                </Typography>
                <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                  Un QR por servicio. El cliente lo presenta a la entrada; un agente lo escanea
                  para canjear un pase.
                </Typography>
                <Stack spacing={2}>
                  {folio.lines.map((line) => (
                    <TicketQr key={line.id} line={line} />
                  ))}
                </Stack>
              </Box>
            )}

            {/* US-AG07/07.4/07.5 — Liquidar/Cancelar (live) or Reactivar (expired), dynamically
                incorporated into this existing detail. Renders nothing for paid/plain folios. */}
            <BookingActions folio={folio} quote={quote} quoteLoading={quoteLoading} />

          </Stack>
        )}
      </Box>
    </Fade>
  )
}
