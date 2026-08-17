export const PRODUCTION_ORIGIN = 'https://greyveileditions.site'

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]'])
const BASE_HEADERS = {
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-razorpay-signature',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const configuredOrigins = () => new Set(
  (Deno.env.get('GREYVEIL_ALLOWED_ORIGINS') || '')
    .split(',')
    .map((origin) => origin.trim().replace(/\/$/, ''))
    .filter(Boolean),
)

export const isAllowedBrowserOrigin = (origin: string | null) => {
  if (!origin) return true
  try {
    const url = new URL(origin)
    if (url.origin === PRODUCTION_ORIGIN) return true
    if (['http:', 'https:'].includes(url.protocol) && LOCAL_HOSTNAMES.has(url.hostname)) return true
    return configuredOrigins().has(url.origin)
  } catch (_error) {
    return false
  }
}

export const corsHeaders = (request: Request) => {
  const origin = request.headers.get('origin')
  return {
    ...BASE_HEADERS,
    Vary: 'Origin',
    ...(origin && isAllowedBrowserOrigin(origin) ? { 'Access-Control-Allow-Origin': origin } : {}),
  }
}

export const handleCors = (request: Request) => {
  const origin = request.headers.get('origin')
  if (origin && !isAllowedBrowserOrigin(origin)) {
    return new Response(JSON.stringify({
      success: false,
      error: { code: 'origin_not_allowed', message: 'This website origin is not allowed.' },
    }), {
      status: 403,
      headers: { 'Content-Type': 'application/json; charset=utf-8', Vary: 'Origin' },
    })
  }

  return request.method === 'OPTIONS'
    ? new Response(null, { status: 204, headers: corsHeaders(request) })
    : null
}
