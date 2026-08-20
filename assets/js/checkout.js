import { supabase } from './supabase-client.js'
import {
  apiPost,
  checkoutSelectionFromSearch,
  edgeFunctionPost,
  formatCurrency,
  getText,
  loadRazorpayCheckout,
} from './commerce.js?v=20260819-commerce-stabilization'
import {
  canReadBook,
  getEntitlementSnapshot,
  hierarchyForBook,
} from './content-access.js?v=20260819-commerce-stabilization'

const GREYVEIL_ORIGIN = 'https://greyveileditions.site'
const ACCOUNT_PATH = '/account/'
const CONTENT_PATH_PATTERN = /^\/projects\/([a-z0-9]+(?:-[a-z0-9]+)*)\/books\/([a-z0-9]+(?:-[a-z0-9]+)*)(?:\.html|\/reader\/?)?\/?$/
const USEFUL_RETURN_PATTERN = /^\/(?:account\/?|projects\/[a-z0-9]+(?:-[a-z0-9]+)*(?:\/.*)?)$/

const node = (selector) => document.querySelector(selector)
const setStatus = (target, message = '', type = '') => {
  if (!target) return
  target.textContent = message
  target.dataset.status = type
}
const setBusy = (button, busy, label = 'Working...') => {
  if (!button) return
  if (!button.dataset.defaultLabel) button.dataset.defaultLabel = button.textContent
  button.disabled = busy
  button.textContent = busy ? label : button.dataset.defaultLabel
}
const displayNameFor = (user, profile) => profile?.display_name
  || user?.user_metadata?.display_name
  || user?.email?.split('@')[0]
  || 'Reader'
const idsMatch = (left, right) => String(left ?? '') === String(right ?? '')

export const safeCheckoutReturnPath = (value) => {
  const candidate = getText(value)
  if (!candidate.startsWith('/') || candidate.startsWith('//') || candidate.includes('\\')) return ''
  try {
    const resolved = new URL(candidate, GREYVEIL_ORIGIN)
    if (resolved.origin !== GREYVEIL_ORIGIN) return ''
    return `${resolved.pathname}${resolved.search}${resolved.hash}`
  } catch (_error) {
    return ''
  }
}

const contentTargetFromPath = (value) => {
  const safePath = safeCheckoutReturnPath(value)
  if (!safePath) return null
  const url = new URL(safePath, GREYVEIL_ORIGIN)
  const match = url.pathname.match(CONTENT_PATH_PATTERN)
  return match ? { seriesSlug: match[1], bookSlug: match[2] } : null
}

const readerPathForBook = (book, hierarchy = {}) => {
  if (!book) return ''
  const item = hierarchyForBook(book, hierarchy.seriesItems || [], hierarchy.collections || [], hierarchy.volumes || [])
  const seriesSlug = getText(item.series?.slug).toLowerCase()
  const bookSlug = getText(book.slug).toLowerCase()
  if (!seriesSlug || !bookSlug || !CONTENT_PATH_PATTERN.test(`/projects/${seriesSlug}/books/${bookSlug}/`)) return ''
  return `/projects/${seriesSlug}/books/${bookSlug}/reader/`
}

const readableReturnTarget = (returnPath, snapshot) => {
  const target = contentTargetFromPath(returnPath)
  if (!target || !snapshot?.hierarchy) return ''
  const hierarchy = snapshot.hierarchy
  const book = (hierarchy.books || []).find((item) => getText(item.slug).toLowerCase() === target.bookSlug)
  const item = hierarchyForBook(book, hierarchy.seriesItems || [], hierarchy.collections || [], hierarchy.volumes || [])
  if (getText(item.series?.slug).toLowerCase() !== target.seriesSlug) return ''
  const readable = canReadBook({
    ...item,
    grants: snapshot.grants || [],
    paidOrders: snapshot.paidOrders || [],
    accessPasses: snapshot.accessPasses || [],
    passActivations: snapshot.passActivations || [],
  }, snapshot.context || {})
  return readable ? readerPathForBook(book, hierarchy) : ''
}

