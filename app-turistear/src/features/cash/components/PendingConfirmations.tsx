import { useState } from 'react'
import { Link as RouterLink } from 'react-router-dom'
import { Alert, Button, Stack, Typography } from '@mui/material'
import { useDrops, useReviewDrop } from '../hooks'
import { DropCard } from './DropCard'
import { ConfirmSheet, MoneyText } from '../../../components'
import { ROUTES } from '../../../config/routes'
import type { CashDrop } from '../types'

/**
 * US-A98 — the top of the team's caja: the hand-ins waiting for a human. This was three taps deep
 * (Equipo → Entregas → Pendientes) while the badge announcing it was repeated on two of those tab
 * rows. It is the one thing an admin opens this screen to do, so it is the first thing on it.
 *
 * Renders NOTHING when there is nothing pending — an empty «Necesitan tu confirmación» heading is
 * a demand for attention that is not owed.
 */
export function PendingConfirmations() {
  const { data: page, isError } = useDrops({ status: 'pending' })
  const drops = page?.drops
  const review = useReviewDrop()
  const [target, setTarget] = useState<CashDrop | null>(null)

  // D16 — confirm AS REQUESTED, with no `amount` in the body. Sending `drop.amount` here would
  // look harmless and turn every plain confirm into an ADJUSTED one, which by US-A28 owes the
  // agent a signature: the screen would silently mint acknowledgment obligations. Adjusting is a
  // deliberate act and lives on the detail, where a corrected figure has room and a reason.
  const confirm = () => {
    if (!target) return
    review.mutate(
      { id: target.id, input: { decision: 'confirmed' } },
      { onSuccess: () => setTarget(null) },
    )
  }

  if (isError) {
    return (
      <Alert severity="error" sx={{ mb: 3 }}>
        No se pudieron cargar las entregas por confirmar. Inténtalo de nuevo.
      </Alert>
    )
  }
  if (!drops || drops.length === 0) return null

  return (
    <Stack spacing={2} sx={{ mb: 4 }}>
      <Typography variant="h3" component="h2">
        {drops.length === 1
          ? 'Una entrega necesita tu confirmación'
          : `${drops.length} entregas necesitan tu confirmación`}
      </Typography>

      {drops.map((drop) => (
        <DropCard
          key={drop.id}
          drop={drop}
          actions={
            <>
              <Button variant="contained" size="small" onClick={() => setTarget(drop)}>
                Confirmar
              </Button>
              <Button
                size="small"
                color="inherit"
                component={RouterLink}
                to={ROUTES.CASH_DROP_DETAIL.replace(':id', drop.id)}
              >
                Revisar
              </Button>
            </>
          }
        />
      ))}

      {/* One tap is still money, so it still asks. Naming the amount AND the person is the point:
          «Confirmar» on a row is only safe when the sheet repeats what is being confirmed. */}
      <ConfirmSheet
        open={!!target}
        onClose={() => setTarget(null)}
        title="¿Recibiste este efectivo?"
        description={
          target
            ? `Confirmas que ${target.agent?.name ?? 'el agente'} te entregó este monto. Se descuenta de su caja de inmediato.`
            : undefined
        }
        detail={
          target ? (
            <MoneyText cents={target.amount} variant="h2" srLabel="Monto de la entrega" />
          ) : undefined
        }
        confirmLabel="Confirmar recibo"
        confirmColor="primary"
        onConfirm={confirm}
        busy={review.isPending}
        error={
          review.isError ? (
            <Alert severity="error">No se pudo confirmar la entrega. Inténtalo de nuevo.</Alert>
          ) : undefined
        }
      />
    </Stack>
  )
}
