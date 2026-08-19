import { createClient } from 'npm:@supabase/supabase-js@2'
import { unzipSync } from 'npm:fflate@0.8.2'
import { corsHeaders, handleCors } from '../_shared/cors.ts'

const responseHeaders = (request: Request) => ({
  ...corsHeaders(request),
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'private, no-store, max-age=0',
  Pragma: 'no-cache',
  Vary: 'Authorization, Origin',
})
const BUCKET = 'reader-content'
const MAX_RESOURCES = 64
const MAX_SOURCE_ARCHIVE_BYTES = 64 * 1024 * 1024
const BOOK_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const RESOURCE_PATTERN = /^(?:book\.json|chapters\/[a-z0-9][a-z0-9._-]*\.json)$/i
const VERSION_PATTERN = '[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}'

class HttpError extends Error {
  status: number
  code: string

  constructor(status: number, message: string, code: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

const json = (status: number, body: unknown, request: Request) => new Response(JSON.stringify(body), {
  status,
  headers: responseHeaders(request),
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

const publishedSource = async (
  admin: ReturnType<typeof serviceClient>,
  bookId: number,
  bookSlug: string,
) => {
  const { data, error } = await admin
    .from('book_files')
    .select('book_id,file_type,storage_path,file_name,mime_type,file_size,updated_at')
    .eq('book_id', bookId)
    .eq('file_type', 'source')
    .maybeSingle()
  if (error) throw new HttpError(500, 'Published Reader reference could not be checked.', 'published_reference_unavailable')
  return String(data?.storage_path || '').replaceAll('\\', '/').startsWith(`published/${bookSlug}/`)
    ? data
    : null
}

const readPublishedResources = async (
  admin: ReturnType<typeof serviceClient>,
  bookSlug: string,
  source: Record<string, unknown>,
  resources: string[],
) => {
  const storagePath = String(source.storage_path || '').trim().replaceAll('\\', '/')
  const expected = new RegExp(`^published/${bookSlug}/${VERSION_PATTERN}/source/[^/]+\\.zip$`, 'i')
  const fileSize = Number(source.file_size)
  if (source.file_type !== 'source' || !expected.test(storagePath)
      || (Number.isFinite(fileSize) && (fileSize < 0 || fileSize > MAX_SOURCE_ARCHIVE_BYTES))) {
    throw new HttpError(500, 'The published Reader reference is invalid.', 'published_reference_invalid')
  }

  const { data, error } = await admin.storage.from('book-files').download(storagePath)
  if (error || !data) throw new HttpError(404, 'Published Reader content is unavailable.', 'published_source_missing')
  if (data.size > MAX_SOURCE_ARCHIVE_BYTES) {
    throw new HttpError(500, 'The published Reader source is invalid.', 'invalid_published_source')
  }

  let entries: Record<string, Uint8Array>
  try {
    entries = unzipSync(new Uint8Array(await data.arrayBuffer()))
  } catch (_error) {
    throw new HttpError(500, 'The published Reader source is invalid.', 'invalid_published_source')
  }

  const decoder = new TextDecoder()
  return Object.fromEntries(resources.map((resource) => {
    const content = entries[`${bookSlug}/${resource}`]
    if (!content) throw new HttpError(404, 'Published Reader content is missing.', 'source_missing')
    try {
      return [resource, JSON.parse(decoder.decode(content))]
    } catch (_error) {
      throw new HttpError(500, 'Reader content is unavailable.', 'invalid_content')
    }
  }))
}

const readResources = async (
  admin: ReturnType<typeof serviceClient>,
  bookId: number,
  bookSlug: string,
  resources: string[],
) => {
  const source = await publishedSource(admin, bookId, bookSlug)
  if (source) {
    return { source: 'published', resources: await readPublishedResources(admin, bookSlug, source, resources) }
  }

  const entries = await Promise.all(resources.map(async (resource) => [
    resource,
    await readResource(admin, bookSlug, resource),
  ] as const))
  return { source: 'legacy', resources: Object.fromEntries(entries) }
}

Deno.serve(async (request) => {
  const corsResponse = handleCors(request)
  if (corsResponse) return corsResponse
  if (request.method !== 'POST') return json(405, { success: false, error: { code: 'method_not_allowed', message: 'Method not allowed.' } }, request)

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

    const resolved = await readResources(admin, authorization.book_id, bookSlug, resources)

    return json(200, {
      success: true,
      book: {
        id: authorization.book_id,
        slug: authorization.book_slug,
        title: authorization.book_title,
        visibility: authorization.effective_visibility,
      },
      source: resolved.source,
      resources: resolved.resources,
    }, request)
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
    }, request)
  }
})
