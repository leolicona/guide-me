// Read a required env var (secrets / target ids). Throws a clear message rather than running with an
// empty value — the test NEVER hardcodes a credential; the runner supplies them at runtime.
export function env(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`Missing required env var ${name} — see e2e/README.md.`)
  return v
}
