const {
  ReaderDeliveryError,
  handleReaderContentRequest,
} = require('./_lib/reader-delivery')

const DEFAULT_SUPABASE_URL = 'https://rwwwewiphcvukcpokpmu.supabase.co'
const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' }

const getText = (value) => String(value || '').trim()
const supabaseUrl = () => getText(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || DEFAULT_SUPABASE_URL).replace(/\/+$/, '')
const serviceKey = () => {
  const keySet = getText(process.env.SUPABASE_SECRET_KEYS)
  if (keySet) {
    try {
      const key = getText(JSON.parse(keySet)?.default)
      if (key) return key
    } catch (_error) {
      throw new ReaderDeliveryError(500, 'Reader delivery is not configured.', 'server_config_missing')
    }
  }
  const key = getText(process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY)
  if (!key) throw new ReaderDeliveryError(500, 'Reader delivery is not configured.', 'server_config_missing')
  return key
}

const parseResponse = async (response) => {
  const text = await response.text()
  if (!text) return null
  try { return JSON.parse(text) } catch (_error) { return text }
}

const serviceHeaders = () => ({
  apikey: serviceKey(),
  Authorization: `Bearer ${serviceKey()}`,
})

const checkedJson = async (url, options = {}, code = 'reader_delivery_failed') => {
  const response = await fetch(url, options)
  const payload = await parseResponse(response)
  if (!response.ok) throw new ReaderDeliveryError(500, 'Reader delivery failed.', code)
  return payload
}

const objectUrl = (bucket, path) => {
  const encoded = String(path || '').split('/').map((segment) => encodeURIComponent(segment)).join('/')
  return `${supabaseUrl()}/storage/v1/object/${bucket}/${encoded}`
}

const downloadObject = async (bucket, path, missingCode) => {
  const response = await fetch(objectUrl(bucket, path), { headers: serviceHeaders() })
  if (!response.ok) {
    const status = response.status === 404 ? 404 : 500
    throw new ReaderDeliveryError(status, 'Reader content is unavailable.', missingCode)
  }
  return Buffer.from(await response.arrayBuffer())
}

const services = {
  resolveViewerId: async (token) => {
    if (!token) return null
    const response = await fetch(`${supabaseUrl()}/auth/v1/user`, {
      headers: { apikey: serviceKey(), Authorization: `Bearer ${token}` },
    })
    if (!response.ok) return null
    const user = await parseResponse(response)
    return user?.id || null
  },

  authorize: async (viewerId, bookSlug) => {
    const payload = await checkedJson(
      `${supabaseUrl()}/rest/v1/rpc/greyveil_reader_content_authorization`,
      {
        method: 'POST',
        headers: { ...serviceHeaders(), ...JSON_HEADERS },
        body: JSON.stringify({ target_user_id: viewerId, target_book_slug: bookSlug }),
      },
      'authorization_unavailable',
    )
    return Array.isArray(payload) ? payload[0] || null : payload
  },

  findPublishedSource: async (bookId, bookSlug) => {
    const query = new URLSearchParams({
      book_id: `eq.${bookId}`,
      file_type: 'eq.source',
      select: 'book_id,file_type,storage_path,file_name,mime_type,file_size,updated_at',
      limit: '1',
    })
    const payload = await checkedJson(
      `${supabaseUrl()}/rest/v1/book_files?${query}`,
      { headers: serviceHeaders() },
      'published_reference_unavailable',
    )
    const record = Array.isArray(payload) ? payload[0] || null : payload
    return String(record?.storage_path || '').replaceAll('\\', '/').startsWith(`published/${bookSlug}/`)
      ? record
      : null
  },

  downloadPublishedSource: (path) => downloadObject('book-files', path, 'published_source_missing'),
  downloadLegacyResource: (bookSlug, resource) => downloadObject('reader-content', `${bookSlug}/${resource}`, 'source_missing'),
}

const readBody = (req) => {
  if (Buffer.isBuffer(req.body)) return JSON.parse(req.body.toString('utf8'))
  if (typeof req.body === 'string') return JSON.parse(req.body)
  return req.body && typeof req.body === 'object' ? req.body : {}
}

const send = (res, status, body) => {
  res.statusCode = status
  res.setHeader('Content-Type', JSON_HEADERS['Content-Type'])
  res.setHeader('Cache-Control', 'private, no-store, max-age=0')
  res.setHeader('Pragma', 'no-cache')
  res.setHeader('Vary', 'Authorization')
  res.end(JSON.stringify(body))
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.setHeader('Allow', 'POST, OPTIONS')
    send(res, 204, {})
    return
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS')
    send(res, 405, { success: false, error: { code: 'method_not_allowed', message: 'Method not allowed.' } })
    return
  }

  let body
  try {
    body = readBody(req)
  } catch (_error) {
    send(res, 400, { success: false, error: { code: 'invalid_request', message: 'Send a valid reader request.' } })
    return
  }
  const authorization = String(req.headers.authorization || req.headers.Authorization || '')
  const token = authorization.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() || ''
  const result = await handleReaderContentRequest({ body, token }, services)
  send(res, result.status, result.body)
}
