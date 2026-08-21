import { useNavigate } from 'react-router-dom'
import { ServiceWizard } from '../features/catalog/components/wizard/ServiceWizard'
import { ROUTES } from '../config/routes'

// US-A38–A44 — the full-page service creation wizard (/catalog/new, admin-only, no nav shell).
// `replace: true` on every exit so Back from the destination never resurrects the empty wizard.
// US-A44 — a fully-successful create returns to the list (which toasts on `serviceCreated`);
// a partial create routes to the detail page flagged `wizardPartial` so the operator finishes
// the schedules/extras that didn't land.
//
// US-A91 D15 — units attached to an EXISTING property always land on that property's detail,
// success or partial: the admin ends up looking at the property with its units inside it, which
// is the hierarchy drawn rather than described, and the toast names the container one last time.
export default function CatalogNewServicePage() {
  const navigate = useNavigate()
  return (
    <ServiceWizard
      onClose={() => navigate(ROUTES.CATALOG, { replace: true })}
      onCreated={(serviceId, failures, attached) => {
        const detail = ROUTES.CATALOG_DETAIL.replace(':id', serviceId)
        if (attached) {
          navigate(detail, {
            replace: true,
            state: {
              scrollTo: 'units',
              unitsAdded: {
                propertyName: attached.propertyName,
                saved: attached.unitCount - failures,
                total: attached.unitCount,
              },
            },
          })
        } else if (failures === 0) {
          navigate(ROUTES.CATALOG, { replace: true, state: { serviceCreated: true } })
        } else {
          navigate(detail, { replace: true, state: { wizardPartial: true } })
        }
      }}
    />
  )
}
