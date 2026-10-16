import { useState, type FormEvent } from 'react'
import { Alert, TextField, Typography } from '@mui/material'
import { ConfirmSheet, FormSheet } from '../../../components'
import { ServiceError } from '../../../services/authService'
import { DEVOLADA_ERROR_COPY, devoladaErrorCopy } from '../copy'
import { useConnectDevolada } from '../hooks/useDevoladaConnection'

// contracts § PUT /organizations/me/devolada, step 1. The server checks the same format before
// anything reaches Devolada; this is the fast feedback, not the guard (constitution IV).
const API_KEY_FORMAT = /^dk_[0-9a-f]{32}$/

export interface ConnectDevoladaSheetProps {
  open: boolean
  onClose: () => void
}

/**
 * devolada-transfer-verification D2, D3, D21 — connect the organization's own Devolada account, or
 * replace its key: the same PUT either way. The key lives in this field only while the sheet is
 * open: it is cleared on close and on success, never logged, and no answer carries it back
 * (FR-003).
 */
export function ConnectDevoladaSheet({ open, onClose }: ConnectDevoladaSheetProps) {
  const connect = useConnectDevolada()
  const [apiKey, setApiKey] = useState('')
  const [badFormat, setBadFormat] = useState(false)
  // D3, FR-006 — the address Devolada notifies today, when it is not ours: the admin decides.
  const [conflictUrl, setConflictUrl] = useState<string | null>(null)

  const close = () => {
    setApiKey('')
    setBadFormat(false)
    setConflictUrl(null)
    connect.reset()
    onClose()
  }

  const send = (replaceWebhook: boolean) =>
    connect.mutate(
      replaceWebhook ? { api_key: apiKey.trim(), replace_webhook: true } : { api_key: apiKey.trim() },
      {
        onSuccess: close,
        onError: (error) => {
          // The 409's message is the address registered now (contracts § Connection).
          if (error instanceof ServiceError && error.code === 'DEVOLADA_WEBHOOK_CONFLICT') {
            setConflictUrl(error.message)
          }
        },
      },
    )

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (!API_KEY_FORMAT.test(apiKey.trim())) {
      setBadFormat(true)
      return
    }
    send(false)
  }

  // Every refusal reads as its copy (contracts § Action copy). The address conflict is a question,
  // not a refusal, so it shows none.
  const code = connect.error instanceof ServiceError ? connect.error.code : null
  const refusal =
    connect.isError && code !== 'DEVOLADA_WEBHOOK_CONFLICT' ? (
      <Alert severity="error">{devoladaErrorCopy(code)}</Alert>
    ) : undefined

  return (
    <>
      <FormSheet
        open={open}
        onClose={close}
        title="Conectar Devolada"
        submitLabel="Conectar"
        onSubmit={onSubmit}
        busy={connect.isPending}
        error={conflictUrl === null ? refusal : undefined}
      >
        <TextField
          label="Clave de API de Devolada"
          fullWidth
          value={apiKey}
          onChange={(e) => {
            setApiKey(e.target.value)
            setBadFormat(false)
          }}
          disabled={connect.isPending}
          error={badFormat}
          helperText={badFormat ? DEVOLADA_ERROR_COPY.VALIDATION_ERROR : undefined}
          // A pasted key, all lowercase: no autofill, no capital letter or correction from a phone
          // keyboard.
          autoComplete="off"
          slotProps={{ htmlInput: { spellCheck: false, autoCapitalize: 'none', autoCorrect: 'off' } }}
        />
      </FormSheet>

      {/* Declared after the FormSheet, so it opens on top of it (ConfirmSheet's contract).
          Cancelling only closes the question: nothing is replaced, and the key waits in its sheet. */}
      <ConfirmSheet
        open={conflictUrl !== null}
        onClose={() => {
          setConflictUrl(null)
          connect.reset()
        }}
        title="¿Reemplazar la dirección de avisos?"
        description="Devolada envía los avisos de tu negocio a otra dirección. Si la reemplazas, esa dirección dejará de recibirlos."
        detail={<Typography sx={{ fontWeight: 600, overflowWrap: 'anywhere' }}>{conflictUrl}</Typography>}
        confirmLabel="Reemplazar"
        confirmColor="primary"
        onConfirm={() => send(true)}
        busy={connect.isPending}
        error={conflictUrl === null ? undefined : refusal}
      />
    </>
  )
}
