import { useState, type ReactElement } from 'react'
import { Alert, Box, Button, CircularProgress, Stack, Typography } from '@mui/material'
import type { SvgIconComponent } from '@mui/icons-material'
import CheckCircleRounded from '@mui/icons-material/CheckCircleRounded'
import ErrorRounded from '@mui/icons-material/ErrorRounded'
import LinkOffRounded from '@mui/icons-material/LinkOffRounded'
import PauseCircleRounded from '@mui/icons-material/PauseCircleRounded'
import ScheduleRounded from '@mui/icons-material/ScheduleRounded'
import SyncProblemRounded from '@mui/icons-material/SyncProblemRounded'
import WarningAmberRounded from '@mui/icons-material/WarningAmberRounded'
import { AlertCard, ConfirmSheet, SectionCard, StatusChip } from '../../../components'
import type { StatusTone } from '../../../components'
import { useOrgDateFormatter } from '../../organization'
import {
  brokenReasonCopy,
  CONNECTION_HEALTH_COPY,
  CONNECTION_MODE_COPY,
  CONNECTION_STATUS_COPY,
  keyHintCopy,
  lastVerdictCopy,
  previousKeyCopy,
  type ConnectionHealth,
} from '../copy'
import { useDevoladaConnection, useDisconnectDevolada } from '../hooks/useDevoladaConnection'
import type { DevoladaConnectionView, OrganizationDevoladaSummary } from '../types'
import { ConnectDevoladaSheet } from './ConnectDevoladaSheet'

const DATE_FMT: Intl.DateTimeFormatOptions = {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
}

// Functional colour, icon-paired, never teal (constitution VII): the status always reads in words.
const STATUS_CHIP: Record<OrganizationDevoladaSummary['status'], { tone: StatusTone; icon: ReactElement }> = {
  connected: { tone: 'success', icon: <CheckCircleRounded /> },
  broken: { tone: 'error', icon: <ErrorRounded /> },
  disconnected: { tone: 'neutral', icon: <LinkOffRounded /> },
  not_connected: { tone: 'neutral', icon: <LinkOffRounded /> },
}

const HEALTH_LINE: Record<ConnectionHealth, { text: string; color: string; Icon: SvgIconComponent }> = {
  working: { text: CONNECTION_HEALTH_COPY.working, color: 'success.main', Icon: CheckCircleRounded },
  failing: { text: CONNECTION_HEALTH_COPY.failing, color: 'warning.main', Icon: SyncProblemRounded },
  credit_paused: { text: CONNECTION_HEALTH_COPY.credit_paused, color: 'warning.main', Icon: PauseCircleRounded },
  periodic_only: { text: CONNECTION_HEALTH_COPY.periodic_only, color: 'text.secondary', Icon: ScheduleRounded },
}

// FR-005 — first match wins. An environment that registers no address expects no notification
// (D3), so nothing about the address is a failure there; a paused validation credit holds every
// verdict until the admin tops it up at Devolada, so it outranks the address's failures. Devolada
// out of reach (`webhook` null) reads as failing: nothing says the notifications arrive.
const connectionHealth = ({
  webhook,
  credit_paused_since,
  health_error,
}: DevoladaConnectionView): ConnectionHealth => {
  if (webhook?.is_ours === null) return 'periodic_only'
  if (credit_paused_since !== null) return 'credit_paused'
  if (
    health_error !== null ||
    webhook === null ||
    webhook.is_ours === false ||
    webhook.consecutive_failures > 0 ||
    webhook.failed_deliveries > 0
  ) {
    return 'failing'
  }
  return 'working'
}

/**
 * devolada-transfer-verification US1 — «Cobro con Devolada» in Ajustes (research D16): the
 * connection's status, mode, key and notification health (FR-005), and each previous key that
 * still has pending enlaces (D21). It is the one place the admin learns the connection broke, and
 * why (spec clarification of 2026-10-16). Admin only, like the endpoint it reads.
 */
