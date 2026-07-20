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
  Switch,
  FormControlLabel,
} from '@mui/material'
import ArrowBackRounded from '@mui/icons-material/ArrowBackRounded'
import AddRounded from '@mui/icons-material/AddRounded'
import EditRounded from '@mui/icons-material/EditRounded'
import { useParams, Link as RouterLink } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { listServices } from '../services/catalogService'
import { useAffiliate, useInviteAffiliate } from '../features/affiliates/hooks/useAffiliates'
import { CompanyInfoSheet } from '../features/affiliates/components/CompanyInfoSheet'
import { CommissionsSheet } from '../features/affiliates/components/CommissionsSheet'
import {
  ConfirmAffiliateStatusSheet,
  type AffiliateStatusAction,
} from '../features/affiliates/components/ConfirmAffiliateStatusSheet'
import type { AffiliateDetail } from '../features/affiliates/types'
import { basisPointsToPercent, formatMoney } from '../features/catalog/types'
import { StatusChip } from '../components'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const SectionTitle = ({ children }: { children: React.ReactNode }) => (
  <Typography variant="overline" color="text.secondary" sx={{ letterSpacing: 0.6 }}>
    {children}
  </Typography>
)

// A read-only label/value line on the summary cards. Values wrap rather than truncate —
// emails and names must stay fully readable.
const InfoLine = ({ label, value }: { label: string; value: string }) => (
  <Box>
    <Typography variant="body2" color="text.secondary">
      {label}
    </Typography>
    <Typography sx={{ fontWeight: 500, overflowWrap: 'anywhere' }}>{value}</Typography>
  </Box>
)

// Card-header row: section title left, neutral corner ✎ right (opens the section's sheet) —
// same anatomy as the catalog detail header and ListRow v2.
const SectionHeader = ({ title, onEdit }: { title: string; onEdit: () => void }) => (
  <Stack direction="row" sx={{ alignItems: 'flex-start', justifyContent: 'space-between' }}>
    <SectionTitle>{title}</SectionTitle>
    <Box sx={{ flexShrink: 0, mt: -1, mr: -1 }}>
      <IconButton aria-label={`Editar ${title.toLowerCase()}`} onClick={onEdit} sx={{ color: 'text.secondary' }}>
        <EditRounded fontSize="small" />
      </IconButton>
    </Box>
  </Stack>
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

  // Remount (key) on id change so local UI state (open sheets, invite draft) never leaks
  // across affiliates.
  return <AffiliateView key={affiliate.id} affiliate={affiliate} />
}

