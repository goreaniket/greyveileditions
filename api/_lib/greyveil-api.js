const crypto = require('crypto')

const DEFAULT_SUPABASE_URL = 'https://rwwwewiphcvukcpokpmu.supabase.co'
const VALID_PURCHASE_TYPES = new Set(['book', 'series', 'collection'])
const UUID_OR_NUMERIC_PATTERN = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|\d+)$/i
const INR = 'INR'
const TEST_COUPON_CODE = 'RIZZ'
const TEST_COUPON_AMOUNT = 100

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

const resolveCouponPricing = (purchase, couponCode) => {
  const normalizedCode = normalizeCouponCode(couponCode)
  const valid = normalizedCode === TEST_COUPON_CODE
  const originalAmount = Number(purchase.amount)
  const finalAmount = valid ? TEST_COUPON_AMOUNT : originalAmount

  return {
    ...purchase,
    amount: finalAmount,
    originalAmount,
    couponCode: valid ? TEST_COUPON_CODE : null,
    discountAmount: originalAmount - finalAmount,
    couponValid: valid,
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

const visibilityForBook = (book) => normalizeVisibility(book?.visibility, book?.is_public === true ? 'public' : 'paid')

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

const inFilter = (values = []) => `in.(${[...new Set(values.filter(Boolean))].join(',')})`

const serverBookHierarchy = (book, seriesItems = [], volumes = [], collections = []) => {
  const series = seriesItems.find((item) => idsMatch(item.id, book?.series_id)) || null
  const volume = volumes.find((item) => idsMatch(item.id, series?.volume_id)) || null
  const collectionId = series?.collection_id || volume?.collection_id
  const collection = collections.find((item) => idsMatch(item.id, collectionId)) || null
  return { collection, volume, series, book }
}

const eligibleHierarchy = (hierarchy) => {
  if (!hierarchyIsComplete(hierarchy) || !hierarchyIsActive(hierarchy)) return false
  const book = hierarchy.book ? { ...hierarchy.book, visibility: visibilityForBook(hierarchy.book) } : null
  return effectiveVisibility({ ...hierarchy, book }) !== 'private'
}

const eligibleBooksForPurchase = async (purchase) => {
  if (purchase.purchaseType === 'book') {
    return eligibleHierarchy(purchase.hierarchy) ? [purchase.hierarchy] : []
  }

  if (purchase.purchaseType === 'series') {
    const books = await selectRows('books', {
      series_id: `eq.${purchase.seriesId}`,
      select: BOOK_SELECT,
    })
    return books
      .map((book) => ({ ...purchase.hierarchy, book }))
      .filter(eligibleHierarchy)
  }

  const collection = purchase.hierarchy.collection
  const directSeriesPromise = selectRows('series', {
    collection_id: `eq.${purchase.collectionId}`,
    select: SERIES_SELECT,
  })
  const collectionVolumes = await selectRows('volumes', {
    collection_id: `eq.${purchase.collectionId}`,
    select: VOLUME_SELECT,
  })
  const volumeIds = collectionVolumes.map((volume) => volume.id).filter(Boolean)
  const volumeSeriesPromise = volumeIds.length
    ? selectRows('series', {
      volume_id: inFilter(volumeIds),
      select: SERIES_SELECT,
    })
    : Promise.resolve([])
  const [directSeries, volumeSeries] = await Promise.all([directSeriesPromise, volumeSeriesPromise])
  const seriesItems = [...new Map([...directSeries, ...volumeSeries].map((series) => [String(series.id), series])).values()]
  const referencedVolumeIds = [...new Set(seriesItems.map((series) => series.volume_id).filter(Boolean))]
  const missingVolumeIds = referencedVolumeIds.filter((id) => !collectionVolumes.some((volume) => idsMatch(volume.id, id)))
  const extraVolumes = missingVolumeIds.length
    ? await selectRows('volumes', {
      id: inFilter(missingVolumeIds),
      select: VOLUME_SELECT,
    })
    : []
  const volumes = [...collectionVolumes, ...extraVolumes]
  const seriesIds = seriesItems.map((series) => series.id).filter(Boolean)
  const books = seriesIds.length
    ? await selectRows('books', {
      series_id: inFilter(seriesIds),
      select: BOOK_SELECT,
    })
    : []

  return books
    .map((book) => serverBookHierarchy(book, seriesItems, volumes, [collection]))
    .filter(eligibleHierarchy)
    .filter((hierarchy) => idsMatch(hierarchy.collection?.id, purchase.collectionId))
}

const isCurrentGrant = (grant) => {
  if (!grant || grant.is_visible !== true || grant.can_read !== true) return false
  if (!grant.expires_at) return true
  const expiresAt = Date.parse(grant.expires_at)
  return Number.isFinite(expiresAt) && expiresAt > Date.now()
}

const resolveEffectivePurchaseEntitlement = async (user, purchase) => {
  const profile = await selectOne('profiles', {
    id: `eq.${user.id}`,
    select: 'id, role',
  })
  const role = normalizeSlug(profile?.role || 'customer').replace(/-/g, '_')
  if (role === 'admin' || role === 'super_admin') {
    return { entitled: true, reason: role, eligibleBookIds: [] }
  }

  const eligibleBooks = await eligibleBooksForPurchase(purchase)
  if (!eligibleBooks.length) {
    return { entitled: false, reason: 'not_entitled', eligibleBookIds: [] }
  }

  const paidBookIds = eligibleBooks
    .filter((hierarchy) => {
      const book = { ...hierarchy.book, visibility: visibilityForBook(hierarchy.book) }
      return effectiveVisibility({ ...hierarchy, book }) !== 'public'
    })
    .map((hierarchy) => hierarchy.book.id)
  const grants = paidBookIds.length
    ? await selectRows('book_access', {
      user_id: `eq.${user.id}`,
      book_id: inFilter(paidBookIds),
      select: BOOK_ACCESS_SELECT,
    })
    : []
  const currentBookIds = new Set(
    grants.filter(isCurrentGrant).map((grant) => String(grant.book_id))
  )
  const entitled = eligibleBooks.every((hierarchy) => {
    const book = { ...hierarchy.book, visibility: visibilityForBook(hierarchy.book) }
    const visibility = effectiveVisibility({ ...hierarchy, book })
    return visibility === 'public' || currentBookIds.has(String(hierarchy.book.id))
  })

  return {
    entitled,
    reason: entitled ? 'book_access' : 'not_entitled',
    eligibleBookIds: eligibleBooks.map((hierarchy) => hierarchy.book.id),
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
  const purchase = resolveCouponPricing(resolvedPurchase, body?.coupon_code)
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
  const purchase = resolveCouponPricing(resolvedPurchase, body?.coupon_code)

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
  return Array.isArray(rows) ? rows[0] : rows
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
}
