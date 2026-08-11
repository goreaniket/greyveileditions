import { supabase } from './supabase-client.js'
import { getCurrentProfile, getCurrentUser } from './auth.js'

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

const getText = (value, fallback = '') => {
  const text = value == null ? '' : String(value).trim()
  return text || fallback
}

const normalizeSlug = (value) => getText(value).toLowerCase()

const setButtonBusy = (button, busy, label = 'Working...') => {
  if (!button) return
  if (!button.dataset.purchaseDefaultLabel) button.dataset.purchaseDefaultLabel = button.textContent
  button.disabled = busy
  button.textContent = busy ? label : button.dataset.purchaseDefaultLabel
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
    throw new Error(result?.error?.message || 'The payment request could not be completed.')
  }

  return result
}

const resolveRecordId = async (type, slug) => {
  const cleanSlug = normalizeSlug(slug)
  if (!cleanSlug) return ''

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

  const user = await getCurrentUser()
  if (!user) {
    setPurchaseStatus(button, 'Please log in to continue checkout.', 'info')
    window.setTimeout(redirectToLogin, 350)
    return
  }

  const profile = await getCurrentProfile(user)

  setButtonBusy(button, true, 'Starting checkout...')
  setPurchaseStatus(button, 'Preparing secure checkout...', 'info')

  try {
    const payload = await purchasePayloadForButton(button)
    const { order } = await apiPost('/api/create-order', payload)
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
  document.addEventListener('click', handlePurchaseClick)
  window.addEventListener('greyveil:purchases-refresh-labels', normalizeStaticPurchaseLabels)
}

initPurchases()