// Read-only projection of the affiliate + per-section edit sheets (the app-wide sheet pattern).
// The page holds no form state — each sheet seeds itself from the fresh `affiliate` prop on open.
function AffiliateView({ affiliate }: { affiliate: AffiliateDetail }) {
  const id = affiliate.id
  const servicesQuery = useQuery({
    queryKey: ['services', 'active'],
    queryFn: () => listServices('active'),
  })

  const inviteMutation = useInviteAffiliate(id)

  const [editCompany, setEditCompany] = useState(false)
  const [editCommissions, setEditCommissions] = useState(false)
  const [statusConfirm, setStatusConfirm] = useState<AffiliateStatusAction | null>(null)
  const [emailInput, setEmailInput] = useState('')
  const [emailError, setEmailError] = useState('')
  const [toast, setToast] = useState('')

  const suspended = affiliate.status === 'suspended'

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
        <Button
          component={RouterLink}
          to="/affiliates"
          startIcon={<ArrowBackRounded />}
          sx={{ mb: 2 }}
        >
          Afiliados
        </Button>

        <Stack spacing={2.5}>
          {/* Identity card — same anatomy as the catalog detail header (ListRow v2): name +
              corner ✎, contact meta, and the estado switch in the footer. The switch is the
              single status expression (display AND control), so no chip/button contradiction. */}
          <Card>
            <CardContent>
              <Box sx={{ display: 'flex', gap: 1.5, alignItems: 'flex-start' }}>
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <Typography variant="h5" component="h1" sx={{ overflowWrap: 'anywhere' }}>
                    {affiliate.name}
                  </Typography>
                  <Stack spacing={1.5} sx={{ mt: 1.5 }}>
                    <InfoLine
                      label="Correo de contacto"
                      value={affiliate.contact_email?.trim() ? affiliate.contact_email : '—'}
                    />
                    {affiliate.contact_phone?.trim() ? (
                      <InfoLine label="Teléfono de contacto" value={affiliate.contact_phone} />
                    ) : (
                      <Box>
                        <Button
                          size="small"
                          startIcon={<AddRounded />}
                          onClick={() => setEditCompany(true)}
                          sx={{ ml: -1 }}
                        >
                          Agregar teléfono
                        </Button>
                      </Box>
                    )}
                  </Stack>
                </Box>
                <Box sx={{ flexShrink: 0, mt: -1, mr: -1 }}>
                  <IconButton
                    aria-label="Editar información de la empresa"
                    onClick={() => setEditCompany(true)}
                    sx={{ color: 'text.secondary' }}
                  >
                    <EditRounded fontSize="small" />
                  </IconButton>
                </Box>
              </Box>
              <Divider sx={{ mt: 1.5, mb: 0.5 }} />
              <Box sx={{ display: 'flex', justifyContent: 'flex-end' }}>
                <FormControlLabel
                  control={
                    <Switch
                      color="secondary"
                      checked={!suspended}
                      onChange={() =>
                        setStatusConfirm(suspended ? 'reactivate' : 'deactivate')
                      }
                    />
                  }
                  label={suspended ? 'Suspendido' : 'Activo'}
                  slotProps={{ typography: { variant: 'body2' } }}
                  sx={{ mr: 0 }}
                />
              </Box>
            </CardContent>
          </Card>

          {/* Catalog & commissions — read-only summary of the allow-list; edited in its sheet. */}
          <Card>
            <CardContent>
              <SectionHeader
                title="Catálogo y comisiones"
                onEdit={() => setEditCommissions(true)}
              />
              <Box sx={{ mt: 1.5 }}>
                {affiliate.commissions.length === 0 ? (
                  <Stack spacing={1} sx={{ alignItems: 'flex-start' }}>
                    <Typography variant="body2" color="text.secondary">
                      Sin servicios habilitados.
                    </Typography>
                    <Button
                      size="small"
                      startIcon={<AddRounded />}
                      onClick={() => setEditCommissions(true)}
                      sx={{ ml: -1 }}
                    >
                      Habilitar servicios
                    </Button>
                  </Stack>
                ) : (
                  <Stack spacing={1}>
                    {affiliate.commissions.map((c) => (
                      <Stack
                        key={c.service_id}
                        direction="row"
                        sx={{ alignItems: 'baseline', justifyContent: 'space-between', gap: 2 }}
                      >
                        <Typography sx={{ minWidth: 0, overflowWrap: 'anywhere' }}>
                          {c.service_name}
                          {c.service_status === 'inactive' && (
                            <Typography component="span" variant="body2" color="text.secondary">
                              {' '}
                              · inactivo
                            </Typography>
                          )}
                        </Typography>
                        <Typography
                          className="numeric"
                          color="text.secondary"
                          sx={{ flexShrink: 0 }}
                        >
                          {c.commission_type === 'fixed'
                            ? `${formatMoney(c.commission_value)} por lugar`
                            : `${basisPointsToPercent(c.commission_value)}%`}
                        </Typography>
                      </Stack>
                    ))}
                  </Stack>
                )}
              </Box>
            </CardContent>
          </Card>

          {/* Users & invitations — the invite input stays inline: it's an additive one-field
              action with inline error feedback, not an edit modal (matches the wizard). */}
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
                    sx={{ alignItems: 'center', justifyContent: 'space-between', gap: 1.5 }}
                  >
                    <Box sx={{ minWidth: 0 }}>
                      <Typography sx={{ overflowWrap: 'anywhere' }}>
                        {u.name}
                        {u.position ? ` · ${u.position}` : ''}
                      </Typography>
                      <Typography
                        variant="body2"
                        color="text.secondary"
                        sx={{ overflowWrap: 'anywhere' }}
                      >
                        {u.email}
                      </Typography>
                    </Box>
                    <StatusChip status={u.status === 'suspended' ? 'suspended' : 'active'} />
                  </Stack>
                ))}
                {affiliate.pending_invites.map((inv) => (
                  <Stack
                    key={inv.id}
                    direction="row"
                    sx={{ alignItems: 'center', justifyContent: 'space-between', gap: 1.5 }}
                  >
                    <Typography
                      variant="body2"
                      color="text.secondary"
                      sx={{ minWidth: 0, overflowWrap: 'anywhere' }}
                    >
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

        <CompanyInfoSheet
          affiliate={affiliate}
          open={editCompany}
          onClose={() => setEditCompany(false)}
          onSaved={() => setToast('Datos guardados')}
        />
        <CommissionsSheet
          affiliate={affiliate}
          services={servicesQuery.data ?? []}
          open={editCommissions}
          onClose={() => setEditCommissions(false)}
          onSaved={() => setToast('Comisiones actualizadas')}
        />
        <ConfirmAffiliateStatusSheet
          affiliateId={id}
          affiliateName={affiliate.name}
          action={statusConfirm ?? 'deactivate'}
          open={!!statusConfirm}
          onClose={() => setStatusConfirm(null)}
        />

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
