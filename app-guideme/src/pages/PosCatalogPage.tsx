import { useNavigate, Link as RouterLink } from 'react-router-dom'
import {
  Box,
  Typography,
  Button,
  Card,
  CardActionArea,
  CardContent,
  CircularProgress,
  Alert,
  Fade,
  Stack,
  Badge,
} from '@mui/material'
import ShoppingCartRounded from '@mui/icons-material/ShoppingCartRounded'
import { usePosServices } from '../features/pos/hooks'
import { AvailabilityChip } from '../features/pos/components/AvailabilityChip'
import { usePosCart, cartCount } from '../store/posCart'
import { formatMoney } from '../features/catalog/types'
import { ROUTES } from '../config/routes'

export default function PosCatalogPage() {
  const { data: services, isLoading, isError } = usePosServices()
  const count = usePosCart((s) => cartCount(s.lines))
  const navigate = useNavigate()

  return (
    <Fade in timeout={400}>
      <Box>
        <Box
          sx={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: 2,
            mb: 3,
          }}
        >
          <Typography variant="h4" component="h1">
            Vender
          </Typography>
          <Badge badgeContent={count} color="secondary">
            <Button
              variant="outlined"
              startIcon={<ShoppingCartRounded />}
              component={RouterLink}
              to={ROUTES.POS_CHECKOUT}
              disabled={count === 0}
            >
              Cart
            </Button>
          </Badge>
        </Box>

        {isLoading && (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
            <CircularProgress />
          </Box>
        )}

        {isError && (
          <Alert severity="error">No se pudieron cargar los servicios. Por favor, inténtalo de nuevo.</Alert>
        )}

        {services &&
          (services.length === 0 ? (
            <Typography color="text.secondary">
              No hay servicios disponibles en este momento.
            </Typography>
          ) : (
            <Box
              sx={{
                display: 'grid',
                gap: 2,
                gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
              }}
            >
              {services.map((service) => (
                <Card key={service.id}>
                  <CardActionArea
                    onClick={() =>
                      navigate(ROUTES.POS_SERVICE.replace(':id', service.id))
                    }
                    sx={{ height: '100%' }}
                  >
                    <CardContent>
                      <Stack
                        direction="row"
                        spacing={1}
                        sx={{ justifyContent: 'space-between', alignItems: 'flex-start' }}
                      >
                        <Typography variant="h6" component="h2" sx={{ minWidth: 0 }}>
                          {service.name}
                        </Typography>
                        <AvailabilityChip spots={service.available_spots} />
                      </Stack>
                      {service.description && (
                        <Typography
                          variant="body2"
                          color="text.secondary"
                          sx={{ mt: 1 }}
                        >
                          {service.description}
                        </Typography>
                      )}
                      <Typography variant="body2" sx={{ mt: 1.5, fontWeight: 500 }}>
                        desde {formatMoney(service.base_price)}
                      </Typography>
                      {service.next_slot_date && (
                        <Typography variant="caption" color="text.secondary">
                          Próximo: {service.next_slot_date}
                        </Typography>
                      )}
                    </CardContent>
                  </CardActionArea>
                </Card>
              ))}
            </Box>
          ))}
      </Box>
    </Fade>
  )
}
