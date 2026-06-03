import { Box, Typography, Fade } from '@mui/material';
import { useAuthStore } from '../store/authStore';

export default function DashboardPage() {
  const user = useAuthStore((state) => state.user);

  return (
    <Fade in timeout={400}>
      <Box>
        <Typography variant="h4" component="h1" gutterBottom>
          Dashboard
        </Typography>
        <Typography color="text.secondary">
          Welcome{user?.name ? `, ${user.name}` : ''}. This page will be expanded
          in future iterations.
        </Typography>
      </Box>
    </Fade>
  );
}
