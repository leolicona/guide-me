import { useNavigate } from 'react-router-dom'
import { AffiliateWizard } from '../features/affiliates/components/AffiliateWizard'
import { ROUTES } from '../config/routes'

// US-A54–A57 — the full-page affiliate setup wizard (/affiliates/new, admin-only, no nav shell).
// `replace: true` so Back from the list never resurrects the empty wizard. On success we return
// to the list (which toasts on `affiliateCreated`), matching the service creation flow — the
// atomic create has no partial path, so there's a single exit.
export default function AffiliateNewPage() {
  const navigate = useNavigate()
  return (
    <AffiliateWizard
      onClose={() => navigate(ROUTES.AFFILIATES, { replace: true })}
      onCreated={() =>
        navigate(ROUTES.AFFILIATES, { replace: true, state: { affiliateCreated: true } })
      }
    />
  )
}
