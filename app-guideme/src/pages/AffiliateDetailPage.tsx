import { useState } from 'react'
import {
  Box,
  Typography,
  Button,
  CircularProgress,
  Alert,
  Fade,
  Stack,
  Card,
  CardContent,
  TextField,
  Chip,
  Divider,
  IconButton,
  Snackbar,
} from '@mui/material'
import ArrowBackRounded from '@mui/icons-material/ArrowBackRounded'
import AddRounded from '@mui/icons-material/AddRounded'
import BlockRounded from '@mui/icons-material/BlockRounded'
import CheckCircleRounded from '@mui/icons-material/CheckCircleRounded'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { listServices } from '../services/catalogService'
import {
  useAffiliate,
  useAffiliateStatus,
  useInviteAffiliate,
  useSetCommissions,
  useUpdateAffiliate,
} from '../features/affiliates/hooks/useAffiliates'
import { CommissionCatalogEditor } from '../features/affiliates/components/CommissionCatalogEditor'
import {
  draftFromCommissions,
  draftToEntries,
  draftsValid,
  type CommissionDraftMap,
} from '../features/affiliates/commission'
import type { AffiliateDetail } from '../features/affiliates/types'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const SectionTitle = ({ children }: { children: React.ReactNode }) => (
  <Typography variant="overline" color="text.secondary" sx={{ letterSpacing: 0.6 }}>
    {children}
  </Typography>
)

export default function AffiliateDetailPage() {
  const { id = '' } = useParams()
  const { data: affiliate, isLoading, isError } = useAffiliate(id)

  if (isLoading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
        <CircularProgress />
      </Box>
    )
  }
  if (isError || !affiliate) {
    return (
      <Alert severity="error" sx={{ m: 2 }}>
        No se pudo cargar el afiliado.
      </Alert>
    )
  }

  // Remount (key) on id change so the editor re-initializes its form state from fresh props,
  // avoiding a props→state useEffect (react-hooks/set-state-in-effect).
  return <AffiliateEditor key={affiliate.id} affiliate={affiliate} />
}

