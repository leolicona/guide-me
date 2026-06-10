import { Box, Typography, Fade } from '@mui/material';
import { useCurrentUser } from '../features/auth/CurrentUserContext';

export default function DashboardPage() {
  const user = useCurrentUser();

  return (
    <Fade in timeout={400}>
      <Box>
        <Typography variant="h4" component="h1" gutterBottom>
          Dashboard
        </Typography>
        <Typography color="text.secondary">
          Bienvenido, {user.name}. Esta página se ampliará en futuras versiones.
        </Typography>
      </Box>
    </Fade>
  );
}
