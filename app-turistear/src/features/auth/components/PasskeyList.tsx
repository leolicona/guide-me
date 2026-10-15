import { useState } from 'react'
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  IconButton,
  Stack,
  Typography,
} from '@mui/material'
import AddRounded from '@mui/icons-material/AddRounded'
import DeleteOutlineRounded from '@mui/icons-material/DeleteOutlineRounded'
import EditRounded from '@mui/icons-material/EditRounded'
import KeyRounded from '@mui/icons-material/KeyRounded'
import SyncRounded from '@mui/icons-material/SyncRounded'
import { SectionCard } from '../../../components'
import { useOrgDateFormatter } from '../../organization'
import { usePasskeys } from '../hooks/usePasskeys'
import type { PasskeyRecord } from '../types'
import { passkeysSupported } from '../webauthn'
import { isSyncedPasskey, passkeyLabel } from './passkeyLabel'
import { PasskeyOffer } from './PasskeyOffer'
import { RemovePasskeySheet } from './RemovePasskeySheet'
import { RenamePasskeySheet } from './RenamePasskeySheet'

const iconButtonSx = { width: 48, height: 48, color: 'text.secondary' } as const

/**
 * Every llave de acceso on the account, with its name and the date it was created (passkey-auth
 * US5, scenario 1), each renamed or removed on its own. "Agregar llave de acceso" reuses the
 * offer's flow, including the fresh-session rule.
 */
export function PasskeyList() {
  const { data: passkeys, isLoading, isError } = usePasskeys()
  // Constitution II — a day reads in the organization's time zone, never the device's.
  const formatDate = useOrgDateFormatter({ day: 'numeric', month: 'short', year: 'numeric' })
  const [renaming, setRenaming] = useState<PasskeyRecord | null>(null)
  const [removing, setRemoving] = useState<PasskeyRecord | null>(null)
  const [adding, setAdding] = useState(false)
  const supported = passkeysSupported()

  const createdOn = (passkey: PasskeyRecord) =>
    formatDate(Math.floor(new Date(passkey.createdAt).getTime() / 1000))

  return (
    <>
      <SectionCard title="Llaves de acceso" padded={false}>
        <Typography variant="body2" color="textSecondary" sx={{ px: 3, pb: 2 }}>
          Entra con tu huella, tu cara o el PIN de tu dispositivo. Si pierdes un teléfono, elimina
          aquí su llave de acceso.
        </Typography>

        {isLoading && (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}>
            <CircularProgress aria-label="Cargando llaves de acceso" />
          </Box>
        )}

        {isError && (
          <Box sx={{ px: 3, pb: 2 }}>
            <Alert severity="error">
              No se pudieron cargar tus llaves de acceso. Inténtalo de nuevo.
            </Alert>
          </Box>
        )}

        {passkeys?.length === 0 && (
          <Typography sx={{ px: 3, pb: 2 }}>
            Aún no tienes llaves de acceso. Mientras tanto, entra con un código por correo.
          </Typography>
        )}

        {passkeys && passkeys.length > 0 && (
          <Box component="ul" aria-label="Tus llaves de acceso" sx={{ listStyle: 'none', m: 0, p: 0 }}>
            {passkeys.map((passkey) => {
              const label = passkeyLabel(passkey)
              const synced = isSyncedPasskey(passkey)
              return (
                <Box
                  component="li"
                  key={passkey.id}
                  sx={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 1,
                    px: 3,
                    py: 1.5,
                    borderTop: '1px solid',
                    borderColor: 'divider',
                  }}
                >
                  <Box sx={{ flex: 1, minWidth: 0 }}>
                    <Typography sx={{ fontWeight: 600 }} noWrap>
                      {label}
                    </Typography>
                    <Typography variant="body2" color="textSecondary">
                      Creada {createdOn(passkey)}
                    </Typography>
                    {/* How it lives, told by icon AND text — never by the icon alone. */}
                    <Stack
                      direction="row"
                      spacing={0.75}
                      sx={{ alignItems: 'center', mt: 0.5, color: 'text.secondary' }}
                    >
                      {synced ? (
                        <SyncRounded fontSize="small" aria-hidden />
                      ) : (
                        <KeyRounded fontSize="small" aria-hidden />
                      )}
                      <Typography variant="body2">
                        {synced ? 'Sincronizada' : 'Llave de seguridad'}
                      </Typography>
                    </Stack>
                  </Box>
                  <IconButton
                    aria-label={`Cambiar nombre de ${label}`}
                    onClick={() => setRenaming(passkey)}
                    sx={iconButtonSx}
                  >
                    <EditRounded fontSize="small" />
                  </IconButton>
                  <IconButton
                    aria-label={`Eliminar ${label}`}
                    onClick={() => setRemoving(passkey)}
                    sx={iconButtonSx}
                  >
                    <DeleteOutlineRounded fontSize="small" />
                  </IconButton>
                </Box>
              )
            })}
          </Box>
        )}

        <Box sx={{ px: 3, py: 3, borderTop: passkeys?.length ? '1px solid' : 0, borderColor: 'divider' }}>
          {supported ? (
            <Button
              fullWidth
              variant="contained"
              startIcon={<AddRounded />}
              onClick={() => setAdding(true)}
            >
              Agregar llave de acceso
            </Button>
          ) : (
            // Spec § Edge Cases — a browser without WebAuthn explains instead of offering.
            <Typography variant="body2" color="textSecondary">
              Este navegador no puede guardar llaves de acceso. Puedes entrar con un código por
              correo.
            </Typography>
          )}
        </Box>
      </SectionCard>

      <RenamePasskeySheet passkey={renaming} open={!!renaming} onClose={() => setRenaming(null)} />
      <RemovePasskeySheet passkey={removing} open={!!removing} onClose={() => setRemoving(null)} />
      {supported && <PasskeyOffer mode="add" open={adding} onClose={() => setAdding(false)} />}
    </>
  )
}