function AffiliateEditor({ affiliate }: { affiliate: AffiliateDetail }) {
  const id = affiliate.id
  const navigate = useNavigate()
  const servicesQuery = useQuery({
    queryKey: ['services', 'active'],
    queryFn: () => listServices('active'),
  })

  const updateMutation = useUpdateAffiliate(id)
  const commissionsMutation = useSetCommissions(id)
  const inviteMutation = useInviteAffiliate(id)
  const { deactivate, reactivate } = useAffiliateStatus(id)

  // Initialized directly from props (no effect). Seeding the FULL draft map (incl. commissions
  // for now-inactive services) means a Save preserves them even though the editor only renders
  // active services (D12 — deactivation preserves rows).
  const [name, setName] = useState(affiliate.name)
  const [contactEmail, setContactEmail] = useState(affiliate.contact_email ?? '')
  const [contactPhone, setContactPhone] = useState(affiliate.contact_phone ?? '')
  const [commissions, setCommissions] = useState<CommissionDraftMap>(() =>
    draftFromCommissions(affiliate.commissions),
  )
  const [emailInput, setEmailInput] = useState('')
  const [emailError, setEmailError] = useState('')
  const [toast, setToast] = useState('')

  const suspended = affiliate.status === 'suspended'

  const saveCompany = () =>
    updateMutation.mutate(
      {
        name: name.trim(),
        contact_email: contactEmail.trim() || null,
        contact_phone: contactPhone.trim() || null,
      },
      { onSuccess: () => setToast('Datos guardados') },
    )

  const saveCommissions = () =>
    commissionsMutation.mutate(draftToEntries(commissions), {
      onSuccess: () => setToast('Comisiones actualizadas'),
    })

  const addInvite = () => {
    const e = emailInput.trim().toLowerCase()
    if (!EMAIL_RE.test(e)) {
      setEmailError('Correo inválido')
      return
    }
    inviteMutation.mutate(e, {
      onSuccess: () => {
        setEmailInput('')
        setEmailError('')
        setToast('Invitación enviada')
      },
      onError: (err: unknown) => {
        const code = (err as { code?: string })?.code
        setEmailError(
          code === 'ALREADY_INVITED'
            ? 'Ya tiene una invitación pendiente'
            : code === 'IDENTITY_ALREADY_EXISTS'
              ? 'Ese correo ya es un usuario'
              : 'No se pudo invitar',
        )
      },
    })
  }

  return (
    <Fade in timeout={400}>
      <Box sx={{ maxWidth: 720, mx: 'auto' }}>
        <Stack
          direction="row"
          sx={{ alignItems: 'center', justifyContent: 'space-between', mb: 3, gap: 2 }}
        >
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center', minWidth: 0 }}>
            <IconButton onClick={() => navigate('/affiliates')} aria-label="Volver">
              <ArrowBackRounded />
            </IconButton>
            <Typography variant="h5" component="h1" noWrap>
              {affiliate.name}
            </Typography>
            <Chip
              size="small"
              variant="outlined"
              color={suspended ? 'default' : 'success'}
              label={suspended ? 'Suspendido' : 'Activo'}
            />
          </Stack>
          {suspended ? (
            <Button
              color="primary"
              startIcon={<CheckCircleRounded />}
              onClick={() => reactivate.mutate()}
              disabled={reactivate.isPending}
            >
              Reactivar
            </Button>
          ) : (
            <Button
              color="error"
              startIcon={<BlockRounded />}
              onClick={() => deactivate.mutate()}
              disabled={deactivate.isPending}
            >
              Suspender
            </Button>
          )}
        </Stack>

        <Stack spacing={2.5}>
          {/* Company info */}
          <Card>
            <CardContent>
              <SectionTitle>Información de la empresa</SectionTitle>
              <Stack spacing={2} sx={{ mt: 2 }}>
                <TextField
                  label="Nombre de la empresa"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                  fullWidth
                />
                <TextField
                  label="Correo de contacto"
                  value={contactEmail}
                  onChange={(e) => setContactEmail(e.target.value)}
                  fullWidth
                />
                <TextField
                  label="Teléfono de contacto"
                  value={contactPhone}
                  onChange={(e) => setContactPhone(e.target.value)}
                  fullWidth
                />
                <Box sx={{ display: 'flex', justifyContent: 'flex-end' }}>
                  <Button
                    variant="contained"
                    color="secondary"
                    disableElevation
                    onClick={saveCompany}
                    disabled={!name.trim() || updateMutation.isPending}
                  >
                    Guardar cambios
                  </Button>
                </Box>
              </Stack>
            </CardContent>
          </Card>

          {/* Catalog & commissions */}
          <Card>
            <CardContent>
              <SectionTitle>Catálogo y comisiones</SectionTitle>
              <Typography variant="body2" color="text.secondary" sx={{ mt: 1, mb: 2 }}>
                Activa los servicios que este afiliado puede vender y define su comisión.
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
              <Box sx={{ display: 'flex', justifyContent: 'flex-end', mt: 2 }}>
                <Button
                  variant="contained"
                  color="secondary"
                  disableElevation
                  onClick={saveCommissions}
                  disabled={!draftsValid(commissions) || commissionsMutation.isPending}
                >
                  Guardar comisiones
                </Button>
              </Box>
            </CardContent>
          </Card>

          {/* Users & invitations */}
          <Card>
            <CardContent>
              <SectionTitle>Usuarios e invitaciones</SectionTitle>
              <Stack spacing={1} sx={{ mt: 2 }}>
                {affiliate.users.length === 0 && affiliate.pending_invites.length === 0 && (
                  <Typography variant="body2" color="text.secondary">
                    Aún no hay usuarios. Invita al primero.
                  </Typography>
                )}
                {affiliate.users.map((u) => (
                  <Stack
                    key={u.id}
                    direction="row"
                    sx={{ alignItems: 'center', justifyContent: 'space-between' }}
                  >
                    <Box sx={{ minWidth: 0 }}>
                      <Typography noWrap>
                        {u.name}
                        {u.position ? ` · ${u.position}` : ''}
                      </Typography>
                      <Typography variant="body2" color="text.secondary" noWrap>
                        {u.email}
                      </Typography>
                    </Box>
                    <Chip
                      size="small"
                      variant="outlined"
                      color={u.status === 'suspended' ? 'default' : 'success'}
                      label={u.status === 'suspended' ? 'Suspendido' : 'Activo'}
                    />
                  </Stack>
                ))}
                {affiliate.pending_invites.map((inv) => (
                  <Stack
                    key={inv.id}
                    direction="row"
                    sx={{ alignItems: 'center', justifyContent: 'space-between' }}
                  >
                    <Typography variant="body2" color="text.secondary" noWrap>
                      {inv.identity}
                    </Typography>
                    <Chip size="small" variant="outlined" label="Invitación pendiente" />
                  </Stack>
                ))}
              </Stack>

              <Divider sx={{ my: 2 }} />

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
                  disabled={!emailInput.trim() || inviteMutation.isPending}
                  sx={{ mt: 0.5, flexShrink: 0 }}
                >
                  Invitar
                </Button>
              </Stack>
            </CardContent>
          </Card>
        </Stack>

        <Snackbar
          open={!!toast}
          autoHideDuration={3000}
          onClose={() => setToast('')}
          message={toast}
          anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
        />
      </Box>
    </Fade>
  )
}
