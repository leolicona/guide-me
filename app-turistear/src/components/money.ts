// The one definition of what money looks like in the shared layer. Lives in its own module rather
// than beside a component: `MoneyText` and `EditableMoney` must render the identical string, and
// exporting a function from a component file breaks Fast Refresh (react-refresh/only-export-components).
const mxn = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' })

/** minor units (150000) → "$1,500.00". */
export const formatCents = (cents: number): string => mxn.format(cents / 100)