export const resolveCheckoutSuccessDestination = ({ selection, snapshot } = {}) => {
  const purchaseType = getText(selection?.purchaseType).toLowerCase()
  const safeReturn = safeCheckoutReturnPath(selection?.returnPath)
  const returnTarget = contentTargetFromPath(safeReturn)
  const returnedReader = readableReturnTarget(safeReturn, snapshot)
  if (returnedReader) return returnedReader

  if (purchaseType === 'book' && snapshot?.hierarchy) {
    const book = (snapshot.hierarchy.books || []).find((item) => idsMatch(item.id, selection.targetId))
    const purchasedReader = readerPathForBook(book, snapshot.hierarchy)
    if (purchasedReader) return purchasedReader
  }

  if (safeReturn && USEFUL_RETURN_PATTERN.test(new URL(safeReturn, GREYVEIL_ORIGIN).pathname)) {
    const pathname = new URL(safeReturn, GREYVEIL_ORIGIN).pathname
    if (returnTarget && /\/reader\/?$/.test(pathname)) return ACCOUNT_PATH
    return safeReturn
  }
  return ACCOUNT_PATH
}

export const checkoutResultState = (verification) => {
  if (verification?.paid) return { state: 'success', redirect: true }
  if (verification?.dismissed) return { state: 'closed', redirect: false }
  if (verification?.failed) return { state: 'payment_failed', redirect: false }
  return { state: 'failure', redirect: false }
}

export const scheduleCheckoutRedirect = ({ destination, onFailure = () => {}, schedule = window.setTimeout, location = window.location } = {}) => {
  return schedule(() => {
    try {
      location.assign(destination || ACCOUNT_PATH)
    } catch (error) {
      onFailure(error)
    }
  }, 500)
}

const includedContent = (selection, snapshot) => {
  try {
    const hierarchy = snapshot.hierarchy
    if (selection.purchaseType === 'book') {
      const book = hierarchy.books.find((item) => idsMatch(item.id, selection.targetId))
      const item = hierarchyForBook(book, hierarchy.seriesItems, hierarchy.collections, hierarchy.volumes)
      return item.series?.title ? `Includes this book from ${item.series.title}.` : 'Includes this Greyveil book.'
    }
    if (selection.purchaseType === 'series') {
      const books = hierarchy.books.filter((item) => idsMatch(item.series_id, selection.targetId) && item.is_active !== false)
      return `Includes ${books.length} currently available ${books.length === 1 ? 'book' : 'books'} in this series.`
    }
    if (selection.purchaseType === 'pass') {
      const pass = (snapshot.accessPasses || []).find((item) => idsMatch(item.id, selection.targetId))
      const duration = Number(pass?.duration_hours)
      return Number.isInteger(duration) && duration > 0
        ? `Includes ${duration}-hour access to eligible Greyveil books.`
        : 'Includes temporary access to eligible Greyveil books.'
    }
    const seriesIds = new Set(hierarchy.seriesItems.filter((series) => {
      const volume = hierarchy.volumes.find((item) => idsMatch(item.id, series.volume_id))
      return idsMatch(series.collection_id || volume?.collection_id, selection.targetId)
    }).map((series) => String(series.id)))
    const books = hierarchy.books.filter((book) => seriesIds.has(String(book.series_id)) && book.is_active !== false)
    return `Includes ${seriesIds.size} series and ${books.length} currently available books.`
  } catch (_error) {
    return selection.purchaseType === 'book'
      ? 'Includes this Greyveil book.'
      : `Includes the complete eligible ${selection.purchaseType}.`
  }
}

