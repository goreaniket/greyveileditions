import { supabase } from './supabase-client.js'
import { getCurrentProfile, getCurrentUser } from './auth.js'
import {
  fetchContentHierarchy,
  fetchViewerBookGrants,
  hasEffectivePurchaseEntitlement,
  isAdminRole,
} from './content-access.js'

const CHECKOUT_SCRIPT_URL = 'https://checkout.razorpay.com/v1/checkout.js'
const PRICE_LABELS = {
  book: 'Rs. 149',
  series: {
    'human-mind': 'Rs. 599',
    'human-paradox': 'Rs. 599',
    'human-fiction': 'Rs. 499',
  },
  collection: {
    'human-paradox-collection': 'Rs. 1,299',
    'the-human-paradox-collection': 'Rs. 1,299',
  },
}

let checkoutScriptPromise = null
let initialized = false
let entitlementRefreshRun = 0
const recordIdPromises = new Map()

const getText = (value, fallback = '') => {
  const text = value == null ? '' : String(value).trim()
  return text || fallback
}

const normalizeSlug = (value) => getText(value).toLowerCase()

const setButtonBusy = (button, busy, label = 'Working...') => {
  if (!button) return
  if (!button.dataset.purchaseDefaultLabel) button.dataset.purchaseDefaultLabel = button.textContent
  if (busy) {
    button.disabled = true
    button.textContent = label
    return
  }

  if (button.dataset.purchaseAccessState === 'entitled') {
    button.disabled = true
    button.textContent = 'Access granted'
    return
  }

  button.disabled = button.dataset.purchaseAccessState === 'checking'
  button.textContent = button.dataset.purchaseDefaultLabel
}

const purchaseStatusFor = (button) => {
  const explicit = button.getAttribute('aria-describedby')
    ? document.getElementById(button.getAttribute('aria-describedby'))
    : null
  if (explicit?.dataset.purchaseStatus !== undefined) return explicit

  const sibling = button.parentElement?.querySelector('[data-purchase-status]')
  if (sibling) return sibling

  const status = document.createElement('span')
  status.className = 'purchase-status'
  status.dataset.purchaseStatus = ''
  status.setAttribute('role', 'status')
  status.setAttribute('aria-live', 'polite')
  button.insertAdjacentElement('afterend', status)
  return status
}

const setPurchaseStatus = (button, message = '', type = '') => {
  const status = purchaseStatusFor(button)
  if (!status) return
  status.textContent = message
  status.dataset.status = type
}

const loadCheckoutScript = () => {
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

const sessionToken = async () => {
  const { data, error } = await supabase.auth.getSession()
  if (error || !data?.session?.access_token) return ''
  return data.session.access_token
}

const apiPost = async (path, payload) => {
  const token = await sessionToken()
  if (!token) throw new Error('Please log in before starting checkout.')

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

const formatCurrency = (amount, currency = 'INR') => {
  const paise = Number(amount)
  if (!Number.isFinite(paise)) return '-'

  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: getText(currency, 'INR').toUpperCase(),
    maximumFractionDigits: 2,
  }).format(paise / 100)
}

const resolveRecordId = async (type, slug) => {
  const cleanSlug = normalizeSlug(slug)
  if (!cleanSlug) return ''

  const cacheKey = `${type}:${cleanSlug}`
  if (recordIdPromises.has(cacheKey)) return recordIdPromises.get(cacheKey)

  const request = (async () => {
    const table = {
      book: 'books',
      series: 'series',
      collection: 'collections',
    }[type]
    if (!table) return ''
    const { data, error } = await supabase
      .from(table)
      .select('id, slug, title')
      .eq('slug', cleanSlug)
      .maybeSingle()

    if (error || !data?.id) {
      throw new Error('This purchase option is not available right now.')
    }

    return data.id
  })()

  recordIdPromises.set(cacheKey, request)
  request.catch(() => recordIdPromises.delete(cacheKey))
  return request
}

