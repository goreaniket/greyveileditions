import { createClient, type SupabaseClient, type User } from 'npm:@supabase/supabase-js@2'
import { corsHeaders, handleCors } from './cors.ts'

const INR = 'INR'
const VALID_PURCHASE_TYPES = new Set(['book', 'series', 'collection', 'pass'])
const ID_PATTERN = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|\d+)$/i

export class HttpError extends Error {
  status: number
  code: string
  constructor(status: number, message: string, code = 'request_failed') {
    super(message)
    this.status = status
    this.code = code
  }
}

export const json = (status: number, body: unknown, request: Request) => new Response(JSON.stringify(body), {
  status,
  headers: { ...corsHeaders(request), 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
})
export const errorResponse = (error: unknown, request: Request) => {
  const problem = error instanceof HttpError ? error : new HttpError(500, 'The payment service could not complete the request.')
  const message = problem.status >= 500 ? 'The payment service could not complete the request.' : problem.message
  return json(problem.status, { success: false, error: { code: problem.code, message } }, request)
}
export const requireEnv = (name: string) => {
  const value = Deno.env.get(name)?.trim()
  if (!value) throw new HttpError(500, `${name} is not configured.`, 'server_config_missing')
  return value
}
export const serviceClient = () => createClient(requireEnv('SUPABASE_URL'), requireEnv('SUPABASE_SERVICE_ROLE_KEY'), {
  auth: { persistSession: false, autoRefreshToken: false },
})
export const authenticate = async (request: Request, admin = serviceClient()): Promise<User> => {
  const authorization = request.headers.get('authorization') || ''
  if (!authorization.toLowerCase().startsWith('bearer ')) throw new HttpError(401, 'Please sign in to continue.', 'authentication_required')
  const { data, error } = await admin.auth.getUser(authorization.slice(7).trim())
  if (error || !data.user) throw new HttpError(401, 'Your session could not be verified.', 'authentication_required')
  return data.user
}

const text = (value: unknown, fallback = '') => String(value ?? '').trim() || fallback
const slug = (value: unknown) => text(value).toLowerCase().replace(/[_\s]+/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '')
const idsMatch = (left: unknown, right: unknown) => String(left ?? '') === String(right ?? '')
const active = (value: any) => value?.is_active !== false
const visibility = (value: any, fallback = 'public') => {
  const explicit = slug(value?.visibility || fallback)
  if (explicit === 'private') return 'private'
  if (value?.is_public === true || explicit === 'public') return 'public'
  return 'paid'
}
const one = async (admin: SupabaseClient, table: string, id: string) => {
  const { data, error } = await admin.from(table).select('*').eq('id', id).maybeSingle()
  if (error) throw new HttpError(500, 'Product data could not be read.', 'database_read_failed')
  return data
}

export type Purchase = {
  purchaseType: 'book' | 'series' | 'collection' | 'pass'
  bookId: string | null
  seriesId: string | null
  collectionId: string | null
  temporaryAccessPassId: string | null
  targetId: string
  itemName: string
  amount: number
  originalAmount: number
  couponId: string | null
  couponCode: string | null
  discountAmount: number
  currency: string
  hierarchy: { collection?: any; volume?: any; series?: any; book?: any }
}

const validateHierarchy = (hierarchy: Purchase['hierarchy']) => {
  const items = Object.values(hierarchy).filter(Boolean)
  if (!items.length || items.some((item: any) => !active(item) || visibility(item) === 'private')) {
    throw new HttpError(404, 'This purchase is not currently available.', 'purchase_unavailable')
  }
}

const configuredPrice = (item: any, label: string) => {
  const amount = Number(item?.price_amount)
  if (!Number.isInteger(amount) || amount <= 0) throw new HttpError(400, `This ${label} is not configured for checkout.`, 'price_not_configured')
  return amount
}

export const resolvePurchase = async (admin: SupabaseClient, body: Record<string, unknown>): Promise<Purchase> => {
  const normalizedType = slug(body.purchase_type)
  if (!VALID_PURCHASE_TYPES.has(normalizedType)) throw new HttpError(400, 'Choose a valid purchase type.', 'invalid_purchase_type')
  const purchaseType = normalizedType as Purchase['purchaseType']
  const targets = { book: text(body.book_id), series: text(body.series_id), collection: text(body.collection_id), pass: text(body.temporary_access_pass_id) }
  const provided = Object.entries(targets).filter(([, value]) => value)
  if (provided.length !== 1 || provided[0][0] !== purchaseType || !ID_PATTERN.test(provided[0][1])) {
    throw new HttpError(400, 'Send exactly one matching purchase target.', 'invalid_purchase_target')
  }
  if (purchaseType === 'book') {
    const book = await one(admin, 'books', targets.book)
    if (!book) throw new HttpError(404, 'This book is not available.', 'purchase_unavailable')
    const series = book.series_id ? await one(admin, 'series', String(book.series_id)) : null
    const volume = series?.volume_id ? await one(admin, 'volumes', String(series.volume_id)) : null
    const collectionId = series?.collection_id || volume?.collection_id
    const collection = collectionId ? await one(admin, 'collections', String(collectionId)) : null
    const hierarchy = { collection, volume, series, book }
    if (!collection || !volume || !series) throw new HttpError(404, 'This purchase is not currently available.', 'purchase_unavailable')
    validateHierarchy(hierarchy)
    if (visibility(book, 'paid') === 'public') throw new HttpError(409, 'This book is free to read and cannot be purchased.', 'public_book_not_purchasable')
    const amount = configuredPrice(book, 'book')
    return { purchaseType: 'book', bookId: String(book.id), seriesId: null, collectionId: null, temporaryAccessPassId: null, targetId: String(book.id), itemName: text(book.title, 'Greyveil Book'), amount, originalAmount: amount, couponId: null, couponCode: null, discountAmount: 0, currency: INR, hierarchy }
  }
  if (purchaseType === 'series') {
    const series = await one(admin, 'series', targets.series)
    if (!series) throw new HttpError(404, 'This series is not available.', 'purchase_unavailable')
    const volume = series.volume_id ? await one(admin, 'volumes', String(series.volume_id)) : null
    const collectionId = series.collection_id || volume?.collection_id
    const collection = collectionId ? await one(admin, 'collections', String(collectionId)) : null
    const hierarchy = { collection, volume, series }
    if (!collection || !volume) throw new HttpError(404, 'This purchase is not currently available.', 'purchase_unavailable')
    validateHierarchy(hierarchy)
    const amount = configuredPrice(series, 'series')
    return { purchaseType: 'series', bookId: null, seriesId: String(series.id), collectionId: null, temporaryAccessPassId: null, targetId: String(series.id), itemName: text(series.title, 'Greyveil Series'), amount, originalAmount: amount, couponId: null, couponCode: null, discountAmount: 0, currency: INR, hierarchy }
  }
  if (purchaseType === 'pass') {
    const pass = await one(admin, 'temporary_access_passes', targets.pass)
    if (!pass?.active) throw new HttpError(404, 'This access pass is not available.', 'purchase_unavailable')
    const collection = pass.scope_type === 'collection' ? await one(admin, 'collections', String(pass.collection_id)) : null
    if (pass.scope_type === 'collection') validateHierarchy({ collection })
    const amount = configuredPrice(pass, 'access pass')
    return { purchaseType: 'pass', bookId: null, seriesId: null, collectionId: null, temporaryAccessPassId: String(pass.id), targetId: String(pass.id), itemName: text(pass.title, 'Greyveil Access Pass'), amount, originalAmount: amount, couponId: null, couponCode: null, discountAmount: 0, currency: INR, hierarchy: { collection } }
  }
  const collection = await one(admin, 'collections', targets.collection)
  if (!collection) throw new HttpError(404, 'This collection is not available.', 'purchase_unavailable')
  validateHierarchy({ collection })
  const amount = configuredPrice(collection, 'collection')
  return { purchaseType: 'collection', bookId: null, seriesId: null, collectionId: String(collection.id), temporaryAccessPassId: null, targetId: String(collection.id), itemName: text(collection.title, 'Greyveil Collection'), amount, originalAmount: amount, couponId: null, couponCode: null, discountAmount: 0, currency: INR, hierarchy: { collection } }
}

const currentGrant = (grant: any) => grant?.is_visible === true && grant?.can_read === true && (!grant?.expires_at || Date.parse(grant.expires_at) > Date.now())
export const assertNotEntitled = async (admin: SupabaseClient, user: User, purchase: Purchase) => {
  const { data: profile, error: profileError } = await admin.from('profiles').select('role').eq('id', user.id).maybeSingle()
  if (profileError) throw new HttpError(500, 'Entitlement data could not be checked.', 'database_read_failed')
  if (['admin', 'super_admin'].includes(profile?.role)) throw new HttpError(409, 'This item is already in your library.', 'already_entitled')
  if (purchase.purchaseType === 'pass') {
    const { data: activations, error: activationError } = await admin.from('temporary_access_pass_activations').select('expires_at').eq('user_id', user.id).eq('pass_id', purchase.temporaryAccessPassId)
    if (activationError) throw new HttpError(500, 'Entitlement data could not be checked.', 'database_read_failed')
    if ((activations || []).some((activation) => Date.parse(activation.expires_at) > Date.now())) throw new HttpError(409, 'This access pass is already active.', 'already_entitled')
    return
  }
  const { data: orders, error } = await admin.from('orders').select('purchase_type, book_id, series_id, collection_id, status').eq('user_id', user.id).eq('status', 'paid')
  if (error) throw new HttpError(500, 'Entitlement data could not be checked.', 'database_read_failed')
  const paid = orders || []
  const collectionId = purchase.hierarchy.collection?.id
  if (purchase.purchaseType === 'collection') {
    if (paid.some((order) => order.purchase_type === 'collection' && idsMatch(order.collection_id, purchase.collectionId))) throw new HttpError(409, 'This item is already in your library.', 'already_entitled')
    return
  }
  if (purchase.purchaseType === 'series') {
    if (paid.some((order) => (order.purchase_type === 'series' && idsMatch(order.series_id, purchase.seriesId)) || (order.purchase_type === 'collection' && idsMatch(order.collection_id, collectionId)))) throw new HttpError(409, 'This item is already in your library.', 'already_entitled')
    const [{ data: books, error: booksError }, { data: grants, error: grantsError }] = await Promise.all([
      admin.from('books').select('id, visibility, is_public, is_active').eq('series_id', purchase.seriesId),
      admin.from('book_access').select('book_id, expires_at, is_visible, can_read').eq('user_id', user.id),
    ])
    if (booksError || grantsError) throw new HttpError(500, 'Entitlement data could not be checked.', 'database_read_failed')
    const eligible = (books || []).filter((book) => active(book) && visibility(book, 'paid') !== 'private')
    const grantIds = new Set((grants || []).filter(currentGrant).map((grant) => String(grant.book_id)))
    if (eligible.length && eligible.every((book) => grantIds.has(String(book.id)))) throw new HttpError(409, 'This item is already in your library.', 'already_entitled')
    return
  }
  if (paid.some((order) => (order.purchase_type === 'book' && idsMatch(order.book_id, purchase.bookId)) || (order.purchase_type === 'series' && idsMatch(order.series_id, purchase.hierarchy.series?.id)) || (order.purchase_type === 'collection' && idsMatch(order.collection_id, collectionId)))) throw new HttpError(409, 'This item is already in your library.', 'already_entitled')
  const { data: grants, error: grantsError } = await admin.from('book_access').select('book_id, expires_at, is_visible, can_read').eq('user_id', user.id).eq('book_id', purchase.bookId)
  if (grantsError) throw new HttpError(500, 'Entitlement data could not be checked.', 'database_read_failed')
  if ((grants || []).some(currentGrant)) throw new HttpError(409, 'This item is already in your library.', 'already_entitled')
}

export const applyCoupon = async (admin: SupabaseClient, purchase: Purchase, couponInput: unknown, userId: string) => {
  const code = text(couponInput).toUpperCase()
  if (!code) return purchase
  const { data: coupon, error: couponError } = await admin.from('coupons').select('*').eq('code', code).maybeSingle()
  if (couponError) throw new HttpError(500, 'Coupon data could not be checked.', 'database_read_failed')
  const now = Date.now()
  if (!coupon?.active || !coupon.applicable_purchase_types?.includes(purchase.purchaseType) || (coupon.valid_from && Date.parse(coupon.valid_from) > now) || (coupon.valid_until && Date.parse(coupon.valid_until) <= now)) return purchase
  if (coupon.applies_to_all_products === false) {
    const { data: rules, error: rulesError } = await admin.from('coupon_products').select('purchase_type, target_id').eq('coupon_id', coupon.id)
    if (rulesError) throw new HttpError(500, 'Coupon data could not be checked.', 'database_read_failed')
    if (!(rules || []).some((rule) => rule.purchase_type === purchase.purchaseType && idsMatch(rule.target_id, purchase.targetId))) return purchase
  }
  const { data: usages, error: usageError } = await admin.from('coupon_usages').select('user_id, status, created_at').eq('coupon_id', coupon.id).in('status', ['pending', 'redeemed'])
  if (usageError) throw new HttpError(500, 'Coupon data could not be checked.', 'database_read_failed')
  const counted = (usages || []).filter((usage) => usage.status === 'redeemed' || (usage.status === 'pending' && Date.parse(usage.created_at) > now - 30 * 60 * 1000))
  if ((coupon.maximum_total_uses && counted.length >= coupon.maximum_total_uses) || (coupon.maximum_uses_per_user && counted.filter((usage) => usage.user_id === userId).length >= coupon.maximum_uses_per_user)) return purchase
  let amount = purchase.amount
  if (coupon.discount_type === 'fixed_final_price') amount = Number(coupon.fixed_final_price)
  if (coupon.discount_type === 'fixed_amount') amount -= Number(coupon.discount_value || 0)
  if (coupon.discount_type === 'percentage') amount = Math.round(amount * (100 - Number(coupon.discount_value || 0)) / 100)
  amount = Math.max(100, Math.min(purchase.amount, amount))
  return { ...purchase, amount, couponId: coupon.id, couponCode: coupon.code, discountAmount: purchase.amount - amount }
}

export const razorpay = async (path: string, options: RequestInit = {}) => {
  const credentials = btoa(`${requireEnv('RAZORPAY_KEY_ID')}:${requireEnv('RAZORPAY_KEY_SECRET')}`)
  const response = await fetch(`https://api.razorpay.com/v1${path}`, { ...options, headers: { Authorization: `Basic ${credentials}`, 'Content-Type': 'application/json', ...(options.headers || {}) } })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new HttpError(response.status, payload?.error?.description || 'Razorpay request failed.', 'razorpay_request_failed')
  return payload
}
const bytesToHex = (bytes: Uint8Array) => [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
const hmac = async (secret: string, value: string) => {
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return bytesToHex(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(value))))
}
const constantTimeEqual = (left: string, right: string) => {
  if (left.length !== right.length) return false
  let difference = 0
  for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index)
  return difference === 0
}
export const verifyHmac = async (secret: string, message: string, signature: string) => constantTimeEqual(await hmac(secret, message), text(signature).toLowerCase())
export const paymentCaptured = (payment: any) => payment?.status === 'captured' && payment?.captured === true
export const paymentMatches = (payment: any, order: any) => text(payment?.order_id) === text(order?.razorpay_order_id) && Number(payment?.amount) === Number(order?.amount) && text(payment?.currency).toUpperCase() === text(order?.currency).toUpperCase()

