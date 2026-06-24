import { useState } from 'react'
import {
  Dialog,
  Box,
  Typography,
  IconButton,
  LinearProgress,
  Button,
  Stack,
  Fade,
  Alert,
  CircularProgress,
  Divider,
  TextField,
  Chip,
} from '@mui/material'
import CloseRounded from '@mui/icons-material/CloseRounded'
import ArrowBackRounded from '@mui/icons-material/ArrowBackRounded'
import CheckRounded from '@mui/icons-material/CheckRounded'
import AddRounded from '@mui/icons-material/AddRounded'
import { useQuery } from '@tanstack/react-query'
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
    <Dialog
      open={open}
      onClose={handleClose}
      fullWidth
      slotProps={{
        paper: {
          sx: {
            m: { xs: 0, sm: 2 },
            position: { xs: 'fixed', sm: 'relative' },
            bottom: { xs: 0, sm: 'auto' },
            left: { xs: 0, sm: 'auto' },
            right: { xs: 0, sm: 'auto' },
            width: { xs: '100%', sm: '100%' },
            maxWidth: { sm: 600 },
            height: { xs: '90vh', sm: 'auto' },
            maxHeight: { xs: '90vh', sm: '88vh' },
            borderRadius: { xs: '20px 20px 0 0', sm: 3 },
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
          },
        },
      }}
    >
      {/* Fixed header */}
      <Box sx={{ px: 3, pt: 2.5, pb: 2, flexShrink: 0 }}>
        <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between' }}>
          <Typography variant="h6">Nuevo afiliado</Typography>
          <IconButton edge="end" onClick={handleClose} disabled={saving} aria-label="Cerrar">
            <CloseRounded />
          </IconButton>
        </Stack>
        <Stack direction="row" spacing={1} sx={{ alignItems: 'baseline', mt: 0.25 }}>
          <Typography variant="overline" color="secondary" sx={{ fontWeight: 700, letterSpacing: 1 }}>
            Paso {step} de {TOTAL_STEPS}
          </Typography>
          <Typography variant="body2" color="text.secondary">
            · {STEP_TITLES[step]}
          </Typography>
        </Stack>
        <LinearProgress
          variant="determinate"
          color="secondary"
          value={(step / TOTAL_STEPS) * 100}
          sx={{ mt: 1.5, height: 6, borderRadius: 3, bgcolor: 'action.hover' }}
        />
      </Box>

      <Divider />

      {/* Scrollable body */}
      <Box sx={{ flex: 1, overflowY: 'auto', px: 3, py: 3 }}>
        <Fade in key={step} timeout={250}>
          <Box>
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
          </Box>
        </Fade>
      </Box>

      {createMutation.isError && (
        <Alert severity="error" sx={{ mx: 3, mb: 1 }}>
          No se pudo crear el afiliado. Revisa los datos e inténtalo de nuevo.
        </Alert>
      )}

      <Divider />

      {/* Fixed footer */}
      <Box sx={{ px: 3, py: 2, flexShrink: 0 }}>
        <Stack direction="row" sx={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <Button
            onClick={() => setStep((s) => Math.max(1, s - 1))}
            disabled={step === 1 || saving}
            startIcon={<ArrowBackRounded />}
            color="inherit"
          >
            Anterior
          </Button>
          {step === TOTAL_STEPS ? (
            <Button
              onClick={finalize}
              variant="contained"
              color="secondary"
              disableElevation
              disabled={saving || !nameValid || !step2Valid}
              startIcon={saving ? <CircularProgress size={18} color="inherit" /> : <CheckRounded />}
            >
              Finalizar
            </Button>
          ) : (
            <Button
              onClick={() => setStep((s) => s + 1)}
              variant="contained"
              color="secondary"
              disableElevation
              disabled={!canNext}
            >
              Siguiente
            </Button>
          )}
        </Stack>
      </Box>

      {/* Discard confirmation */}
      <Dialog
        open={confirmDiscard}
        onClose={() => setConfirmDiscard(false)}
        slotProps={{ paper: { sx: { borderRadius: 3, p: 1 } } }}
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
            <Button color="error" variant="contained" disableElevation onClick={doClose}>
              Descartar
            </Button>
          </Stack>
        </Box>
      </Dialog>
    </Dialog>
  )
}
