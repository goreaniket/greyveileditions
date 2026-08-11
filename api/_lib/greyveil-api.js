const crypto = require('crypto')

const DEFAULT_SUPABASE_URL = 'https://rwwwewiphcvukcpokpmu.supabase.co'
const VALID_PURCHASE_TYPES = new Set(['book', 'series', 'collection'])
const UUID_OR_NUMERIC_PATTERN = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|\d+)$/i
const INR = 'INR'

const BOOK_PRICE = 14900
const SERIES_PRICES = {
  'human-mind': 59900,
  'human-paradox': 59900,
  'human-fiction': 49900,
}
const COLLECTION_PRICES = {
  'human-paradox-collection': 129900,
  'the-human-paradox-collection': 129900,
}

const COLLECTION_SELECT = 'id, slug, title, description, visibility, is_active, sort_order, created_at, updated_at'
const VOLUME_SELECT = 'id, collection_id, slug, title, description, visibility, is_active, sort_order, created_at, updated_at'
const SERIES_SELECT = 'id, collection_id, volume_id, slug, title, description, visibility, is_active, sort_order, created_at, updated_at'
const BOOK_SELECT = 'id, title, series, book_number, slug, visibility, series_id, is_public, is_active'
const BOOK_ACCESS_SELECT = 'user_id, book_id, access_type, granted_at, expires_at, is_visible, can_read'
const ORDER_SELECT = [
  'id',
  'user_id',
  'purchase_type',
  'book_id',
  'series_id',
  'collection_id',
  'item_name',
  'original_amount',
  'amount',
  'coupon_code',
  'discount_amount',
  'coupon_id',
  'currency',
  'status',
  'razorpay_order_id',
  'created_at',
  'updated_at',
  'paid_at',
  'verified_at',
].join(', ')

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

const normalizeSlug = (value) => getText(value)
  .toLowerCase()
  .replace(/[_\s]+/g, '-')
  .replace(/-+/g, '-')
  .replace(/^-+|-+$/g, '')

const normalizeCouponCode = (value) => getText(value).toUpperCase()

const undiscountedPricing = (purchase) => ({
  ...purchase,
  amount: Number(purchase.amount),
  originalAmount: Number(purchase.amount),
  couponId: null,
  couponCode: null,
  discountAmount: 0,
  couponValid: false,
})

const resolveCouponPricing = async (purchase, couponCode, userId = null) => {
  const normalizedCode = normalizeCouponCode(couponCode)
  if (!normalizedCode) return undiscountedPricing(purchase)

  const originalAmount = Number(purchase.amount)
  const coupon = await selectOne('coupons', {
    code: `eq.${normalizedCode}`,
    select: 'id, code, active, discount_type, discount_value, fixed_final_price, valid_from, valid_until, maximum_total_uses, maximum_uses_per_user, applicable_purchase_types, applies_to_all_products',
  })

  const now = Date.now()
  const validFrom = coupon?.valid_from ? Date.parse(coupon.valid_from) : null
  const validUntil = coupon?.valid_until ? Date.parse(coupon.valid_until) : null
  const appliesToType = Array.isArray(coupon?.applicable_purchase_types)
    && coupon.applicable_purchase_types.includes(purchase.purchaseType)

  if (!coupon?.active
      || !appliesToType
      || (Number.isFinite(validFrom) && validFrom > now)
      || (Number.isFinite(validUntil) && validUntil <= now)) {
    return undiscountedPricing(purchase)
  }

  const productRules = await selectRows('coupon_products', {
    coupon_id: `eq.${coupon.id}`,
    select: 'purchase_type, target_id',
  })
  if (coupon.applies_to_all_products === false && !productRules.some((rule) => {
    return rule.purchase_type === purchase.purchaseType
      && String(rule.target_id) === String(purchase.targetId)
  })) {
    return undiscountedPricing(purchase)
  }

  const usages = await selectRows('coupon_usages', {
    coupon_id: `eq.${coupon.id}`,
    status: 'in.(pending,redeemed)',
    select: 'user_id, status, created_at',
  })
  const countedUsages = usages.filter((usage) => {
    if (usage.status === 'redeemed') return true
    const createdAt = Date.parse(usage.created_at)
    return Number.isFinite(createdAt) && createdAt > now - 30 * 60 * 1000
  })
  const userUsages = countedUsages.filter((usage) => String(usage.user_id) === String(userId))
  if ((coupon.maximum_total_uses && countedUsages.length >= Number(coupon.maximum_total_uses))
      || (coupon.maximum_uses_per_user && userUsages.length >= Number(coupon.maximum_uses_per_user))) {
    return undiscountedPricing(purchase)
  }

  let finalAmount = originalAmount
  if (coupon.discount_type === 'fixed_final_price') {
    finalAmount = Number(coupon.fixed_final_price)
  } else if (coupon.discount_type === 'fixed_amount') {
    finalAmount = originalAmount - Number(coupon.discount_value || 0)
  } else if (coupon.discount_type === 'percentage') {
    finalAmount = Math.round(originalAmount * (100 - Number(coupon.discount_value || 0)) / 100)
  }
  finalAmount = Math.max(100, Math.min(originalAmount, finalAmount))

  return {
    ...purchase,
    amount: finalAmount,
    originalAmount,
    couponId: coupon.id,
    couponCode: coupon.code,
    discountAmount: originalAmount - finalAmount,
    couponValid: true,
  }
}