export const persistPayment = async (admin: SupabaseClient, order: any, payment: any, options: { signature?: string; eventId?: string; verified?: boolean } = {}) => {
  if (!payment?.id) throw new HttpError(400, 'Payment id is missing.', 'invalid_payment')
  const now = new Date().toISOString()
  const payload: Record<string, unknown> = {
    order_id: order?.id || null, user_id: order?.user_id || null, razorpay_payment_id: payment.id,
    razorpay_order_id: payment.order_id || order?.razorpay_order_id, original_amount: Number(order?.original_amount ?? order?.amount),
    amount: Number(payment.amount ?? order?.amount), coupon_code: order?.coupon_code || null, coupon_id: order?.coupon_id || null,
    discount_amount: Number(order?.discount_amount || 0), currency: text(payment.currency, order?.currency || INR).toUpperCase(),
    status: text(payment.status, 'unknown'), method: payment.method || null, captured: paymentCaptured(payment), raw_payload: payment,
    razorpay_created_at: payment.created_at ? new Date(Number(payment.created_at) * 1000).toISOString() : null,
    updated_at: now,
  }
  if (options.verified && paymentCaptured(payment)) payload.verified_at = now
  if (options.signature) payload.razorpay_signature = options.signature
  if (options.eventId) payload.webhook_event_id = options.eventId
  const { data, error } = await admin.from('payments').upsert(payload, { onConflict: 'razorpay_payment_id' }).select().single()
  if (error) throw new HttpError(500, 'Payment could not be persisted.', 'payment_persist_failed')
  return data
}
export const markOrder = async (admin: SupabaseClient, order: any, status: string, extra: Record<string, unknown> = {}) => {
  const now = new Date().toISOString()
  const { data, error } = await admin.from('orders').update({ status, updated_at: now, ...extra }).eq('id', order.id).select().single()
  if (error) throw new HttpError(500, 'Order status could not be persisted.', 'order_update_failed')
  if (order.coupon_id) {
    const usageStatus = status === 'paid' ? 'redeemed' : status === 'refunded' ? 'refunded' : ['failed', 'cancelled'].includes(status) ? 'void' : null
    if (usageStatus) await admin.from('coupon_usages').update({ status: usageStatus, redeemed_at: usageStatus === 'redeemed' ? now : null, updated_at: now }).eq('order_id', order.id)
  }
  return data
}
export const parseBody = async (request: Request) => {
  try { return await request.json() as Record<string, unknown> } catch { throw new HttpError(400, 'Request body must be valid JSON.', 'invalid_json') }
}
export const handleOptions = handleCors
