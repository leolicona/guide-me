import { useState } from 'react'
import { Box, Button, Chip, Divider, Stack, Typography } from '@mui/material'
import AddRounded from '@mui/icons-material/AddRounded'
import GridViewRounded from '@mui/icons-material/GridViewRounded'
import { SectionCard, ConfirmSheet } from '../../../components'
import { useZoneMutations } from '../hooks/useZones'
import { EnableZonesSheet } from './EnableZonesSheet'
import { ZoneFormSheet } from './ZoneFormSheet'
import type { Service, ServiceZone } from '../types'

interface ZonesSectionProps {
  service: Service
}

// US-A64 — the slot-based service detail's Zones section. When zones are off, a single call to
// action opens the "Dividir en zonas" editor. When on, it lists the zones (name + seats) with
// add / edit / deactivate and a "Desactivar zonas" action. Same anatomy as UnitsSection.
export function ZonesSection({ service }: ZonesSectionProps) {
  const { deactivate, disable } = useZoneMutations(service.id)
  const [enabling, setEnabling] = useState(false)
  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState<ServiceZone | null>(null)
  const [confirmDisable, setConfirmDisable] = useState(false)

  const zones = (service.zones ?? []).filter((z) => z.status === 'active')
  const total = zones.reduce((sum, z) => sum + z.capacity, 0)

  if (!service.zones_enabled) {
    return (
      <SectionCard title="Zonas">
        <Stack spacing={2} sx={{ alignItems: 'flex-start' }}>
          <Typography color="text.secondary">
            Divide los asientos de cada salida en zonas físicas (p. ej. Piso alto / Piso bajo) para
            vender y controlar cada área por separado.
          </Typography>
          <Button
            variant="contained"
            disableElevation
            startIcon={<GridViewRounded />}
            onClick={() => setEnabling(true)}
          >
            Dividir en zonas
          </Button>
        </Stack>
        <EnableZonesSheet
          serviceId={service.id}
          isFlexible={service.is_flexible}
          open={enabling}
          onClose={() => setEnabling(false)}
        />
      </SectionCard>
    )
  }

  return (
    <SectionCard
      title="Zonas"
      action={
        <Button
          variant="contained"
          disableElevation
          startIcon={<AddRounded />}
          onClick={() => setCreating(true)}
        >
          Agregar zona
        </Button>
      }
    >
      <Stack spacing={1.5} divider={<Divider flexItem />}>
        {zones.map((zone) => (
          <Box
            key={zone.id}
            sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 2 }}
          >
            <Box sx={{ minWidth: 0 }}>
              <Typography sx={{ fontWeight: 600, overflowWrap: 'anywhere' }}>{zone.name}</Typography>
              <Typography variant="body2" color="text.secondary">
                {zone.capacity === 1 ? '1 asiento' : `${zone.capacity} asientos`}
              </Typography>
            </Box>
            <Stack
              direction="row"
              spacing={0.5}
              sx={{
                flexShrink: 0,
                '& .MuiButton-text.MuiButton-colorPrimary': { color: 'text.secondary' },
              }}
            >
              <Button size="small" onClick={() => setEditing(zone)}>
                Editar
              </Button>
              <Button
                size="small"
                disabled={deactivate.isPending}
                onClick={() => deactivate.mutate(zone.id)}
                sx={{ color: 'text.secondary' }}
              >
                Desactivar
              </Button>
            </Stack>
          </Box>
        ))}
      </Stack>

      <Stack
        direction="row"
        spacing={1}
        sx={{ mt: 2, alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap' }}
      >
        <Chip
          size="small"
          variant="outlined"
          label={`Total: ${total} asientos`}
          className="numeric"
        />
        <Button
          size="small"
          color="error"
          disabled={disable.isPending}
          onClick={() => setConfirmDisable(true)}
        >
          Desactivar zonas
        </Button>
      </Stack>

      <ZoneFormSheet
        serviceId={service.id}
        zone={null}
        open={creating}
        onClose={() => setCreating(false)}
      />
      <ZoneFormSheet
        serviceId={service.id}
        zone={editing}
        open={!!editing}
        onClose={() => setEditing(null)}
      />
      <ConfirmSheet
        open={confirmDisable}
        onClose={() => setConfirmDisable(false)}
        title="¿Desactivar las zonas?"
        description="Las salidas futuras volverán a un solo cupo por salida. Las ventas existentes conservan su zona en el boleto."
        confirmLabel="Desactivar zonas"
        confirmColor="error"
        busy={disable.isPending}
        onConfirm={() => disable.mutate(undefined, { onSuccess: () => setConfirmDisable(false) })}
      />
    </SectionCard>
  )
}
