import { supabase } from './supabase-client.js'
import {
  apiPost,
  checkoutSelectionFromSearch,
  edgeFunctionPost,
  formatCurrency,
  getText,
  loadRazorpayCheckout,
} from './commerce.js?v=20260812-edge-payments'
import { getEntitlementSnapshot, hierarchyForBook } from './content-access.js?v=20260812-edge-payments'

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

const includedContent = async (selection) => {
  try {
    const snapshot = await getEntitlementSnapshot()
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
    if (selection.purchaseType === 'pass') return 'Temporary access is activated only after verified payment and expires from the recorded activation time.'
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

export const openRazorpay = async ({ user, profile, order, itemName }) => {
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
    node('[data-checkout-includes]').textContent = await includedContent(selection)
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
    setBusy(payButton, true, 'Preparing Razorpay...')
    setStatus(checkoutStatus, 'Confirming your final server-owned price...', 'info')
    try {
      const { order } = await edgeFunctionPost('create-order', {
        ...selection.payload,
        ...(appliedCoupon ? { coupon_code: appliedCoupon } : {}),
      })
      const verification = await openRazorpay({ user, profile, order, itemName: basePricing.item_name })
      if (verification?.dismissed) {
        setStatus(checkoutStatus, 'Razorpay was closed before payment was confirmed.', 'info')
        return
      }
      if (verification?.failed) {
        setStatus(checkoutStatus, verification.message, 'error')
        return
      }
      if (verification?.paid) {
        setStatus(checkoutStatus, 'Payment confirmed. Refreshing your library...', 'success')
        payButton.disabled = true
        payButton.textContent = 'Payment confirmed'
        try {
          await getEntitlementSnapshot({ force: true })
        } catch (_error) {
          // The paid order remains authoritative; listeners below retry the library refresh.
        }
        window.dispatchEvent(new CustomEvent('greyveil:purchase-complete', { detail: verification }))
        setStatus(checkoutStatus, 'Payment confirmed. Access has been added to your library.', 'success')
        return
      }
      setStatus(checkoutStatus, 'Payment is processing. Your library will update after confirmation.', 'info')
    } catch (error) {
      if (error?.code === 'already_entitled') return showError('Access already granted.', 'This product is already available to your account.')
      setStatus(checkoutStatus, error?.message || 'Checkout could not be completed.', 'error')
    } finally {
      if (!payButton.disabled || payButton.textContent !== 'Payment confirmed') setBusy(payButton, false)
    }
  })
}

initCheckout()
