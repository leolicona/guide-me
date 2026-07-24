import { useState } from 'react'
import {
  Box,
  Button,
  Stack,
  TextField,
  CircularProgress,
  Alert,
  Typography,
} from '@mui/material'
import AddRounded from '@mui/icons-material/AddRounded'
import GroupsRounded from '@mui/icons-material/GroupsRounded'
import { ListPageHeader, SectionCard, FormSheet, ConfirmSheet } from '../components'
import { OperatorRow } from '../features/operators/components/OperatorRow'
import {
  useOperators,
  useCreateOperator,
  useResetOperatorPin,
  useRemoveOperator,
} from '../features/operators/hooks/useOperators'
import { normalizePhone } from '../features/pos/phone'
import { ServiceError } from '../services/authService'
import type { Operator } from '../features/operators/types'

// US-AF10–AF12 — the affiliate manager's operators panel: register shift cashiers (name + phone),
// send each their WhatsApp access link, and reset / remove them. Operators sell under this one
// hotel account; their sales roll into the single caja and are labeled "Vendido por: {name}".
export default function OperatorsPage() {
  const { data: operators, isLoading, isError } = useOperators()
  const create = useCreateOperator()
  const reset = useResetOperatorPin()
  const remove = useRemoveOperator()

  const [formOpen, setFormOpen] = useState(false)
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [formError, setFormError] = useState<string | null>(null)

  const [toReset, setToReset] = useState<Operator | null>(null)
  const [toRemove, setToRemove] = useState<Operator | null>(null)

  const phoneValid = normalizePhone(phone).valid
  const canSubmit = name.trim().length >= 2 && phoneValid

  const closeForm = () => {
    setFormOpen(false)
    setName('')
    setPhone('')
    setFormError(null)
  }

  const submit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (!canSubmit) return
    setFormError(null)
    create.mutate(
      { name: name.trim(), phone: phone.trim() },
      {
        onSuccess: closeForm,
        onError: (err) => {
          const e = err as ServiceError
          setFormError(
            e.code === 'OPERATOR_PHONE_EXISTS'
              ? 'Ya existe un operador activo con ese teléfono.'
              : 'No se pudo agregar el operador. Inténtalo de nuevo.',
          )
        },
      },
    )
  }

  const active = (operators ?? []).filter((o) => o.status === 'active')
  const removed = (operators ?? []).filter((o) => o.status === 'removed')

  return (
    <Box sx={{ maxWidth: 720, mx: 'auto' }}>
      <ListPageHeader
        title="Operadores"
        action={
          <Button
            variant="contained"
            color="secondary"
            disableElevation
            startIcon={<AddRounded />}
            onClick={() => setFormOpen(true)}
          >
            Agregar operador
          </Button>
        }
      />

      <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
        Registra a tu personal de caja. Cada operador recibe un enlace por WhatsApp, crea su PIN de 4
        dígitos y vende bajo tu cuenta. Todas sus ventas entran a tu caja, etiquetadas con su nombre.
      </Typography>

      {isLoading && (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
          <CircularProgress />
        </Box>
      )}

      {isError && <Alert severity="error">No se pudieron cargar los operadores.</Alert>}

      {operators && operators.length === 0 && (
        <SectionCard>
          <Stack spacing={1.5} sx={{ alignItems: 'center', textAlign: 'center', py: 3 }}>
            <GroupsRounded sx={{ fontSize: 40, color: 'text.disabled' }} />
            <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
              Aún no tienes operadores
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Agrega a tu primer cajero de turno para empezar.
            </Typography>
          </Stack>
        </SectionCard>
      )}

      {operators && operators.length > 0 && (
        <Stack spacing={1.5}>
          {active.map((o) => (
            <OperatorRow key={o.id} operator={o} onReset={setToReset} onRemove={setToRemove} />
          ))}
          {removed.length > 0 && (
            <>
              <Typography
                variant="overline"
                color="text.secondary"
                sx={{ mt: 2, display: 'block' }}
              >
                Retirados
              </Typography>
              {removed.map((o) => (
                <OperatorRow key={o.id} operator={o} onReset={setToReset} onRemove={setToRemove} />
              ))}
            </>
          )}
        </Stack>
      )}

      {/* Register operator */}
      <FormSheet
        open={formOpen}
        onClose={closeForm}
        title="Nuevo operador"
        submitLabel="Agregar"
        onSubmit={submit}
        busy={create.isPending}
        disabled={!canSubmit}
        error={formError ? <Alert severity="error">{formError}</Alert> : undefined}
      >
        <Stack spacing={2.5} sx={{ pt: 1 }}>
          <TextField
            label="Nombre"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Juan Pérez"
            fullWidth
            autoFocus
          />
          <TextField
            label="Teléfono (WhatsApp)"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="55 1234 5678"
            fullWidth
            inputMode="tel"
            error={phone.length > 0 && !phoneValid}
            helperText={
              phone.length > 0 && !phoneValid ? 'Ingresa un número de 10 dígitos' : ' '
            }
          />
        </Stack>
      </FormSheet>

      {/* Reset PIN */}
      <ConfirmSheet
        open={!!toReset}
        onClose={() => setToReset(null)}
        title={`¿Restablecer el PIN de ${toReset?.name ?? ''}?`}
        description="Se genera un enlace nuevo (el anterior deja de funcionar) y el operador deberá crear un PIN otra vez. Úsalo si olvidó su PIN o quedó bloqueado."
        confirmLabel="Restablecer PIN"
        confirmColor="primary"
        busy={reset.isPending}
        onConfirm={() => {
          if (!toReset) return
          reset.mutate(toReset.id, { onSuccess: () => setToReset(null) })
        }}
      />

      {/* Remove */}
      <ConfirmSheet
        open={!!toRemove}
        onClose={() => setToRemove(null)}
        title={`¿Quitar a ${toRemove?.name ?? ''}?`}
        description="Su enlace y PIN dejarán de funcionar de inmediato y no podrá seguir vendiendo. Sus ventas anteriores conservan su nombre."
        confirmLabel="Quitar"
        busy={remove.isPending}
        onConfirm={() => {
          if (!toRemove) return
          remove.mutate(toRemove.id, { onSuccess: () => setToRemove(null) })
        }}
      />
    </Box>
  )
}
