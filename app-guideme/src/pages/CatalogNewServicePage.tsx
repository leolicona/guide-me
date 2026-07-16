import { useNavigate } from 'react-router-dom'
import { ServiceWizard } from '../features/catalog/components/wizard/ServiceWizard'
import { ROUTES } from '../config/routes'

// US-A38–A44 — the full-page service creation wizard (/catalog/new, admin-only, no nav shell).
// `replace: true` on every exit so Back from the destination never resurrects the empty wizard.
// US-A44 — a fully-successful create returns to the list (which toasts on `serviceCreated`);
// a partial create routes to the detail page flagged `wizardPartial` so the operator finishes
// the schedules/extras that didn't land.
export default function CatalogNewServicePage() {
  const navigate = useNavigate()
  return (
    <ServiceWizard
      onClose={() => navigate(ROUTES.CATALOG, { replace: true })}
      onCreated={(serviceId, failures) => {
        if (failures === 0) {
          navigate(ROUTES.CATALOG, { replace: true, state: { serviceCreated: true } })
        } else {
          navigate(ROUTES.CATALOG_DETAIL.replace(':id', serviceId), {
            replace: true,
            state: { wizardPartial: true },
          })
        }
      }}
    />
  )
}