export function DevoladaConnectionCard() {
  const { data: connection, isError } = useDevoladaConnection()
  const disconnect = useDisconnectDevolada()
  // Constitution II — an instant reads in the organization's time zone, never the device's.
  const formatDate = useOrgDateFormatter(DATE_FMT)
  const [connecting, setConnecting] = useState(false)
  const [disconnecting, setDisconnecting] = useState(false)

  const status = connection?.status ?? 'not_connected'
  // A current key exists only while connected or broken; disconnected has none (D21).
  const live = status === 'connected' || status === 'broken'
  const health = connection && live ? HEALTH_LINE[connectionHealth(connection)] : null

  return (
    <>
      <SectionCard
        title="Cobro con Devolada"
        action={
          connection !== undefined ? (
            <StatusChip
              tone={STATUS_CHIP[status].tone}
              icon={STATUS_CHIP[status].icon}
              label={CONNECTION_STATUS_COPY[status]}
            />
          ) : undefined
        }
      >
        {connection === undefined ? (
          isError ? (
            <Alert severity="error">No se pudo cargar la conexión con Devolada. Inténtalo de nuevo.</Alert>
          ) : (
            <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}>
              <CircularProgress aria-label="Cargando la conexión con Devolada" />
            </Box>
          )
        ) : (
          <Stack spacing={2}>
            {connection?.status === 'broken' && (
              <AlertCard tone="error" title={brokenReasonCopy(connection.broken_reason)} />
            )}

            {connection?.key_hint != null && (
              <Stack spacing={1}>
                <Typography sx={{ fontWeight: 600 }}>
                  {connection.mode
                    ? `${CONNECTION_MODE_COPY[connection.mode]} · ${keyHintCopy(connection.key_hint)}`
                    : keyHintCopy(connection.key_hint)}
                </Typography>
                {health && (
                  <Typography
                    sx={{ display: 'flex', alignItems: 'center', gap: 1, color: health.color, fontWeight: 600 }}
                  >
                    <health.Icon fontSize="small" />
                    {health.text}
                  </Typography>
                )}
                {connection.last_verdict_at !== null && (
                  <Typography variant="body2" color="textSecondary">
                    {lastVerdictCopy(formatDate(connection.last_verdict_at))}
                  </Typography>
                )}
              </Stack>
            )}

            {/* D21 — in every status, disconnected included: a retired key still follows its
                enlaces, and revoking it at Devolada would send their sales back to Por verificar. */}
            {connection && connection.previous_keys.length > 0 && (
              <Stack spacing={1}>
                {connection.previous_keys.map((key, i) => (
                  <Box key={`${key.key_hint}-${i}`} sx={{ display: 'flex', alignItems: 'flex-start', gap: 1 }}>
                    <WarningAmberRounded fontSize="small" sx={{ color: 'warning.main', mt: 0.25 }} />
                    <Typography variant="body2">{previousKeyCopy(key)}</Typography>
                  </Box>
                ))}
              </Stack>
            )}

            {/* One primary action per card. Replacing the key is the same PUT as connecting (D21). */}
            {live ? (
              <Stack spacing={1}>
                <Button variant="contained" size="large" fullWidth onClick={() => setConnecting(true)}>
                  Cambiar clave
                </Button>
                <Button
                  fullWidth
                  onClick={() => {
                    disconnect.reset()
                    setDisconnecting(true)
                  }}
                  sx={{ color: 'text.secondary' }}
                >
                  Desconectar
                </Button>
              </Stack>
            ) : (
              <Button variant="contained" size="large" fullWidth onClick={() => setConnecting(true)}>
                Conectar
              </Button>
            )}
          </Stack>
        )}
      </SectionCard>

      <ConnectDevoladaSheet open={connecting} onClose={() => setConnecting(false)} />

      {/* FR-004 — disconnecting stops new enlaces only: the ones already sent are followed to their
          verdict, each with its own key. */}
      <ConfirmSheet
        open={disconnecting}
        onClose={() => setDisconnecting(false)}
        title="¿Desconectar Devolada?"
        description="Las transferencias nuevas se verificarán a mano. Los enlaces de pago que ya se enviaron se seguirán verificando hasta que terminen."
        confirmLabel="Desconectar"
        busy={disconnect.isPending}
        onConfirm={() => disconnect.mutate(undefined, { onSuccess: () => setDisconnecting(false) })}
        error={
          disconnect.isError ? (
            <Alert severity="error">No se pudo desconectar Devolada. Inténtalo de nuevo.</Alert>
          ) : undefined
        }
      />
    </>
  )
}
