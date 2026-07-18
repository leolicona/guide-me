import { useEffect, useRef, useState } from 'react'
import { useParams, useLocation, Link as RouterLink } from 'react-router-dom'
import { useMediaQuery } from '@mui/material'
import {
  Box,
  Typography,
  Button,
  Chip,
  IconButton,
  Card,
  CardContent,
  CircularProgress,
  Alert,
  Fade,
  Stack,
} from '@mui/material'
import ArrowBackRounded from '@mui/icons-material/ArrowBackRounded'
import EditRounded from '@mui/icons-material/EditRounded'
import { useService } from '../features/catalog/hooks/useService'
import { ExtrasPanel } from '../features/catalog/components/ExtrasPanel'
import { ServiceFormSheet } from '../features/catalog/components/ServiceFormSheet'
import { UnitsSection } from '../features/catalog/components/UnitsSection'
import { SchedulesSection } from '../features/schedules/components/SchedulesSection'
import { formatMoney } from '../features/catalog/types'
import {
  categoryLabel,
  inventoryModel,
  pricesAtServiceLevel,
} from '../features/catalog/categories'
import { ROUTES } from '../config/routes'

type ScrollTarget = 'units' | 'extras' | 'schedules'

export default function CatalogDetailPage() {
  const { id } = useParams<{ id: string }>()
  const { data: service, isLoading, isError } = useService(id)
  const [editing, setEditing] = useState(false)
  // US-A44 — the Wizard routes here when the service saved but some schedules/extras failed.
  const location = useLocation()
  const navState = location.state as {
    wizardPartial?: boolean
    scrollTo?: ScrollTarget
  } | null
  const partial = navState?.wizardPartial
  const [showPartial, setShowPartial] = useState(!!partial)

  // ListRow quick-edit shortcuts land here with a `scrollTo` target — bring that section to
  // the top once the service (and thus the section) has rendered. One-shot per navigation.
  const scrollTo = navState?.scrollTo
  const sectionRefs = useRef<Partial<Record<ScrollTarget, HTMLDivElement | null>>>({})
  const scrolledRef = useRef(false)
  const reducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)')
  useEffect(() => {
    if (!service || !scrollTo || scrolledRef.current) return
    const el = sectionRefs.current[scrollTo]
    if (!el) return
    scrolledRef.current = true
    el.scrollIntoView({ block: 'start', behavior: reducedMotion ? 'auto' : 'smooth' })
  }, [service, scrollTo, reducedMotion])

  return (
    <Fade in timeout={400}>
      <Box sx={{ maxWidth: 720, mx: 'auto' }}>
        <Button
          component={RouterLink}
          to={ROUTES.CATALOG}
          startIcon={<ArrowBackRounded />}
          sx={{ mb: 2 }}
        >
          Catálogo
        </Button>

        {showPartial && (
          <Alert
            severity="warning"
            onClose={() => setShowPartial(false)}
            sx={{ mb: 2 }}
          >
            Servicio creado, pero algunos horarios o extras no se guardaron. Revísalos y agrégalos
            aquí abajo.
          </Alert>
        )}

        {isLoading && (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
            <CircularProgress />
          </Box>
        )}

        {isError && (
          <Alert severity="error">No se pudo cargar este servicio. Inténtalo de nuevo.</Alert>
        )}

        {service && (
          <Stack spacing={3}>
            {/* Header card — same anatomy as the list's ListRow v2: identity + corner ✎,
                type-aware meta, tag chips. The one general-edit affordance is the neutral
                corner icon (teal stays reserved for each section's primary CTA). */}
            <Card>
              <CardContent>
                <Box sx={{ display: 'flex', gap: 1.5, alignItems: 'flex-start' }}>
                  <Box sx={{ flex: 1, minWidth: 0 }}>
                    <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center' }}>
                      <Typography variant="h5" component="h1">
                        {service.name}
                      </Typography>
                      <Chip
                        size="small"
                        variant="outlined"
                        color={service.status === 'inactive' ? 'default' : 'success'}
                        label={service.status === 'inactive' ? 'Inactivo' : 'Activo'}
                      />
                    </Stack>
                    {service.description && (
                      <Typography color="text.secondary" sx={{ mt: 1 }}>
                        {service.description}
                      </Typography>
                    )}
                    {/* Meta by operational model (categories.ts): unit-based services price
                        per night on their unit types — the service-level figures are canonical
                        zeros, so only the commission is meaningful here. */}
                    {(pricesAtServiceLevel(service.category) ||
                      service.commission_value > 0) && (
                    <Typography variant="body2" color="text.secondary" className="numeric" sx={{ mt: 1.5 }}>
                      {pricesAtServiceLevel(service.category) && (
                        <>
                          {formatMoney(service.base_price)} · mín{' '}
                          {formatMoney(service.minimum_price)} · cap.{' '}
                          {service.default_capacity}
                        </>
                      )}
                      {service.commission_value > 0 && (
                        <>
                          {pricesAtServiceLevel(service.category) ? ' · comisión ' : 'Comisión '}
                          {service.commission_type === 'fixed'
                            ? `${formatMoney(service.commission_value)} por lugar`
                            : `${service.commission_value / 100}%`}
                        </>
                      )}
                    </Typography>
                    )}
                    <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap', mt: 1.5 }}>
                      {service.category && (
                        <Chip
                          size="small"
                          variant="outlined"
                          label={categoryLabel(service.category)}
                        />
                      )}
                      {service.is_flexible && (
                        <Chip
                          size="small"
                          variant="outlined"
                          color="warning"
                          label={`Flexible +${service.flex_capacity_pct}%`}
                        />
                      )}
                    </Stack>
                  </Box>
                  <Box sx={{ flexShrink: 0, mt: -1, mr: -1 }}>
                    <IconButton
                      aria-label="Editar"
                      onClick={() => setEditing(true)}
                      sx={{ color: 'text.secondary' }}
                    >
                      <EditRounded fontSize="small" />
                    </IconButton>
                  </Box>
                </Box>
              </CardContent>
            </Card>

            {/* Unit-based categories use date-range units (no slots/extras); the slot track
                keeps extras + schedules. Branches on the operational model (categories.ts). */}
            {inventoryModel(service.category) === 'units' ? (
              <Box
                ref={(el: HTMLDivElement | null) => {
                  sectionRefs.current.units = el
                }}
              >
                <UnitsSection serviceId={service.id} />
              </Box>
            ) : (
              <>
                <Card
                  ref={(el: HTMLDivElement | null) => {
                    sectionRefs.current.extras = el
                  }}
                >
                  <CardContent>
                    <Typography variant="h6" sx={{ mb: 2 }}>
                      Extras
                    </Typography>
                    <ExtrasPanel serviceId={service.id} />
                  </CardContent>
                </Card>

                <Card
                  ref={(el: HTMLDivElement | null) => {
                    sectionRefs.current.schedules = el
                  }}
                >
                  <CardContent>
                    <SchedulesSection
                      serviceId={service.id}
                      defaultCapacity={service.default_capacity}
                    />
                  </CardContent>
                </Card>
              </>
            )}

            <ServiceFormSheet
              service={editing ? service : null}
              open={editing}
              onClose={() => setEditing(false)}
            />
          </Stack>
        )}
      </Box>
    </Fade>
  )
}
