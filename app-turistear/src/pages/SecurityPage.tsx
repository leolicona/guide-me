import { Box, Fade, Stack } from '@mui/material'
import { ListPageHeader } from '../components'
import { PasskeyList } from '../features/auth/components/PasskeyList'
import { SessionsCard } from '../features/auth/components/SessionsCard'

// passkey-auth US5 — Seguridad, for every role: llaves de acceso and sessions.
export default function SecurityPage() {
  return (
    <Fade in timeout={400}>
      <Box sx={{ maxWidth: 720, mx: 'auto' }}>
        <ListPageHeader title="Seguridad" />
        <Stack spacing={3}>
          <PasskeyList />
          <SessionsCard />
        </Stack>
      </Box>
    </Fade>
  )
}