const purchasePayloadForButton = async (button) => {
  const type = normalizeSlug(button.dataset.purchaseType)
  if (!['book', 'series', 'collection'].includes(type)) {
    throw new Error('This purchase option is not configured.')
  }

  const idDatasetName = `purchase${type.charAt(0).toUpperCase()}${type.slice(1)}Id`
  const id = getText(button.dataset[idDatasetName]) || await resolveRecordId(type, button.dataset.purchaseSlug)
  if (!id) throw new Error('This purchase option is not available right now.')

  return {
    purchase_type: type,
    [`${type}_id`]: id,
  }
}

const displayNameFor = (user, profile) => {
  return profile?.display_name
    || user?.user_metadata?.display_name
    || user?.email?.split('@')[0]
    || 'Reader'
}

const purchaseTargetForPayload = (payload) => {
  const purchaseType = normalizeSlug(payload?.purchase_type)
  return {
    purchaseType,
    targetId: payload?.[`${purchaseType}_id`],
  }
}

const setPurchaseAccessState = (button, state) => {
  if (!button) return
  if (!button.dataset.purchaseDefaultLabel) button.dataset.purchaseDefaultLabel = button.textContent
  button.classList.add('purchase-button')
  button.classList.toggle('purchase-button--entitled', state === 'entitled')
  button.dataset.purchaseAccessState = state

  if (state === 'checking') {
    button.disabled = true
    button.textContent = 'Checking access...'
    button.setAttribute('aria-busy', 'true')
    return
  }

  button.removeAttribute('aria-busy')
  if (state === 'entitled') {
    button.disabled = true
    button.textContent = 'Access granted'
    button.setAttribute('aria-label', 'Access granted. Already in your library.')
    button.title = 'Already in your library'
    return
  }

  button.removeAttribute('aria-label')
  button.removeAttribute('title')
  button.textContent = state === 'unavailable'
    ? 'Purchase unavailable'
    : button.dataset.purchaseDefaultLabel
  button.disabled = state === 'unavailable'
}

const refreshPurchaseEntitlements = async () => {
  const runId = ++entitlementRefreshRun
  const buttons = Array.from(document.querySelectorAll('[data-purchase-type]'))
  if (!buttons.length) return

  buttons.forEach((button) => setPurchaseAccessState(button, 'checking'))

  try {
    const user = await getCurrentUser()
    if (runId !== entitlementRefreshRun) return
    if (!user) {
      buttons.forEach((button) => setPurchaseAccessState(button, 'available'))
      return
    }

    const profile = await getCurrentProfile(user)
    const role = profile?.role || 'customer'
    const context = { user, profile, role, isAdmin: isAdminRole(role) }
    if (context.isAdmin) {
      buttons.forEach((button) => setPurchaseAccessState(button, 'entitled'))
      return
    }

    const [hierarchy, grantsResult] = await Promise.all([
      fetchContentHierarchy(),
      fetchViewerBookGrants(user.id),
    ])
    if (runId !== entitlementRefreshRun) return
    if (grantsResult.error || Object.values(hierarchy.errors || {}).some(Boolean)) {
      throw grantsResult.error || new Error('Content access could not be resolved.')
    }

    const grants = grantsResult.data || []
    await Promise.all(buttons.map(async (button) => {
      try {
        const payload = await purchasePayloadForButton(button)
        if (runId !== entitlementRefreshRun || !button.isConnected) return
        const entitled = hasEffectivePurchaseEntitlement(
          purchaseTargetForPayload(payload),
          hierarchy,
          grants,
          context
        )
        setPurchaseAccessState(button, entitled ? 'entitled' : 'available')
      } catch (_error) {
        if (runId === entitlementRefreshRun && button.isConnected) {
          setPurchaseAccessState(button, 'unavailable')
        }
      }
    }))
  } catch (error) {
    if (runId !== entitlementRefreshRun) return
    console.info('Purchase entitlement could not be resolved.', {
      name: error?.name,
      message: error?.message,
      code: error?.code,
    })
    buttons.forEach((button) => setPurchaseAccessState(button, 'unavailable'))
  }
}

