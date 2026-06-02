import { Box, Typography, Button, Container, AppBar, Toolbar, Fade } from '@mui/material';
import { useAuthStore } from '../store/authStore';
import { useLogout } from '../features/auth/hooks/useLogout';

export default function DashboardPage() {
  const user = useAuthStore((state) => state.user);
  const { logout, isPending } = useLogout();

  return (
    <Fade in timeout={400}>
      <Box sx={{ minHeight: '100vh', bgcolor: 'background.default' }}>
        <AppBar position="static" color="transparent" elevation={0} sx={{ borderBottom: '1px solid', borderColor: 'divider' }}>
          <Toolbar>
            <Typography variant="h6" component="div" sx={{ flexGrow: 1, fontWeight: 'bold', color: 'primary.main' }}>
              GuideMe
            </Typography>
            <Typography variant="body2" sx={{ mr: 2 }}>
              {user?.name} ({user?.role})
            </Typography>
            <Button
              variant="outlined"
              size="small"
              onClick={logout}
              disabled={isPending}
            >
              Log out
            </Button>
          </Toolbar>
        </AppBar>

        <Container maxWidth="lg" sx={{ mt: 4 }}>
          <Typography variant="h4" component="h1" gutterBottom>
            Dashboard
          </Typography>
          <Typography color="text.secondary">
            Welcome to your dashboard. This page will be expanded in future iterations.
          </Typography>
        </Container>
      </Box>
    </Fade>
  );
}
