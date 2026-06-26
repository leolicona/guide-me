import { useState } from 'react'
import {
  Dialog,
  Box,
  Typography,
  Button,
  Stack,
  Alert,
  CircularProgress,
  TextField,
  Chip,
} from '@mui/material'
import AddRounded from '@mui/icons-material/AddRounded'
import { useQuery } from '@tanstack/react-query'
import { WizardShell } from '../../../components'
import { listServices } from '../../../services/catalogService'
import { useCreateAffiliate } from '../hooks/useAffiliates'
import { CommissionCatalogEditor } from './CommissionCatalogEditor'
import {
  draftToEntries,
  draftsValid,
  enabledCount,
  type CommissionDraftMap,
} from '../commission'

const TOTAL_STEPS = 3
const STEP_TITLES: Record<number, string> = {
  1: 'Datos de la empresa',
  2: 'Catálogo y comisiones',
  3: 'Invitaciones',
}
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

interface Props {
  open: boolean
  onClose: () => void
  onCreated: (affiliateId: string) => void
}

// US-A54–A57 — affiliate setup wizard. Mirrors the service-creation wizard shell (full-screen
// bottom sheet on mobile, fixed header + footer, progress). Create-only; one atomic save on
// Finalizar (D9): nothing persists until then.
export function AffiliateWizard({ open, onClose, onCreated }: Props) {
  const [step, setStep] = useState(1)
  const [name, setName] = useState('')
  const [contactEmail, setContactEmail] = useState('')
  const [contactPhone, setContactPhone] = useState('')
  const [commissions, setCommissions] = useState<CommissionDraftMap>({})
  const [invites, setInvites] = useState<string[]>([])
  const [emailInput, setEmailInput] = useState('')
  const [emailError, setEmailError] = useState('')
  const [confirmDiscard, setConfirmDiscard] = useState(false)

  const servicesQuery = useQuery({
    queryKey: ['services', 'active'],
    queryFn: () => listServices('active'),
  })
  const createMutation = useCreateAffiliate()

  const isDirty =
    name.trim() !== '' ||
    contactEmail !== '' ||
    contactPhone !== '' ||
    enabledCount(commissions) > 0 ||
    invites.length > 0

  const resetAll = () => {
    setStep(1)
    setName('')
    setContactEmail('')
    setContactPhone('')
    setCommissions({})
    setInvites([])
    setEmailInput('')
    setEmailError('')
    setConfirmDiscard(false)
    createMutation.reset()
  }

  const doClose = () => {
    resetAll()
    onClose()
  }

  const handleClose = () => {
    if (createMutation.isPending) return
    if (isDirty) setConfirmDiscard(true)
    else doClose()
  }

  const nameValid = name.trim().length > 0
  const step2Valid = draftsValid(commissions)
  const canNext = step === 1 ? nameValid : step === 2 ? step2Valid : true

  const addInvite = () => {
    const e = emailInput.trim().toLowerCase()
    if (!EMAIL_RE.test(e)) {
      setEmailError('Correo inválido')
      return
    }
    if (invites.includes(e)) {
      setEmailError('Ya está en la lista')
      return
    }
    setInvites((list) => [...list, e])
    setEmailInput('')
    setEmailError('')
  }

  const finalize = () => {
    createMutation.mutate(
      {
        company: {
          name: name.trim(),
          contact_email: contactEmail.trim() || null,
          contact_phone: contactPhone.trim() || null,
        },
        commissions: draftToEntries(commissions),
        invites,
      },
      { onSuccess: (res) => { onCreated(res.affiliate.id); resetAll() } },
    )
  }

  const saving = createMutation.isPending

  return (
    <>
      <WizardShell
        open={open}
        onClose={handleClose}
        title="Nuevo afiliado"
        step={step}
        totalSteps={TOTAL_STEPS}
        stepTitle={STEP_TITLES[step]}
        onBack={() => setStep((s) => Math.max(1, s - 1))}
        onNext={() => setStep((s) => s + 1)}
        onFinish={finalize}
        isLastStep={step === TOTAL_STEPS}
        finishLabel="Finalizar"
        canAdvance={canNext}
        canFinish={nameValid && step2Valid}
        busy={saving}
        error={
          createMutation.isError ? (
            <Alert severity="error">
              No se pudo crear el afiliado. Revisa los datos e inténtalo de nuevo.
            </Alert>
          ) : undefined
        }
      >
            {step === 1 && (
              <Stack spacing={2}>
                <TextField
                  label="Nombre de la empresa"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                  fullWidth
                  autoFocus
                />
                <TextField
                  label="Correo de contacto (opcional)"
                  type="email"
                  value={contactEmail}
                  onChange={(e) => setContactEmail(e.target.value)}
                  fullWidth
                />
                <TextField
                  label="Teléfono de contacto (opcional)"
                  value={contactPhone}
                  onChange={(e) => setContactPhone(e.target.value)}
                  fullWidth
                />
              </Stack>
            )}

            {step === 2 && (
              <>
                <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                  Activa los servicios que este afiliado puede vender y define la comisión que
                  ganará en cada uno. Solo los servicios activos aparecen en su punto de venta.
                </Typography>
                {servicesQuery.isLoading ? (
                  <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}>
                    <CircularProgress />
                  </Box>
                ) : (
                  <CommissionCatalogEditor
                    services={servicesQuery.data ?? []}
                    value={commissions}
                    onChange={setCommissions}
                  />
                )}
              </>
            )}

            {step === 3 && (
              <Stack spacing={2}>
                <Typography variant="body2" color="text.secondary">
                  Invita a las personas que venderán desde esta empresa. Puedes dejarlo vacío e
                  invitarlas más tarde.
                </Typography>
                <Stack direction="row" spacing={1} sx={{ alignItems: 'flex-start' }}>
                  <TextField
                    label="Invitar por correo"
                    type="email"
                    size="small"
                    value={emailInput}
                    onChange={(e) => {
                      setEmailInput(e.target.value)
                      setEmailError('')
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        addInvite()
                      }
                    }}
                    error={!!emailError}
                    helperText={emailError || ' '}
                    fullWidth
                  />
                  <Button
                    onClick={addInvite}
                    variant="outlined"
                    color="secondary"
                    startIcon={<AddRounded />}
                    disabled={!emailInput.trim()}
                    sx={{ mt: 0.5, flexShrink: 0 }}
                  >
                    Agregar
                  </Button>
                </Stack>
                <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', gap: 1 }}>
                  {invites.map((e) => (
                    <Chip
                      key={e}
                      label={e}
                      onDelete={() => setInvites((list) => list.filter((x) => x !== e))}
                    />
                  ))}
                </Stack>
              </Stack>
            )}
      </WizardShell>

      {/* Discard confirmation */}
      <Dialog
        open={confirmDiscard}
        onClose={() => setConfirmDiscard(false)}
        slotProps={{ paper: { sx: { borderRadius: 'var(--radius-lg, 16px)', p: 1 } } }}
      >
        <Box sx={{ p: 2, maxWidth: 360 }}>
          <Typography variant="h6" sx={{ mb: 1 }}>
            ¿Descartar este afiliado?
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2.5 }}>
            Perderás la información que has capturado en el asistente.
          </Typography>
          <Stack direction="row" spacing={1} sx={{ justifyContent: 'flex-end' }}>
            <Button color="inherit" onClick={() => setConfirmDiscard(false)}>
              Seguir editando
            </Button>
            <Button color="error" variant="contained" onClick={doClose}>
              Descartar
            </Button>
          </Stack>
        </Box>
      </Dialog>
    </>
  )
}
