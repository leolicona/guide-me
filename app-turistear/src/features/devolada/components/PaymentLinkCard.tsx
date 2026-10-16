import { Box, Button, Stack, Typography } from '@mui/material'
import WhatsAppIcon from '@mui/icons-material/WhatsApp'
import { AlertCard, MoneyText, SectionCard } from '../../../components'
import {
  linkExpiryPhrase,
  paymentLinkWhatsAppUrl,
  type PaymentLinkMessageContext,
} from '../../pos/delivery'
import { linkNotCreatedCopy } from '../copy'
import type { PaymentLinkError, PaymentLinkView } from '../types'
import { PaymentLinkStatusChip } from './PaymentLinkStatusChip'

export interface PaymentLinkCardProps {
  /** The sale's link to show — its latest, a failed one included. */
  link: PaymentLinkView | null
  /** Why the checkout or settlement got no enlace, when it answered one. */
  error?: PaymentLinkError | null
  /** Everything the WhatsApp message needs: the sale, the seller, the organization and its zone. */
  message: PaymentLinkMessageContext
}

// devolada-transfer-verification D16 — «Enlace de pago»: the amount, the label, when it expires
// while it is open, and the one action that collects it: «Cobrar por WhatsApp». When no enlace
// could be created, the card says so and that an admin will verify the transfer (FR-010).
export function PaymentLinkCard({ link, error, message }: PaymentLinkCardProps) {
  const failed = !link || link.label === 'link_failed'
  if (!link && !error) return null
  const open = link?.state === 'open'
  const waUrl = link && open ? paymentLinkWhatsAppUrl(link, message) : null

  return (
    <SectionCard title="Enlace de pago" action={link ? <PaymentLinkStatusChip label={link.label} /> : undefined}>
      <Stack spacing={2}>
        {link && (
          <Box>
            <MoneyText cents={link.amount} variant="h3" srLabel="Monto del enlace" />
            {open && (
              <Typography variant="body2" color="textSecondary" sx={{ mt: 0.5 }}>
                Vence {linkExpiryPhrase(link.expires_at, message.timezone, message.nowMs)}
              </Typography>
            )}
          </Box>
        )}
        {(failed || error) && <AlertCard tone="warning" title={linkNotCreatedCopy(error)} />}
        {open && (
          <Button
            variant="contained"
            size="large"
            startIcon={<WhatsAppIcon />}
            disabled={!waUrl}
            onClick={() => waUrl && window.open(waUrl, '_blank')}
            fullWidth
          >
            Cobrar por WhatsApp
          </Button>
        )}
      </Stack>
    </SectionCard>
  )
}