const openPurchaseDialog = ({ button, payload, pricing }) => new Promise((resolve) => {
  let appliedCoupon = null
  let currentPricing = pricing
  const previousOverflow = document.body.style.overflow

  const overlay = document.createElement('div')
  overlay.className = 'purchase-checkout-modal'
  overlay.setAttribute('role', 'presentation')

  const dialog = document.createElement('section')
  dialog.className = 'purchase-checkout-dialog'
  dialog.setAttribute('role', 'dialog')
  dialog.setAttribute('aria-modal', 'true')
  dialog.setAttribute('aria-labelledby', 'purchase-checkout-title')

  const header = document.createElement('div')
  header.className = 'purchase-checkout-dialog__header'
  const heading = document.createElement('div')
  const eyebrow = document.createElement('p')
  eyebrow.className = 'eyebrow'
  eyebrow.textContent = 'Secure checkout'
  const title = document.createElement('h2')
  title.id = 'purchase-checkout-title'
  title.textContent = getText(pricing.item_name, 'Greyveil purchase')
  heading.append(eyebrow, title)

  const closeButton = document.createElement('button')
  closeButton.type = 'button'
  closeButton.className = 'purchase-checkout-close'
  closeButton.setAttribute('aria-label', 'Close checkout')
  closeButton.textContent = '\u00d7'
  header.append(heading, closeButton)

  const price = document.createElement('div')
  price.className = 'purchase-checkout-price'
  const original = document.createElement('span')
  original.className = 'purchase-checkout-price__original'
  const final = document.createElement('strong')
  final.className = 'purchase-checkout-price__final'
  price.append(original, final)

  const couponForm = document.createElement('form')
  couponForm.className = 'purchase-coupon-form'
  const label = document.createElement('label')
  label.setAttribute('for', 'purchase-coupon-code')
  label.textContent = 'Coupon code'
  const controls = document.createElement('div')
  controls.className = 'purchase-coupon-form__controls'
  const input = document.createElement('input')
  input.id = 'purchase-coupon-code'
  input.name = 'coupon_code'
  input.type = 'text'
  input.autocomplete = 'off'
  input.autocapitalize = 'characters'
  input.spellcheck = false
  input.maxLength = 40
  const applyButton = document.createElement('button')
  applyButton.type = 'submit'
  applyButton.className = 'button ghost purchase-coupon-apply'
  applyButton.textContent = 'Apply'
  const removeButton = document.createElement('button')
  removeButton.type = 'button'
  removeButton.className = 'purchase-coupon-remove'
  removeButton.textContent = 'Remove coupon'
  removeButton.hidden = true
  controls.append(input, applyButton)

  const couponStatus = document.createElement('p')
  couponStatus.className = 'purchase-coupon-status'
  couponStatus.setAttribute('role', 'status')
  couponStatus.setAttribute('aria-live', 'polite')
  couponForm.append(label, controls, removeButton, couponStatus)

  const actions = document.createElement('div')
  actions.className = 'purchase-checkout-actions'
  const continueButton = document.createElement('button')
  continueButton.type = 'button'
  continueButton.className = 'button primary'
  continueButton.textContent = 'Continue to checkout'
  actions.append(continueButton)

  const renderPricing = () => {
    const discounted = Boolean(appliedCoupon && Number(currentPricing.discount_amount) > 0)
    original.textContent = discounted
      ? `Original ${formatCurrency(currentPricing.original_amount, currentPricing.currency)}`
      : 'Price'
    original.classList.toggle('is-discounted', discounted)
    final.textContent = formatCurrency(currentPricing.final_amount, currentPricing.currency)
  }

  const resetCoupon = () => {
    appliedCoupon = null
    currentPricing = {
      ...pricing,
      valid: false,
      coupon_code: null,
      final_amount: pricing.original_amount,
      discount_amount: 0,
    }
    removeButton.hidden = true
    renderPricing()
  }

  const cleanup = (result) => {
    document.removeEventListener('keydown', handleKeydown)
    document.body.style.overflow = previousOverflow
    overlay.remove()
    if (!result) button?.focus({ preventScroll: true })
    resolve(result)
  }

  const handleKeydown = (event) => {
    if (event.key === 'Escape') cleanup(null)
  }

  couponForm.addEventListener('submit', async (event) => {
    event.preventDefault()
    const couponCode = getText(input.value)
    if (!couponCode) {
      resetCoupon()
      couponStatus.textContent = 'Enter a coupon code.'
      couponStatus.dataset.status = 'error'
      return
    }

    applyButton.disabled = true
    input.disabled = true
    continueButton.disabled = true
    couponStatus.textContent = 'Checking coupon...'
    couponStatus.dataset.status = 'info'

    try {
      const result = await apiPost('/api/validate-coupon', {
        ...payload,
        coupon_code: couponCode,
      })
      currentPricing = result.pricing

      if (!currentPricing?.valid) {
        resetCoupon()
        couponStatus.textContent = 'That coupon is not valid. The regular price still applies.'
        couponStatus.dataset.status = 'error'
        return
      }

      appliedCoupon = currentPricing.coupon_code
      input.value = appliedCoupon
      removeButton.hidden = false
      couponStatus.textContent = `${appliedCoupon} applied.`
      couponStatus.dataset.status = 'success'
      renderPricing()
    } catch (error) {
      resetCoupon()
      couponStatus.textContent = error?.message || 'The coupon could not be checked.'
      couponStatus.dataset.status = 'error'
    } finally {
      applyButton.disabled = false
      input.disabled = false
      continueButton.disabled = false
    }
  })

  input.addEventListener('input', () => {
    if (!appliedCoupon) return
    resetCoupon()
    couponStatus.textContent = 'Apply the updated code before checkout.'
    couponStatus.dataset.status = 'info'
  })

  removeButton.addEventListener('click', () => {
    input.value = ''
    resetCoupon()
    couponStatus.textContent = 'Coupon removed.'
    couponStatus.dataset.status = 'info'
    input.focus()
  })

  closeButton.addEventListener('click', () => cleanup(null))
  continueButton.addEventListener('click', () => cleanup({ couponCode: appliedCoupon }))
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) cleanup(null)
  })

  dialog.append(header, price, couponForm, actions)
  overlay.append(dialog)
  document.body.append(overlay)
  document.body.style.overflow = 'hidden'
  document.addEventListener('keydown', handleKeydown)
  renderPricing()
  input.focus({ preventScroll: true })
})