export const openRazorpay = async ({ user, profile, order, itemName, onVerifying = () => {} }) => {
  const Razorpay = await loadRazorpayCheckout()
  return new Promise((resolve, reject) => {
    const checkout = new Razorpay({
      key: order.key_id,
      amount: order.amount,
      currency: order.currency,
      name: 'Greyveil Editions',
      description: itemName,
      order_id: order.order_id,
      prefill: {
        name: displayNameFor(user, profile),
        email: user.email || '',
      },
      notes: { local_order_id: order.local_order_id },
      theme: { color: '#2a3440' },
      modal: { ondismiss: () => resolve({ dismissed: true }) },
      handler: async (response) => {
        try {
          onVerifying()
          resolve(await edgeFunctionPost('verify-payment', {
            local_order_id: order.local_order_id,
            razorpay_payment_id: response.razorpay_payment_id,
            razorpay_order_id: response.razorpay_order_id,
            razorpay_signature: response.razorpay_signature,
          }))
        } catch (error) {
          reject(error)
        }
      },
    })
    checkout.on('payment.failed', (response) => {
      resolve({ failed: true, message: response?.error?.description || 'Payment failed. Please try again.' })
    })
    checkout.open()
  })
}

const initCheckout = async () => {
  const selection = checkoutSelectionFromSearch()
  const loading = node('[data-checkout-loading]')
  const shell = node('[data-checkout-shell]')
  const errorView = node('[data-checkout-error]')
  const payButton = node('[data-checkout-pay]')
  const checkoutStatus = node('[data-checkout-status]')
  const couponForm = node('[data-checkout-coupon-form]')
  const couponStatus = node('[data-checkout-coupon-status]')
  const couponRemove = node('[data-checkout-coupon-remove]')
  let basePricing = null
  let currentPricing = null
  let appliedCoupon = null
  let initialSnapshot = null
  let paymentInFlight = false

  const showError = (title, message) => {
    loading.hidden = true
    shell.hidden = true
    errorView.hidden = false
    node('[data-checkout-error-title]').textContent = title
    node('[data-checkout-error-message]').textContent = message
  }
  if (!selection) return showError('This checkout link is invalid.', 'Choose a product from the Greyveil catalogue and try again.')
  document.querySelectorAll('[data-checkout-return]').forEach((link) => { link.href = selection.returnPath })

  const { data: userResult } = await supabase.auth.getUser()
  const user = userResult?.user || null
  if (!user) {
    const next = `${window.location.pathname}${window.location.search}`
    window.location.replace(`/auth/login/?next=${encodeURIComponent(next)}`)
    return
  }
  const { data: profile } = await supabase.from('profiles').select('id, display_name, role').eq('id', user.id).maybeSingle()

  const renderPricing = () => {
    const discounted = Boolean(appliedCoupon && Number(currentPricing?.discount_amount) > 0)
    node('[data-checkout-original-price]').textContent = formatCurrency(basePricing.original_amount, basePricing.currency)
    node('[data-checkout-total]').textContent = formatCurrency(currentPricing.final_amount, currentPricing.currency)
    const original = node('[data-checkout-total-original]')
    original.hidden = !discounted
    original.textContent = discounted ? formatCurrency(basePricing.original_amount, basePricing.currency) : ''
  }
  const resetCoupon = () => {
    appliedCoupon = null
    currentPricing = { ...basePricing, valid: false, coupon_code: null, final_amount: basePricing.original_amount, discount_amount: 0 }
    couponRemove.hidden = true
    renderPricing()
  }

  try {
    const result = await apiPost('/api/validate-coupon', selection.payload)
    basePricing = result.pricing
    currentPricing = result.pricing
    node('[data-checkout-product]').textContent = getText(basePricing.item_name, 'Greyveil purchase')
    node('[data-checkout-product-type]').textContent = selection.purchaseType.charAt(0).toUpperCase() + selection.purchaseType.slice(1)
    try {
      initialSnapshot = await getEntitlementSnapshot()
    } catch (_error) {
      initialSnapshot = null
    }
    node('[data-checkout-includes]').textContent = includedContent(selection, initialSnapshot)
    node('[data-checkout-customer-name]').textContent = displayNameFor(user, profile)
    node('[data-checkout-customer-email]').textContent = user.email || ''
    renderPricing()
    loading.hidden = true
    shell.hidden = false
  } catch (error) {
    if (error?.code === 'already_entitled') {
      return showError('Access already granted.', 'This product is already available to your account.')
    }
    return showError('We could not prepare this order.', error?.message || 'Please return to the product and try again.')
  }

  couponForm.addEventListener('submit', async (event) => {
    event.preventDefault()
    const input = couponForm.elements.coupon_code
    const code = getText(input.value)
    if (!code) {
      resetCoupon()
      setStatus(couponStatus, 'Coupon is optional. The regular price still applies.', 'info')
      return
    }
    setBusy(couponForm.querySelector('button[type="submit"]'), true, 'Applying...')
    payButton.disabled = true
    try {
      const { pricing } = await apiPost('/api/validate-coupon', { ...selection.payload, coupon_code: code })
      if (!pricing.valid) {
        resetCoupon()
        setStatus(couponStatus, 'Invalid coupon code. You can continue at the regular price.', 'error')
        return
      }
      currentPricing = pricing
      appliedCoupon = pricing.coupon_code
      input.value = appliedCoupon
      couponRemove.hidden = false
      renderPricing()
      setStatus(couponStatus, `${appliedCoupon} applied.`, 'success')
    } catch (error) {
      resetCoupon()
      setStatus(couponStatus, error?.message || 'The coupon could not be checked.', 'error')
    } finally {
      setBusy(couponForm.querySelector('button[type="submit"]'), false)
      payButton.disabled = false
    }
  })
  couponForm.elements.coupon_code.addEventListener('input', () => {
    if (!appliedCoupon) return
    resetCoupon()
    setStatus(couponStatus, 'Apply the updated code to preview its price.', 'info')
  })
  couponRemove.addEventListener('click', () => {
    couponForm.elements.coupon_code.value = ''
    resetCoupon()
    setStatus(couponStatus, 'Coupon removed.', 'info')
  })

  payButton.addEventListener('click', async () => {
    if (paymentInFlight) return
    paymentInFlight = true
    let verifiedSuccess = false
    let verificationStarted = false
    setBusy(payButton, true, 'Preparing payment…')
    setStatus(checkoutStatus)
    try {
      const { order } = await edgeFunctionPost('create-order', {
        ...selection.payload,
        ...(appliedCoupon ? { coupon_code: appliedCoupon } : {}),
      })
      const verification = await openRazorpay({
        user,
        profile,
        order,
        itemName: basePricing.item_name,
        onVerifying: () => {
          verificationStarted = true
          setBusy(payButton, true, 'Confirming payment…')
        },
      })
      const outcome = checkoutResultState(verification)
      if (outcome.state === 'closed') {
        setStatus(checkoutStatus, 'Payment was not completed.', 'info')
        return
      }
      if (outcome.state === 'failure') {
        setStatus(checkoutStatus, "We couldn't confirm this payment yet.", 'error')
        return
      }
      if (outcome.state === 'payment_failed') {
        setStatus(checkoutStatus, 'Payment was not completed. Please try again.', 'error')
        return
      }
      verifiedSuccess = true
      payButton.disabled = true
      payButton.textContent = 'Payment successful'
      document.querySelectorAll('[data-checkout-return]').forEach((link) => { link.hidden = true })
      setStatus(checkoutStatus, 'Payment successful. Preparing your next page…', 'success')
      let refreshedSnapshot = null
      try {
        refreshedSnapshot = await getEntitlementSnapshot({ force: true })
      } catch (_error) {
        refreshedSnapshot = initialSnapshot
      }
      window.dispatchEvent(new CustomEvent('greyveil:purchase-complete', { detail: verification }))
      const destination = resolveCheckoutSuccessDestination({ selection, snapshot: refreshedSnapshot })
      const continueLink = node('[data-checkout-continue]')
      continueLink.href = destination
      scheduleCheckoutRedirect({
        destination,
        onFailure: () => {
          continueLink.hidden = false
          setStatus(checkoutStatus, 'Payment successful. Continue when ready.', 'success')
        },
      })
    } catch (error) {
      if (error?.code === 'already_entitled') return showError('Access already granted.', 'This product is already available to your account.')
      setStatus(checkoutStatus, verificationStarted
        ? "We couldn't confirm this payment yet."
        : "We couldn't prepare this payment. Please try again.", 'error')
    } finally {
      if (!verifiedSuccess) {
        paymentInFlight = false
        setBusy(payButton, false)
      }
    }
  })
}

initCheckout()