const env = (name, aliases = [], { required = true } = {}) => {
  const value = [name, ...aliases].map((key) => process.env[key]).find((item) => getText(item))
  if (required && !value) {
    throw new ApiError(500, `${name} is not configured.`, 'server_config_missing')
  }
  return value || ''
}

const supabaseUrl = () => getText(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL, DEFAULT_SUPABASE_URL).replace(/\/+$/, '')

const supabaseServiceKey = () => env('SUPABASE_SERVICE_ROLE_KEY', ['SUPABASE_SERVICE_KEY'])

const razorpayKeyId = () => env('RAZORPAY_KEY_ID')

const razorpayKeySecret = () => env('RAZORPAY_KEY_SECRET')

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
    error: {
      code: error?.code || 'request_failed',
      message,
    },
  })
}

const allowMethods = (req, res, methods) => {
  res.setHeader('Allow', methods.join(', '))
  if (req.method === 'OPTIONS') {
    sendJson(res, 204, {})
    return false
  }

  if (!methods.includes(req.method)) {
    throw new ApiError(405, 'Method not allowed.', 'method_not_allowed')
  }

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

const readJsonBody = async (req) => {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body
  const raw = await readRawBodyBuffer(req)
  const text = raw.toString('utf8').trim()
  if (!text) return {}

  try {
    return JSON.parse(text)
  } catch (_error) {
    throw new ApiError(400, 'Request body must be valid JSON.', 'invalid_json')
  }
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

const supabaseRest = async (table, { method = 'GET', query = {}, body, headers = {} } = {}) => {
  const key = supabaseServiceKey()
  const url = new URL(`/rest/v1/${table}`, `${supabaseUrl()}/`)

  Object.entries(query).forEach(([name, value]) => {
    if (value == null) return
    if (Array.isArray(value)) {
      value.forEach((item) => url.searchParams.append(name, item))
      return
    }
    url.searchParams.set(name, value)
  })

  const response = await fetch(url, {
    method,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
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

const insertRows = async (table, rows) => supabaseRest(table, {
  method: 'POST',
  body: rows,
  headers: { Prefer: 'return=representation' },
})

const upsertRows = async (table, rows, onConflict) => supabaseRest(table, {
  method: 'POST',
  query: { on_conflict: onConflict },
  body: rows,
  headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
})

const updateRows = async (table, query, updates) => supabaseRest(table, {
  method: 'PATCH',
  query,
  body: updates,
  headers: { Prefer: 'return=representation' },
})

const authenticateUser = async (req) => {
  const token = getBearerToken(req)
  if (!token) throw new ApiError(401, 'Please log in before starting checkout.', 'login_required')

  const key = supabaseServiceKey()
  const response = await fetch(`${supabaseUrl()}/auth/v1/user`, {
    headers: {
      apikey: key,
      Authorization: `Bearer ${token}`,
    },
  })
  const user = await parseJsonResponse(response)

  if (!response.ok || !user?.id) {
    throw new ApiError(401, 'Your session could not be confirmed. Please log in again.', 'invalid_session')
  }

  return { user, token }
}

const requireAdminUser = async (user, { superAdmin = false } = {}) => {
  const profile = await selectOne('profiles', {
    id: `eq.${user.id}`,
    select: 'id, display_name, role, created_at',
  })
  const allowed = superAdmin
    ? profile?.role === 'super_admin'
    : ['admin', 'super_admin'].includes(profile?.role)
  if (!allowed) throw new ApiError(403, 'Admin permission is required.', 'admin_required')
  return profile
}

const listAdminUsers = async (user) => {
  await requireAdminUser(user)
  const key = supabaseServiceKey()
  const [authResponse, profiles, paidOrders, accessGrants] = await Promise.all([
    fetch(`${supabaseUrl()}/auth/v1/admin/users?per_page=1000`, {
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
      },
    }),
    selectRows('profiles', {
      select: 'id, display_name, role, created_at',
      order: 'created_at.desc',
    }),
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
  if (!authResponse.ok) {
    throw new ApiError(authResponse.status, 'Users could not be loaded.', 'auth_admin_read_failed')
  }

  const authUsers = Array.isArray(authPayload?.users) ? authPayload.users : []
  const authById = new Map(authUsers.map((item) => [String(item.id), item]))
  const now = Date.now()
  return profiles.map((profile) => {
    const authUser = authById.get(String(profile.id))
    const orders = paidOrders.filter((order) => String(order.user_id) === String(profile.id))
    const grants = accessGrants.filter((grant) => {
      if (String(grant.user_id) !== String(profile.id)) return false
      if (!grant.expires_at) return true
      const expiry = Date.parse(grant.expires_at)
      return Number.isFinite(expiry) && expiry > now
    })
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

const requireValidId = (value, label) => {
  const id = getText(value)
  if (!UUID_OR_NUMERIC_PATTERN.test(id)) {
    throw new ApiError(400, `${label} is not valid.`, 'invalid_purchase_target')
  }
  return id
}

const fetchById = (table, id, select) => selectOne(table, {
  id: `eq.${id}`,
  select,
})

const receiptForOrder = (localOrderId) => {
  const digest = crypto.createHash('sha256').update(getText(localOrderId)).digest('hex').slice(0, 32)
  return `gve_${digest}`
}

const normalizeVisibility = (value, fallback = 'paid') => {
  const visibility = normalizeSlug(value)
  return ['public', 'paid', 'private'].includes(visibility) ? visibility : fallback
}

const visibilityForBook = (book) => {
  const explicitVisibility = normalizeVisibility(book?.visibility, 'paid')
  if (explicitVisibility === 'private') return 'private'
  if (book?.is_public === true || explicitVisibility === 'public') return 'public'
  return 'paid'
}

const isActive = (item) => item?.is_active !== false

const effectiveVisibility = ({ collection = null, volume = null, series = null, book = null } = {}) => {
  const items = [collection, volume, series, book].filter(Boolean)
  if (!items.length) return 'private'
  if (items.some((item) => normalizeVisibility(item?.visibility, 'public') === 'private')) return 'private'
  if (items.some((item) => normalizeVisibility(item?.visibility, 'public') === 'paid')) return 'paid'
  return 'public'
}

const hierarchyIsActive = ({ collection = null, volume = null, series = null, book = null } = {}) => {
  return [collection, volume, series, book].every((item) => !item || isActive(item))
}

const hierarchyIsComplete = ({ collection = null, volume = null, series = null, book = null } = {}) => {
  if (book) return Boolean(collection && volume && series)
  if (series) return Boolean(collection && volume)
  if (volume) return Boolean(collection)
  return Boolean(collection)
}

const assertPurchaseableHierarchy = (hierarchy) => {
  if (!hierarchyIsComplete(hierarchy) || !hierarchyIsActive(hierarchy)) {
    throw new ApiError(404, 'This purchase is not currently available.', 'purchase_unavailable')
  }

  const book = hierarchy.book ? { ...hierarchy.book, visibility: visibilityForBook(hierarchy.book) } : null
  if (effectiveVisibility({ ...hierarchy, book }) === 'private') {
    throw new ApiError(404, 'This purchase is not currently available.', 'purchase_unavailable')
  }
}

const resolveCollectionForSeries = async (series, volume = null) => {
  const collectionId = series?.collection_id || volume?.collection_id
  return collectionId ? fetchById('collections', collectionId, COLLECTION_SELECT) : null
}

const resolvePurchaseFromBody = async (body) => {
  const purchaseType = normalizeSlug(body?.purchase_type)
  if (!VALID_PURCHASE_TYPES.has(purchaseType)) {
    throw new ApiError(400, 'Choose a valid purchase type.', 'invalid_purchase_type')
  }

  const targetFields = {
    book: getText(body?.book_id),
    series: getText(body?.series_id),
    collection: getText(body?.collection_id),
  }
  const providedTargets = Object.entries(targetFields).filter(([, value]) => value)

  if (providedTargets.length !== 1 || providedTargets[0][0] !== purchaseType) {
    throw new ApiError(400, 'Send exactly one matching purchase target.', 'invalid_purchase_target')
  }

  if (purchaseType === 'book') {
    const bookId = requireValidId(targetFields.book, 'book_id')
    const book = await fetchById('books', bookId, BOOK_SELECT)
    if (!book) throw new ApiError(404, 'This book is not available.', 'purchase_unavailable')

    const series = book.series_id ? await fetchById('series', book.series_id, SERIES_SELECT) : null
    const volume = series?.volume_id ? await fetchById('volumes', series.volume_id, VOLUME_SELECT) : null
    const collection = await resolveCollectionForSeries(series, volume)
    const hierarchy = { collection, volume, series, book }
    assertPurchaseableHierarchy(hierarchy)
    if (visibilityForBook(book) === 'public') {
      throw new ApiError(409, 'This book is free to read and cannot be purchased.', 'public_book_not_purchasable')
    }

    return {
      purchaseType,
      bookId,
      seriesId: null,
      collectionId: null,
      targetId: bookId,
      itemName: getText(book.title, 'Greyveil Book'),
      amount: BOOK_PRICE,
      currency: INR,
      hierarchy,
    }
  }

  if (purchaseType === 'series') {
    const seriesId = requireValidId(targetFields.series, 'series_id')
    const series = await fetchById('series', seriesId, SERIES_SELECT)
    if (!series) throw new ApiError(404, 'This series is not available.', 'purchase_unavailable')

    const volume = series.volume_id ? await fetchById('volumes', series.volume_id, VOLUME_SELECT) : null
    const collection = await resolveCollectionForSeries(series, volume)
    const hierarchy = { collection, volume, series }
    assertPurchaseableHierarchy(hierarchy)

    const amount = SERIES_PRICES[normalizeSlug(series.slug)]
    if (!amount) throw new ApiError(400, 'This series is not configured for checkout.', 'price_not_configured')

    return {
      purchaseType,
      bookId: null,
      seriesId,
      collectionId: null,
      targetId: seriesId,
      itemName: getText(series.title, 'Greyveil Series'),
      amount,
      currency: INR,
      hierarchy,
    }
  }

  const collectionId = requireValidId(targetFields.collection, 'collection_id')
  const collection = await fetchById('collections', collectionId, COLLECTION_SELECT)
  if (!collection) throw new ApiError(404, 'This collection is not available.', 'purchase_unavailable')

  const hierarchy = { collection }
  assertPurchaseableHierarchy(hierarchy)
  const collectionSlug = normalizeSlug(collection.slug)
  const amount = COLLECTION_PRICES[collectionSlug]
    || (normalizeSlug(collection.title).includes('human-paradox') ? COLLECTION_PRICES['human-paradox-collection'] : null)

  if (!amount) throw new ApiError(400, 'This collection is not configured for checkout.', 'price_not_configured')

  return {
    purchaseType,
    bookId: null,
    seriesId: null,
    collectionId,
    targetId: collectionId,
    itemName: getText(collection.title, 'Greyveil Collection'),
    amount,
    currency: INR,
    hierarchy,
  }
}

const idsMatch = (left, right) => String(left ?? '') === String(right ?? '')

const isCurrentGrant = (grant) => {
  if (!grant || grant.is_visible !== true || grant.can_read !== true) return false
  if (!grant.expires_at) return true
  const expiresAt = Date.parse(grant.expires_at)
  return Number.isFinite(expiresAt) && expiresAt > Date.now()
}

const paidOrderType = (order) => {
  const explicitType = normalizeSlug(order?.purchase_type)
  if (VALID_PURCHASE_TYPES.has(explicitType)) return explicitType

  const populatedTargets = ['book', 'series', 'collection']
    .filter((type) => getText(order?.[`${type}_id`]))
  return populatedTargets.length === 1 ? populatedTargets[0] : ''
}

const paidOrderMatches = (order, purchaseType, targetId) => {
  return normalizeSlug(order?.status) === 'paid'
    && paidOrderType(order) === purchaseType
    && idsMatch(order?.[`${purchaseType}_id`], targetId)
}

const hasPaidProductOrder = (paidOrders, purchaseType, targetId) => {
  if (!targetId) return false
  return paidOrders.some((order) => paidOrderMatches(order, purchaseType, targetId))
}

const resolveEffectivePurchaseEntitlement = async (user, purchase) => {
  if (purchase.purchaseType === 'book'
      && hierarchyIsComplete(purchase.hierarchy)
      && hierarchyIsActive(purchase.hierarchy)
      && visibilityForBook(purchase.hierarchy.book) === 'public') {
    return { entitled: true, reason: 'public' }
  }

  const profile = await selectOne('profiles', {
    id: `eq.${user.id}`,
    select: 'id, role',
  })
  const role = normalizeSlug(profile?.role || 'customer').replace(/-/g, '_')
  if (role === 'admin' || role === 'super_admin') {
    return { entitled: true, reason: role }
  }

  const [paidOrders, grants] = await Promise.all([
    selectRows('orders', {
      user_id: `eq.${user.id}`,
      status: 'eq.paid',
      select: 'id, user_id, purchase_type, book_id, series_id, collection_id, status, paid_at',
    }),
    ['book', 'series'].includes(purchase.purchaseType)
      ? selectRows('book_access', {
      user_id: `eq.${user.id}`,
      ...(purchase.purchaseType === 'book' ? { book_id: `eq.${purchase.bookId}` } : {}),
      select: BOOK_ACCESS_SELECT,
    })
      : Promise.resolve([]),
  ])

  if (purchase.purchaseType === 'collection') {
    const entitled = hasPaidProductOrder(paidOrders, 'collection', purchase.collectionId)
    return { entitled, reason: entitled ? 'collection_order' : 'not_entitled' }
  }

  const collectionId = purchase.hierarchy.collection?.id
  if (purchase.purchaseType === 'series') {
    const paidEntitlement = hasPaidProductOrder(paidOrders, 'series', purchase.seriesId)
      || hasPaidProductOrder(paidOrders, 'collection', collectionId)
    if (paidEntitlement) return { entitled: true, reason: 'series_or_collection_order' }

    const seriesBooks = await selectRows('books', {
      series_id: `eq.${purchase.seriesId}`,
      select: BOOK_SELECT,
    })
    const eligibleBookIds = seriesBooks
      .filter((book) => isActive(book) && visibilityForBook(book) !== 'private')
      .map((book) => String(book.id))
    const grantedBookIds = new Set(grants.filter(isCurrentGrant).map((grant) => String(grant.book_id)))
    const fullyGranted = eligibleBookIds.length > 0
      && eligibleBookIds.every((bookId) => grantedBookIds.has(bookId))
    return { entitled: fullyGranted, reason: fullyGranted ? 'series_owner_grant' : 'not_entitled' }
  }

  const book = { ...purchase.hierarchy.book, visibility: visibilityForBook(purchase.hierarchy.book) }
  const publicAccess = effectiveVisibility({ ...purchase.hierarchy, book }) === 'public'
  const directGrant = grants.some(isCurrentGrant)
  const paidAccess = hasPaidProductOrder(paidOrders, 'book', purchase.bookId)
    || hasPaidProductOrder(paidOrders, 'series', purchase.hierarchy.series?.id)
    || hasPaidProductOrder(paidOrders, 'collection', collectionId)
  const entitled = publicAccess || directGrant || paidAccess

  return {
    entitled,
    reason: publicAccess
      ? 'public'
      : directGrant
        ? 'book_access'
        : paidAccess
          ? 'paid_order'
          : 'not_entitled',
  }
}

const assertPurchaseNotEntitled = async (user, purchase) => {
  const entitlement = await resolveEffectivePurchaseEntitlement(user, purchase)
  if (entitlement.entitled) {
    throw new ApiError(409, 'This item is already in your library.', 'already_entitled')
  }
  return entitlement
}

const razorpayRequest = async (path, { method = 'GET', body } = {}) => {
  const auth = Buffer.from(`${razorpayKeyId()}:${razorpayKeySecret()}`).toString('base64')
  const response = await fetch(`https://api.razorpay.com/v1${path}`, {
    method,
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const payload = await parseJsonResponse(response)

  if (!response.ok) {
    const message = payload?.error?.description || payload?.message || response.statusText || 'Razorpay request failed.'
    throw new ApiError(response.status, message, payload?.error?.code || 'razorpay_request_failed', payload)
  }

  return payload
}

const createRazorpayOrder = (purchase, localOrderId, user) => razorpayRequest('/orders', {
  method: 'POST',
  body: {
    amount: purchase.amount,
    currency: purchase.currency,
    receipt: receiptForOrder(localOrderId),
    notes: {
      local_order_id: localOrderId,
      user_id: user.id,
      purchase_type: purchase.purchaseType,
      target_id: purchase.targetId,
      item_name: purchase.itemName,
      original_amount: String(purchase.originalAmount),
      discount_amount: String(purchase.discountAmount),
      ...(purchase.couponCode ? { coupon_code: purchase.couponCode } : {}),
    },
  },
})

const fetchRazorpayPayment = (paymentId) => razorpayRequest(`/payments/${encodeURIComponent(paymentId)}`)

const createCheckoutOrder = async (user, body) => {
  const resolvedPurchase = await resolvePurchaseFromBody(body)
  await assertPurchaseNotEntitled(user, resolvedPurchase)
  const purchase = await resolveCouponPricing(resolvedPurchase, body?.coupon_code, user.id)
  const now = new Date().toISOString()
  const orderPayload = {
    user_id: user.id,
    purchase_type: purchase.purchaseType,
    book_id: purchase.bookId,
    series_id: purchase.seriesId,
    collection_id: purchase.collectionId,
    item_name: purchase.itemName,
    original_amount: purchase.originalAmount,
    amount: purchase.amount,
    coupon_code: purchase.couponCode,
    coupon_id: purchase.couponId,
    discount_amount: purchase.discountAmount,
    currency: purchase.currency,
    status: 'pending',
    created_at: now,
    updated_at: now,
  }

  const pendingRows = await insertRows('orders', orderPayload)
  const pendingOrder = Array.isArray(pendingRows) ? pendingRows[0] : pendingRows
  if (!pendingOrder?.id) {
    throw new ApiError(500, 'The local payment order could not be created.', 'order_create_failed')
  }

  if (purchase.couponId) {
    try {
      await insertRows('coupon_usages', {
        coupon_id: purchase.couponId,
        order_id: pendingOrder.id,
        user_id: user.id,
        coupon_code: purchase.couponCode,
        discount_amount: purchase.discountAmount,
        status: 'pending',
        created_at: now,
        updated_at: now,
      })
    } catch (_error) {
      await updateRows('orders', { id: `eq.${pendingOrder.id}` }, {
        status: 'failed',
        updated_at: new Date().toISOString(),
      }).catch(() => null)
      throw new ApiError(409, 'This coupon is no longer available.', 'coupon_limit_reached')
    }
  }

  let razorpayOrder
  try {
    razorpayOrder = await createRazorpayOrder(purchase, pendingOrder.id, user)
    if (!getText(razorpayOrder?.id)
        || toNumber(razorpayOrder?.amount) !== purchase.amount
        || getText(razorpayOrder?.currency, INR).toUpperCase() !== purchase.currency) {
      throw new ApiError(502, 'Razorpay returned an unexpected order.', 'razorpay_order_mismatch')
    }
  } catch (error) {
    await updateRows('orders', { id: `eq.${pendingOrder.id}` }, {
      status: 'failed',
      updated_at: new Date().toISOString(),
    }).catch(() => null)
    if (purchase.couponId) {
      await updateRows('coupon_usages', { order_id: `eq.${pendingOrder.id}` }, {
        status: 'void',
        updated_at: new Date().toISOString(),
      }).catch(() => null)
    }
    throw error
  }

  const updatedRows = await updateRows('orders', { id: `eq.${pendingOrder.id}` }, {
    razorpay_order_id: razorpayOrder.id,
    updated_at: new Date().toISOString(),
  })
  const order = Array.isArray(updatedRows) ? updatedRows[0] : updatedRows

  return {
    order_id: razorpayOrder.id,
    amount: purchase.amount,
    original_amount: purchase.originalAmount,
    coupon_code: purchase.couponCode,
    discount_amount: purchase.discountAmount,
    currency: purchase.currency,
    key_id: razorpayKeyId(),
    local_order_id: order?.id || pendingOrder.id,
  }
}

const previewCheckoutPricing = async (user, body) => {
  const resolvedPurchase = await resolvePurchaseFromBody(body)
  await assertPurchaseNotEntitled(user, resolvedPurchase)
  const purchase = await resolveCouponPricing(resolvedPurchase, body?.coupon_code, user.id)

  return {
    valid: purchase.couponValid,
    coupon_code: purchase.couponCode,
    item_name: purchase.itemName,
    original_amount: purchase.originalAmount,
    final_amount: purchase.amount,
    discount_amount: purchase.discountAmount,
    currency: purchase.currency,
  }
}

const expectedPaymentSignature = (razorpayOrderId, paymentId) => crypto
  .createHmac('sha256', razorpayKeySecret())
  .update(`${razorpayOrderId}|${paymentId}`)
  .digest('hex')

const timingSafeTextEqual = (left, right) => {
  const leftBuffer = Buffer.from(getText(left), 'utf8')
  const rightBuffer = Buffer.from(getText(right), 'utf8')
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer)
}

const verifyPaymentSignature = ({ razorpayOrderId, paymentId, signature }) => {
  const expected = expectedPaymentSignature(razorpayOrderId, paymentId)
  if (!timingSafeTextEqual(expected, signature)) {
    throw new ApiError(400, 'Payment signature could not be verified.', 'invalid_payment_signature')
  }
}

const verifyWebhookSignature = (rawBody, signature) => {
  const secret = env('RAZORPAY_WEBHOOK_SECRET', [], { required: false })
  if (!secret) throw new ApiError(500, 'RAZORPAY_WEBHOOK_SECRET is not configured.', 'server_config_missing')

  const expected = crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex')

  if (!timingSafeTextEqual(expected, signature)) {
    throw new ApiError(400, 'Webhook signature could not be verified.', 'invalid_webhook_signature')
  }
}

const fetchUserOrder = async (localOrderId, userId) => {
  const id = requireValidId(localOrderId, 'local_order_id')
  return selectOne('orders', {
    id: `eq.${id}`,
    user_id: `eq.${userId}`,
    select: ORDER_SELECT,
  })
}

const fetchOrderByRazorpayId = (razorpayOrderId) => selectOne('orders', {
  razorpay_order_id: `eq.${getText(razorpayOrderId)}`,
  select: ORDER_SELECT,
})

const toNumber = (value, fallback = 0) => {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

const paymentCaptured = (payment) => payment?.status === 'captured' || payment?.captured === true

const paymentMatchesOrder = (payment, order) => {
  return getText(payment?.order_id) === getText(order?.razorpay_order_id)
    && toNumber(payment?.amount) === toNumber(order?.amount)
    && getText(payment?.currency, INR).toUpperCase() === getText(order?.currency, INR).toUpperCase()
}

const paymentPayloadForOrder = (order, payment, { signature = null, webhookEventId = null } = {}) => {
  const now = new Date().toISOString()
  const payload = {
    order_id: order?.id || null,
    user_id: order?.user_id || null,
    razorpay_payment_id: getText(payment?.id),
    razorpay_order_id: getText(payment?.order_id, order?.razorpay_order_id),
    original_amount: toNumber(order?.original_amount, order?.amount),
    amount: toNumber(payment?.amount, order?.amount),
    coupon_code: order?.coupon_code || null,
    coupon_id: order?.coupon_id || null,
    discount_amount: toNumber(order?.discount_amount),
    currency: getText(payment?.currency, order?.currency || INR).toUpperCase(),
    status: getText(payment?.status, 'unknown'),
    method: payment?.method || null,
    captured: paymentCaptured(payment),
    raw_payload: payment || {},
    razorpay_created_at: payment?.created_at ? new Date(Number(payment.created_at) * 1000).toISOString() : null,
    verified_at: paymentCaptured(payment) ? now : null,
    updated_at: now,
  }

  if (signature) payload.razorpay_signature = signature
  if (webhookEventId) payload.webhook_event_id = webhookEventId
  return payload
}

const persistPayment = async (order, payment, options = {}) => {
  if (!getText(payment?.id)) throw new ApiError(400, 'Payment id is missing.', 'invalid_payment')
  const rows = await upsertRows('payments', paymentPayloadForOrder(order, payment, options), 'razorpay_payment_id')
  return Array.isArray(rows) ? rows[0] : rows
}

const markOrderStatus = async (order, status, extra = {}) => {
  const rows = await updateRows('orders', {
    id: `eq.${order.id}`,
  }, {
    status,
    updated_at: new Date().toISOString(),
    ...extra,
  })
  const updatedOrder = Array.isArray(rows) ? rows[0] : rows
  if (order?.coupon_id) {
    const usageStatus = status === 'paid'
      ? 'redeemed'
      : status === 'refunded'
        ? 'refunded'
        : ['failed', 'cancelled'].includes(status)
          ? 'void'
          : null
    if (usageStatus) {
      await updateRows('coupon_usages', { order_id: `eq.${order.id}` }, {
        status: usageStatus,
        redeemed_at: usageStatus === 'redeemed' ? new Date().toISOString() : null,
        updated_at: new Date().toISOString(),
      }).catch(() => null)
    }
  }
  return updatedOrder
}

const verifyCheckoutPayment = async (user, body) => {
  const localOrderId = requireValidId(body?.local_order_id, 'local_order_id')
  const paymentId = getText(body?.razorpay_payment_id)
  const checkoutOrderId = getText(body?.razorpay_order_id)
  const signature = getText(body?.razorpay_signature)

  if (!paymentId || !checkoutOrderId || !signature) {
    throw new ApiError(400, 'Payment verification details are incomplete.', 'invalid_payment_verification')
  }

  const order = await fetchUserOrder(localOrderId, user.id)
  if (!order) throw new ApiError(404, 'Order was not found for this account.', 'order_not_found')
  if (checkoutOrderId !== order.razorpay_order_id) {
    throw new ApiError(400, 'Payment order did not match the checkout order.', 'order_mismatch')
  }

  verifyPaymentSignature({
    razorpayOrderId: order.razorpay_order_id,
    paymentId,
    signature,
  })

  const payment = await fetchRazorpayPayment(paymentId)
  if (!paymentMatchesOrder(payment, order)) {
    await persistPayment(order, payment, { signature })
    throw new ApiError(400, 'Payment details did not match the order.', 'payment_mismatch')
  }

  const persistedPayment = await persistPayment(order, payment, { signature })
  if (!paymentCaptured(payment)) {
    await markOrderStatus(order, payment.status === 'failed' ? 'failed' : 'pending')
    return {
      success: false,
      paid: false,
      status: payment.status,
      local_order_id: order.id,
      payment_id: persistedPayment?.razorpay_payment_id || payment.id,
      original_amount: toNumber(order.original_amount, order.amount),
      amount: toNumber(order.amount),
      coupon_code: order.coupon_code || null,
      discount_amount: toNumber(order.discount_amount),
    }
  }

  const paidAt = new Date().toISOString()
  const updatedOrder = await markOrderStatus(order, 'paid', {
    paid_at: order.paid_at || paidAt,
    verified_at: paidAt,
  })

  return {
    success: true,
    paid: true,
    status: 'paid',
    local_order_id: updatedOrder?.id || order.id,
    purchase_type: order.purchase_type,
    item_name: order.item_name,
    payment_id: persistedPayment?.razorpay_payment_id || payment.id,
    original_amount: toNumber(order.original_amount, order.amount),
    amount: toNumber(order.amount),
    coupon_code: order.coupon_code || null,
    discount_amount: toNumber(order.discount_amount),
  }
}

const processWebhookEvent = async (event) => {
  const eventName = getText(event?.event)
  const eventId = getText(event?.id)
  const payment = event?.payload?.payment?.entity || null
  const razorpayOrder = event?.payload?.order?.entity || null
  const razorpayOrderId = getText(payment?.order_id || razorpayOrder?.id)
  const order = razorpayOrderId ? await fetchOrderByRazorpayId(razorpayOrderId) : null

  if (payment?.id) {
    await persistPayment(order, payment, { webhookEventId: eventId || eventName || null })
  }

  if (!order) {
    return { processed: false, reason: 'local_order_not_found', event: eventName }
  }

  if (eventName === 'payment.failed') {
    if (order.status !== 'paid') await markOrderStatus(order, 'failed')
    return { processed: true, status: 'failed', event: eventName }
  }

  if (payment?.status === 'refunded' || eventName === 'payment.refunded' || eventName === 'refund.processed') {
    await markOrderStatus(order, 'refunded')
    return { processed: true, status: 'refunded', event: eventName }
  }

  if (payment && paymentCaptured(payment) && paymentMatchesOrder(payment, order)) {
    await markOrderStatus(order, 'paid', {
      paid_at: order.paid_at || new Date().toISOString(),
      verified_at: new Date().toISOString(),
    })
    return { processed: true, status: 'paid', event: eventName }
  }

  return { processed: true, status: order.status || 'pending', event: eventName }
}

module.exports = {
  ApiError,
  allowMethods,
  authenticateUser,
  createCheckoutOrder,
  previewCheckoutPricing,
  processWebhookEvent,
  readJsonBody,
  readRawBodyBuffer,
  sendError,
  sendJson,
  verifyCheckoutPayment,
  verifyWebhookSignature,
  resolveCouponPricing,
  resolveEffectivePurchaseEntitlement,
  listAdminUsers,
}
