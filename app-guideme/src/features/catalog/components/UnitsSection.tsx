import { useState } from 'react'
import { Box, Button, Typography, CircularProgress, Stack } from '@mui/material'
import AddRounded from '@mui/icons-material/AddRounded'
import { SectionCard } from '../../../components'
import { useUnits } from '../hooks/useUnits'
import { useUnitMutations } from '../hooks/useUnitMutations'
import type { AccommodationUnit } from '../types'
import { UnitRow } from './UnitRow'
import { fromNightlyRate } from '../lodging'
import { UnitFormDialog } from './UnitFormDialog'
import { SeasonsEditor } from './SeasonsEditor'
import { BlockoutsEditor } from './BlockoutsEditor'

interface UnitsSectionProps {
  serviceId: string
}

type SheetTarget = { kind: 'seasons' | 'blockouts'; unit: AccommodationUnit } | null

// US-A59 — the lodging service detail's Units section (Detail-screen archetype). The single accent
// affordance is "Agregar unidad"; rows expose Editar / Temporadas / Bloqueos / Desactivar.
export function UnitsSection({ serviceId }: UnitsSectionProps) {
  const { data: units, isLoading } = useUnits(serviceId)
  const { deactivate, reactivate } = useUnitMutations(serviceId)
  const [editing, setEditing] = useState<AccommodationUnit | null>(null)
  const [creating, setCreating] = useState(false)
  const [sheet, setSheet] = useState<SheetTarget>(null)

  return (
    <SectionCard
      title="Unidades"
      action={
        <Button
          variant="contained"
          disableElevation
          startIcon={<AddRounded />}
          onClick={() => setCreating(true)}
        >
          Agregar unidad
        </Button>
      }
    >
      {isLoading ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
          <CircularProgress />
        </Box>
      ) : units && units.length > 0 ? (
        <Stack spacing={1.5}>
          {units.map((unit) => (
            <UnitRow
              key={unit.id}
              unit={{
                name: unit.name,
                unit_type: unit.unit_type,
                beds: unit.beds,
                base_occupancy: unit.base_occupancy,
                max_capacity: unit.max_capacity,
                from_rate: fromNightlyRate(unit.base_rate, unit.weekend_rate),
                amenities: unit.amenities,
                status: unit.status,
              }}
              actions={
                <>
                  <Button size="small" onClick={() => setEditing(unit)}>
                    Editar
                  </Button>
                  <Button size="small" onClick={() => setSheet({ kind: 'seasons', unit })}>
                    Temporadas
                  </Button>
                  <Button size="small" onClick={() => setSheet({ kind: 'blockouts', unit })}>
                    Bloqueos
                  </Button>
                  {unit.status === 'active' ? (
                    <Button
                      size="small"
                      color="inherit"
                      disabled={deactivate.isPending}
                      onClick={() => deactivate.mutate(unit.id)}
                    >
                      Desactivar
                    </Button>
                  ) : (
                    <Button
                      size="small"
                      disabled={reactivate.isPending}
                      onClick={() => reactivate.mutate(unit.id)}
                    >
                      Reactivar
                    </Button>
                  )}
                </>
              }
            />
          ))}
        </Stack>
      ) : (
        <Typography color="text.secondary">
          Aún no hay unidades — agrega la primera para poder vender.
        </Typography>
      )}

      <UnitFormDialog
        serviceId={serviceId}
        unit={null}
        open={creating}
        onClose={() => setCreating(false)}
      />
      <UnitFormDialog
        serviceId={serviceId}
        unit={editing}
        open={!!editing}
        onClose={() => setEditing(null)}
      />
      {sheet?.kind === 'seasons' && (
        <SeasonsEditor
          serviceId={serviceId}
          unitId={sheet.unit.id}
          unitName={sheet.unit.name}
          open
          onClose={() => setSheet(null)}
        />
      )}
      {sheet?.kind === 'blockouts' && (
        <BlockoutsEditor
          serviceId={serviceId}
          unitId={sheet.unit.id}
          unitName={sheet.unit.name}
          open
          onClose={() => setSheet(null)}
        />
      )}
    </SectionCard>
  )
}