const openCheckout = async ({ button, user, profile, order }) => {
  const Razorpay = await loadCheckoutScript()

  return new Promise((resolve, reject) => {
    const checkout = new Razorpay({
      key: order.key_id,
      amount: order.amount,
      currency: order.currency,
      name: 'Greyveil Editions',
      description: getText(button.dataset.purchaseDefaultLabel, 'Greyveil purchase'),
      order_id: order.order_id,
      prefill: {
        name: displayNameFor(user, profile),
        email: user.email || '',
      },
      notes: {
        local_order_id: order.local_order_id,
      },
      theme: {
        color: '#2a3440',
      },
      modal: {
        ondismiss: () => {
          setPurchaseStatus(button, 'Checkout closed before payment was confirmed.', 'info')
          resolve({ dismissed: true })
        },
      },
      handler: async (response) => {
        try {
          const verification = await apiPost('/api/verify-payment', {
            local_order_id: order.local_order_id,
            razorpay_payment_id: response.razorpay_payment_id,
            razorpay_order_id: response.razorpay_order_id,
            razorpay_signature: response.razorpay_signature,
          })
          resolve(verification)
        } catch (error) {
          reject(error)
        }
      },
    })

    checkout.on('payment.failed', (response) => {
      const description = response?.error?.description || 'Payment failed. Please try again.'
      setPurchaseStatus(button, description, 'error')
      resolve({ failed: true })
    })

    checkout.open()
  })
}

