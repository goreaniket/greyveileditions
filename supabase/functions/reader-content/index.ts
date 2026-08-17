import { createClient } from 'npm:@supabase/supabase-js@2'

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const RESPONSE_HEADERS = {
  ...CORS_HEADERS,
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'private, no-store, max-age=0',
  Pragma: 'no-cache',
  Vary: 'Authorization',
}
const BUCKET = 'reader-content'
const MAX_RESOURCES = 64
const BOOK_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const RESOURCE_PATTERN = /^(?:book\.json|chapters\/[a-z0-9][a-z0-9._-]*\.json)$/i

class HttpError extends Error {
  status: number
  code: string

  constructor(status: number, message: string, code: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), {
  status,
  headers: RESPONSE_HEADERS,
})

const requireEnv = (name: string) => {
  const value = Deno.env.get(name)?.trim()
  if (!value) throw new HttpError(500, 'Reader delivery is not configured.', 'server_config_missing')
  return value
}

const serviceCredential = () => {
  const secretKeys = Deno.env.get('SUPABASE_SECRET_KEYS')?.trim()
  if (secretKeys) {
    try {
      const preferred = JSON.parse(secretKeys)?.default
      if (typeof preferred === 'string' && preferred.trim()) return preferred.trim()
    } catch (_error) {
      throw new HttpError(500, 'Reader delivery is not configured.', 'server_config_missing')
    }
  }
  return requireEnv('SUPABASE_SERVICE_ROLE_KEY')
}

const serviceClient = () => createClient(
  requireEnv('SUPABASE_URL'),
  serviceCredential(),
  { auth: { persistSession: false, autoRefreshToken: false } },
)

const viewerId = async (request: Request, admin: ReturnType<typeof serviceClient>) => {
  const authorization = request.headers.get('authorization') || ''
  if (!authorization.toLowerCase().startsWith('bearer ')) return null

  const token = authorization.slice(7).trim()
  if (!token) return null
  const { data, error } = await admin.auth.getUser(token)
  return error || !data.user ? null : data.user.id
}

const parseRequest = async (request: Request) => {
  let body: Record<string, unknown>
  try {
    body = await request.json()
  } catch (_error) {
    throw new HttpError(400, 'Send a valid reader request.', 'invalid_request')
  }

  const bookSlug = String(body.book_slug || '').trim().toLowerCase()
  if (!BOOK_SLUG_PATTERN.test(bookSlug)) {
    throw new HttpError(400, 'Choose a valid book.', 'invalid_book')
  }

  const requested = Array.isArray(body.resources)
    ? body.resources
    : body.resource == null ? [] : [body.resource]
  const resources = [...new Set(requested.map((value) => String(value || '').trim().replaceAll('\\', '/')))]
  if (!resources.length || resources.length > MAX_RESOURCES || resources.some((resource) => !RESOURCE_PATTERN.test(resource))) {
    throw new HttpError(400, 'Choose valid reader resources.', 'invalid_resource')
  }

  return { bookSlug, resources }
}

const readResource = async (
  admin: ReturnType<typeof serviceClient>,
  bookSlug: string,
  resource: string,
) => {
  const { data, error } = await admin.storage.from(BUCKET).download(`${bookSlug}/${resource}`)
  if (error || !data) throw new HttpError(404, 'Reader content is unavailable.', 'content_unavailable')

  try {
    return JSON.parse(await data.text())
  } catch (_error) {
    throw new HttpError(500, 'Reader content is unavailable.', 'invalid_content')
  }
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS })
  if (request.method !== 'POST') return json(405, { success: false, error: { code: 'method_not_allowed', message: 'Method not allowed.' } })

  try {
    const admin = serviceClient()
    const [{ bookSlug, resources }, userId] = await Promise.all([
      parseRequest(request),
      viewerId(request, admin),
    ])
    const { data: authorization, error: authorizationError } = await admin
      .rpc('greyveil_reader_content_authorization', {
        target_user_id: userId,
        target_book_slug: bookSlug,
      })
      .maybeSingle()

    if (authorizationError) throw new HttpError(500, 'Reader access could not be checked.', 'authorization_unavailable')
    if (!authorization) throw new HttpError(404, 'Reader content is unavailable.', 'book_unavailable')
    if (!authorization.allowed) {
      const status = authorization.reason === 'login_required' ? 401 : authorization.reason === 'unavailable' ? 404 : 403
      const message = authorization.reason === 'login_required'
        ? 'Please sign in to continue.'
        : authorization.reason === 'access_required'
          ? 'This account does not have access to the book.'
          : 'Reader content is unavailable.'
      throw new HttpError(status, message, String(authorization.reason || 'access_denied'))
    }

    const entries = await Promise.all(resources.map(async (resource) => [
      resource,
      await readResource(admin, bookSlug, resource),
    ] as const))

    return json(200, {
      success: true,
      book: {
        id: authorization.book_id,
        slug: authorization.book_slug,
        title: authorization.book_title,
        visibility: authorization.effective_visibility,
      },
      resources: Object.fromEntries(entries),
    })
  } catch (error) {
    const problem = error instanceof HttpError
      ? error
      : new HttpError(500, 'Reader content could not be loaded.', 'reader_delivery_failed')
    if (problem.status >= 500) {
      console.error('Reader content delivery failed.', { name: problem.name, code: problem.code, message: problem.message })
    }
    return json(problem.status, {
      success: false,
      error: {
        code: problem.code,
        message: problem.status >= 500 ? 'Reader content could not be loaded.' : problem.message,
      },
    })
  }
})
