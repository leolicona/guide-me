const base64url = (input: string): string =>
  btoa(input).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')

export const buildFakeJwt = (
  identity: string,
  expOffsetSeconds = 900,
): string => {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const payload = base64url(
    JSON.stringify({
      sub: identity,
      exp: Math.floor(Date.now() / 1000) + expOffsetSeconds,
    }),
  )
  return `${header}.${payload}.signature`
}
