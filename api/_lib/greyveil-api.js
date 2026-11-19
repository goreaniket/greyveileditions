const DEFAULT_SUPABASE_URL = 'https://rwwwewiphcvukcpokpmu.supabase.co'

class ApiError extends Error {
  constructor(statusCode, message, code = 'request_failed', details = null) {
    super(message)
    this.name = 'ApiError'
    this.statusCode = statusCode
    this.code = code
    this.details = details
  }
}

const getText = (value, fallback = '') => {
  const text = value == null ? '' : String(value).trim()
  return text || fallback
}

const env = (name, aliases = [], { required = true } = {}) => {
  const value = [name, ...aliases].map((key) => process.env[key]).find((item) => getText(item))
  if (required && !value) throw new ApiError(500, `${name} is not configured.`, 'server_config_missing')
  return value || ''
}

const supabaseUrl = () => getText(
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL,
  DEFAULT_SUPABASE_URL,
).replace(/\/+$/, '')

const supabaseServiceKey = () => env('SUPABASE_SECRET_KEY', ['SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_SERVICE_KEY'])

const sendJson = (res, statusCode, payload) => {
  res.statusCode = statusCode
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify(payload))
}

const sendError = (res, error) => {
  const statusCode = error?.statusCode || 500
  const message = statusCode >= 500 ? 'The payment service could not complete the request.' : error.message
  sendJson(res, statusCode, {
    success: false,
    error: { code: error?.code || 'request_failed', message },
  })
}

const allowMethods = (req, res, methods) => {
  res.setHeader('Allow', methods.join(', '))
  if (req.method === 'OPTIONS') {
    sendJson(res, 204, {})
    return false
  }
  if (!methods.includes(req.method)) throw new ApiError(405, 'Method not allowed.', 'method_not_allowed')
  return true
}

const readRawBodyBuffer = async (req) => {
  if (typeof req.on === 'function' && req.readableEnded !== true) {
    return new Promise((resolve, reject) => {
      const chunks = []
      req.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
      req.on('end', () => resolve(Buffer.concat(chunks)))
      req.on('error', reject)
    })
  }
  if (Buffer.isBuffer(req.body)) return req.body
  if (typeof req.body === 'string') return Buffer.from(req.body, 'utf8')
  if (req.body && typeof req.body === 'object') return Buffer.from(JSON.stringify(req.body), 'utf8')
  return Buffer.alloc(0)
}

const getBearerToken = (req) => {
  const header = req.headers.authorization || req.headers.Authorization || ''
  const match = String(header).match(/^Bearer\s+(.+)$/i)
  return match ? match[1].trim() : ''
}

const parseJsonResponse = async (response) => {
  const text = await response.text()
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch (_error) {
    return text
  }
}

const supabaseRest = async (table, { query = {} } = {}) => {
  const key = supabaseServiceKey()
  const url = new URL(`/rest/v1/${table}`, `${supabaseUrl()}/`)
  Object.entries(query).forEach(([name, value]) => {
    if (value != null) url.searchParams.set(name, value)
  })
  const response = await fetch(url, {
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
  })
  const payload = await parseJsonResponse(response)
  if (!response.ok) {
    const message = payload?.message || payload?.hint || response.statusText || 'Supabase request failed.'
    throw new ApiError(response.status, message, payload?.code || 'supabase_request_failed', payload)
  }
  return payload
}

const selectOne = async (table, query) => {
  const rows = await supabaseRest(table, { query: { ...query, limit: '1' } })
  return Array.isArray(rows) ? rows[0] || null : rows
}

const selectRows = async (table, query) => {
  const rows = await supabaseRest(table, { query })
  return Array.isArray(rows) ? rows : []
}

const authenticateUser = async (req) => {
  const token = getBearerToken(req)
  if (!token) throw new ApiError(401, 'Please log in before starting checkout.', 'login_required')
  const key = supabaseServiceKey()
  const response = await fetch(`${supabaseUrl()}/auth/v1/user`, {
    headers: { apikey: key, Authorization: `Bearer ${token}` },
  })
  const user = await parseJsonResponse(response)
  if (!response.ok || !user?.id) throw new ApiError(401, 'Your session could not be confirmed. Please log in again.', 'invalid_session')
  return { user, token }
}

const proxyEdgeFunction = async (req, res, functionName) => {
  if (!allowMethods(req, res, ['POST', 'OPTIONS'])) return
  const body = await readRawBodyBuffer(req)
  const key = supabaseServiceKey()
  const headers = {
    apikey: key,
    'Content-Type': getText(req.headers['content-type'], 'application/json'),
  }
  const authorization = getText(req.headers.authorization || req.headers.Authorization)
  const webhookSignature = getText(req.headers['x-razorpay-signature'])
  if (authorization) headers.Authorization = authorization
  if (webhookSignature) headers['x-razorpay-signature'] = webhookSignature
  const response = await fetch(`${supabaseUrl()}/functions/v1/${functionName}`, {
    method: 'POST',
    headers,
    body,
  })
  const responseBody = Buffer.from(await response.arrayBuffer())
  res.statusCode = response.status
  res.setHeader('Content-Type', response.headers.get('content-type') || 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(responseBody)
}

const requireAdminUser = async (user) => {
  const profile = await selectOne('profiles', {
    id: `eq.${user.id}`,
    select: 'id, display_name, role, created_at',
  })
  if (!['admin', 'super_admin'].includes(profile?.role)) {
    throw new ApiError(403, 'Admin permission is required.', 'admin_required')
  }
  return profile
}

const listAdminUsers = async (user) => {
  await requireAdminUser(user)
  const key = supabaseServiceKey()
  const [authResponse, profiles, paidOrders, accessGrants] = await Promise.all([
    fetch(`${supabaseUrl()}/auth/v1/admin/users?per_page=1000`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
    }),
    selectRows('profiles', { select: 'id, display_name, role, created_at', order: 'created_at.desc' }),
    selectRows('orders', {
      status: 'eq.paid',
      select: 'user_id, purchase_type, book_id, series_id, collection_id, amount',
    }),
    selectRows('book_access', {
      is_visible: 'eq.true',
      can_read: 'eq.true',
      select: 'user_id, book_id, expires_at',
    }),
  ])
  const authPayload = await parseJsonResponse(authResponse)
  if (!authResponse.ok) throw new ApiError(authResponse.status, 'Users could not be loaded.', 'auth_admin_read_failed')
  const authUsers = Array.isArray(authPayload?.users) ? authPayload.users : []
  const authById = new Map(authUsers.map((item) => [String(item.id), item]))
  const now = Date.now()
  return profiles.map((profile) => {
    const authUser = authById.get(String(profile.id))
    const orders = paidOrders.filter((order) => String(order.user_id) === String(profile.id))
    const grants = accessGrants.filter((grant) => (
      String(grant.user_id) === String(profile.id)
      && (!grant.expires_at || Date.parse(grant.expires_at) > now)
    ))
    return {
      id: profile.id,
      display_name: profile.display_name,
      email: authUser?.email || '',
      role: profile.role || 'customer',
      created_at: authUser?.created_at || profile.created_at,
      summary: {
        paid_orders: orders.length,
        books: orders.filter((order) => order.purchase_type === 'book').length,
        series: orders.filter((order) => order.purchase_type === 'series').length,
        collections: orders.filter((order) => order.purchase_type === 'collection').length,
        direct_grants: grants.length,
      },
    }
  })
}

module.exports = {
  allowMethods,
  authenticateUser,
  listAdminUsers,
  proxyEdgeFunction,
  sendError,
  sendJson,
}
