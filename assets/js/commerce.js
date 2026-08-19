import { supabase } from './supabase-client.js'

export const VALID_PURCHASE_TYPES = new Set(['book', 'series', 'collection', 'pass'])
const CHECKOUT_SCRIPT_URL = 'https://checkout.razorpay.com/v1/checkout.js'
const ID_PATTERN = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|\d+)$/i
let checkoutScriptPromise = null
const recordIdPromises = new Map()

export const getText = (value, fallback = '') => String(value ?? '').trim() || fallback
export const normalizePurchaseType = (value) => getText(value).toLowerCase()
const targetFieldFor = (type) => type === 'pass' ? 'temporary_access_pass_id' : `${type}_id`

export const safeInternalPath = (value, fallback = '/') => {
  const path = getText(value)
  return path.startsWith('/') && !path.startsWith('//') ? path : fallback
}

export const sessionToken = async () => {
  const { data, error } = await supabase.auth.getSession()
  if (error || !data?.session?.access_token) return ''
  return data.session.access_token
}

export const apiPost = async (path, payload) => {
  const token = await sessionToken()
  if (!token) {
    const error = new Error('Please log in before starting checkout.')
    error.code = 'login_required'
    throw error
  }
  const response = await fetch(path, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  })
  const result = await response.json().catch(() => ({}))
  if (!response.ok) {
    const error = new Error(result?.error?.message || 'The payment request could not be completed.')
    error.code = result?.error?.code || 'request_failed'
    throw error
  }
  return result
}

export const edgeFunctionPost = async (name, payload) => {
  const token = await sessionToken()
  if (!token) {
    const error = new Error('Please log in before starting checkout.')
    error.code = 'login_required'
    throw error
  }

  const { data, error: invokeError } = await supabase.functions.invoke(name, {
    body: payload,
    headers: { Authorization: `Bearer ${token}` },
  })

  if (invokeError) {
    let result = null
    try {
      result = await invokeError.context?.clone?.().json()
    } catch (_error) {
      result = null
    }
    const error = new Error(result?.error?.message || 'The payment request could not be completed.')
    error.code = result?.error?.code || 'request_failed'
    throw error
  }

  if (data?.success === false && data?.error) {
    const error = new Error(data.error.message || 'The payment request could not be completed.')
    error.code = data.error.code || 'request_failed'
    throw error
  }
  return data
}

export const formatCurrency = (amount, currency = 'INR') => {
  const paise = Number(amount)
  if (!Number.isFinite(paise)) return '-'
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: getText(currency, 'INR').toUpperCase(),
    maximumFractionDigits: 2,
  }).format(paise / 100)
}

export const resolveRecordId = async (type, slug) => {
  const purchaseType = normalizePurchaseType(type)
  const cleanSlug = getText(slug).toLowerCase()
  if (!VALID_PURCHASE_TYPES.has(purchaseType) || !cleanSlug) return ''
  const cacheKey = `${purchaseType}:${cleanSlug}`
  if (recordIdPromises.has(cacheKey)) return recordIdPromises.get(cacheKey)
  const table = { book: 'books', series: 'series', collection: 'collections', pass: 'temporary_access_passes' }[purchaseType]
  const request = (async () => {
    const { data, error } = await supabase.from(table).select('id, slug, title').eq('slug', cleanSlug).maybeSingle()
    if (error || !data?.id) throw new Error('This purchase option is not available right now.')
    return String(data.id)
  })()
  recordIdPromises.set(cacheKey, request)
  request.catch(() => recordIdPromises.delete(cacheKey))
  return request
}

export const purchasePayloadForElement = async (element) => {
  const purchaseType = normalizePurchaseType(element?.dataset?.purchaseType)
  if (!VALID_PURCHASE_TYPES.has(purchaseType)) throw new Error('This purchase option is not configured.')
  const idDatasetName = `purchase${purchaseType.charAt(0).toUpperCase()}${purchaseType.slice(1)}Id`
  const targetId = getText(element.dataset[idDatasetName])
    || await resolveRecordId(purchaseType, element.dataset.purchaseSlug)
  if (!ID_PATTERN.test(targetId)) throw new Error('This purchase option is not available right now.')
  return { purchase_type: purchaseType, [targetFieldFor(purchaseType)]: targetId }
}

export const purchaseTargetForPayload = (payload) => {
  const purchaseType = normalizePurchaseType(payload?.purchase_type)
  return { purchaseType, targetId: getText(payload?.[targetFieldFor(purchaseType)]) }
}

export const checkoutUrlForPayload = (payload, returnPath = '/') => {
  const { purchaseType, targetId } = purchaseTargetForPayload(payload)
  if (!VALID_PURCHASE_TYPES.has(purchaseType) || !ID_PATTERN.test(targetId)) return ''
  const params = new URLSearchParams({
    type: purchaseType,
    id: targetId,
    return: safeInternalPath(returnPath),
  })
  return `/checkout/?${params.toString()}`
}

export const checkoutSelectionFromSearch = (search = window.location.search) => {
  const params = new URLSearchParams(search)
  const purchaseType = normalizePurchaseType(params.get('type'))
  const targetId = getText(params.get('id'))
  if (!VALID_PURCHASE_TYPES.has(purchaseType) || !ID_PATTERN.test(targetId)) return null
  return {
    purchaseType,
    targetId,
    returnPath: safeInternalPath(params.get('return'), '/projects/'),
    payload: { purchase_type: purchaseType, [targetFieldFor(purchaseType)]: targetId },
  }
}

export const loadRazorpayCheckout = () => {
  if (window.Razorpay) return Promise.resolve(window.Razorpay)
  if (checkoutScriptPromise) return checkoutScriptPromise
  checkoutScriptPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = CHECKOUT_SCRIPT_URL
    script.async = true
    script.onload = () => resolve(window.Razorpay)
    script.onerror = () => reject(new Error('Razorpay Checkout could not be loaded.'))
    document.head.append(script)
  })
  return checkoutScriptPromise
}