const redirectToLogin = () => {
  const next = `${window.location.pathname}${window.location.search}${window.location.hash}`
  window.location.assign(`/auth/login/?next=${encodeURIComponent(next)}`)
}

const handlePurchaseClick = async (event) => {
  const button = event.target.closest('[data-purchase-type]')
  if (!button) return

  event.preventDefault()
  event.stopPropagation()

  if (button.disabled) return
  if (button.dataset.purchaseAccessState !== 'available') return

  const user = await getCurrentUser()
  if (!user) {
    setPurchaseStatus(button, 'Please log in to continue checkout.', 'info')
    window.setTimeout(redirectToLogin, 350)
    return
  }

  const profile = await getCurrentProfile(user)

  setButtonBusy(button, true, 'Starting checkout...')
  setPurchaseStatus(button, 'Preparing your purchase...', 'info')

  try {
    const payload = await purchasePayloadForButton(button)
    const { pricing } = await apiPost('/api/validate-coupon', payload)
    const selection = await openPurchaseDialog({ button, payload, pricing })
    if (!selection) {
      setPurchaseStatus(button, 'Checkout closed.', 'info')
      return
    }
    const couponCode = selection.couponCode

    setPurchaseStatus(button, 'Opening secure checkout...', 'info')
    const { order } = await apiPost('/api/create-order', {
      ...payload,
      ...(couponCode ? { coupon_code: couponCode } : {}),
    })
    const verification = await openCheckout({ button, user, profile, order })

    if (verification?.dismissed || verification?.failed) return

    if (verification?.paid) {
      setPurchaseStatus(button, 'Payment confirmed. Your library is refreshing.', 'success')
      window.dispatchEvent(new CustomEvent('greyveil:purchase-complete', {
        detail: verification,
      }))
      return
    }

    setPurchaseStatus(button, 'Payment is processing. Your library will update after confirmation.', 'info')
  } catch (error) {
    if (error?.code === 'already_entitled') {
      setPurchaseAccessState(button, 'entitled')
      window.setTimeout(refreshPurchaseEntitlements, 0)
      return
    }
    setPurchaseStatus(button, error?.message || 'Checkout could not be completed.', 'error')
  } finally {
    setButtonBusy(button, false)
  }
}

const priceLabelForButton = (button) => {
  const type = normalizeSlug(button.dataset.purchaseType)
  const slug = normalizeSlug(button.dataset.purchaseSlug)
  if (type === 'book') return PRICE_LABELS.book
  return PRICE_LABELS[type]?.[slug] || ''
}

const normalizeStaticPurchaseLabels = () => {
  document.querySelectorAll('[data-purchase-type]').forEach((button) => {
    if (button.dataset.purchaseLabelReady) return
    const label = getText(button.dataset.purchaseLabel)
    const price = priceLabelForButton(button)
    if (label) button.textContent = label
    if (!label && price && !button.textContent.includes(price)) {
      button.textContent = `Buy ${button.dataset.purchaseType} - ${price}`
    }
    button.dataset.purchaseLabelReady = 'true'
  })
}

export const initPurchases = () => {
  if (initialized) return
  initialized = true
  normalizeStaticPurchaseLabels()
  refreshPurchaseEntitlements()
  document.addEventListener('click', handlePurchaseClick)
  window.addEventListener('greyveil:purchases-refresh-labels', () => {
    normalizeStaticPurchaseLabels()
    refreshPurchaseEntitlements()
  })
  window.addEventListener('greyveil:purchase-complete', () => {
    window.setTimeout(refreshPurchaseEntitlements, 0)
  })
  supabase.auth.onAuthStateChange(() => {
    window.setTimeout(refreshPurchaseEntitlements, 0)
  })
}

initPurchases()
