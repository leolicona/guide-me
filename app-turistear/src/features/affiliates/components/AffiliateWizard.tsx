import { useEffect, useState } from 'react'
import {
  Box,
  Typography,
  Stack,
  Alert,
  CircularProgress,
  TextField,
} from '@mui/material'
import { useQuery } from '@tanstack/react-query'
import { ConfirmSheet, WizardPage } from '../../../components'
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
  /** Exit confirmed (X on a clean form, or discard confirmed) — the parent navigates away. */
  onClose: () => void
  onCreated: (affiliateId: string) => void
}

// US-A54–A57 — affiliate setup wizard, hosted full-page (/affiliates/new) via WizardPage, matching
// the service-creation flow. Create-only; one atomic save on Finalizar (D9): nothing persists
// until then. Navigation away unmounts it, so there's no reset-on-close bookkeeping.
export function AffiliateWizard({ onClose, onCreated }: Props) {
  const [step, setStep] = useState(1)
  const [name, setName] = useState('')
  const [contactEmail, setContactEmail] = useState('')
  const [contactPhone, setContactPhone] = useState('')
  const [commissions, setCommissions] = useState<CommissionDraftMap>({})
  // D13 — at most one credentialed affiliate (the manager) per company; extra sellers are PIN
  // operators (US-AF10). So Step 3 collects a single optional manager email.
  const [managerEmail, setManagerEmail] = useState('')
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
    managerEmail.trim() !== ''

  const handleClose = () => {
    if (createMutation.isPending) return
    if (isDirty) setConfirmDiscard(true)
    else onClose()
  }

  // Tab close / refresh with unsaved input → native "leave site?" prompt. SPA back-navigation
  // is not intercepted (BrowserRouter has no useBlocker) — an accepted silent discard.
  useEffect(() => {
    if (!isDirty) return
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [isDirty])

  const nameValid = name.trim().length > 0
  const step2Valid = draftsValid(commissions)
  // The manager email is optional; when present it must be valid before Finalizar.
  const managerEmailValid = managerEmail.trim() === '' || EMAIL_RE.test(managerEmail.trim())
  const canNext = step === 1 ? nameValid : step === 2 ? step2Valid : true

  const finalize = () => {
    const email = managerEmail.trim().toLowerCase()
    createMutation.mutate(
      {
        company: {
          name: name.trim(),
          contact_email: contactEmail.trim() || null,
          contact_phone: contactPhone.trim() || null,
        },
        commissions: draftToEntries(commissions),
        invites: email ? [email] : [],
      },
      { onSuccess: (res) => onCreated(res.affiliate.id) },
    )
  }

  const saving = createMutation.isPending

  return (
    <>
      <WizardPage
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
        canFinish={nameValid && step2Valid && managerEmailValid}
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
                  Invita al <strong>gerente</strong> de la empresa (su cuenta con correo y
                  contraseña). Es quien administra la caja y da de alta a sus cajeros. Puedes dejarlo
                  vacío e invitarlo más tarde.
                </Typography>
                <TextField
                  label="Correo del gerente (opcional)"
                  type="email"
                  value={managerEmail}
                  onChange={(e) => setManagerEmail(e.target.value)}
                  error={managerEmail.trim() !== '' && !managerEmailValid}
                  helperText={
                    managerEmail.trim() !== '' && !managerEmailValid ? 'Correo inválido' : ' '
                  }
                  fullWidth
                  autoFocus
                />
                <Typography variant="caption" color="text.secondary">
                  Los cajeros o vendedores adicionales no se invitan aquí: el gerente los agrega como
                  operadores con un PIN, desde su panel.
                </Typography>
              </Stack>
            )}
      </WizardPage>

      {/* Discard confirmation — the sheet outranks the WizardPage host (zIndex modal+1). */}
      <ConfirmSheet
        open={confirmDiscard}
        onClose={() => setConfirmDiscard(false)}
        title="¿Descartar este afiliado?"
        description="Perderás la información que has capturado en el asistente."
        confirmLabel="Descartar"
        cancelLabel="Seguir editando"
        onConfirm={onClose}
      />
    </>
  )
}
