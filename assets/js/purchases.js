import { supabase } from './supabase-client.js'
import {
  checkoutUrlForPayload,
  getText,
  normalizePurchaseType,
  purchasePayloadForElement,
  purchaseTargetForPayload,
} from './commerce.js'
import {
  getEntitlementSnapshot,
  invalidateEntitlementSnapshot,
  purchaseEntitlementDetails,
} from './content-access.js'

const PRICE_LABELS = {
  book: 'Rs. 149',
  series: { 'human-mind': 'Rs. 599', 'human-paradox': 'Rs. 599', 'human-fiction': 'Rs. 499' },
  collection: { 'human-paradox-collection': 'Rs. 1,299', 'the-human-paradox-collection': 'Rs. 1,299' },
}

let initialized = false
let entitlementRefreshRun = 0

const statusFor = (button) => {
  const described = button.getAttribute('aria-describedby')
    ? document.getElementById(button.getAttribute('aria-describedby'))
    : null
  if (described?.dataset.purchaseStatus !== undefined) return described
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

const setStatus = (button, message = '', type = '') => {
  const status = statusFor(button)
  status.textContent = message
  status.dataset.status = type
}

const setPurchaseState = (button, state, detail = {}) => {
  if (!button.dataset.purchaseDefaultLabel) button.dataset.purchaseDefaultLabel = button.textContent
  button.classList.add('purchase-button')
  button.classList.toggle('purchase-button--entitled', state === 'entitled')
  button.classList.toggle('purchase-button--resolving', state === 'checking')
  button.dataset.purchaseAccessState = state
  button.removeAttribute('aria-busy')
  button.removeAttribute('title')

  if (state === 'checking') {
    button.disabled = true
    button.setAttribute('aria-busy', 'true')
    return
  }
  if (state === 'entitled') {
    const ownerGranted = ['owner_grant', 'admin'].includes(detail.reason)
    button.disabled = true
    button.textContent = ownerGranted ? 'Access granted by owner' : 'Access granted'
    button.title = ownerGranted ? 'Access was provided by Greyveil Editions.' : 'Already in your library'
    return
  }
  if (state === 'unavailable') {
    button.disabled = true
    button.textContent = 'Purchase unavailable'
    return
  }
  button.disabled = false
  button.textContent = button.dataset.purchaseDefaultLabel
}

const refreshPurchaseEntitlements = async () => {
  const runId = ++entitlementRefreshRun
  const buttons = Array.from(document.querySelectorAll('[data-purchase-type]'))
  if (!buttons.length) return
  buttons.forEach((button) => setPurchaseState(button, 'checking'))
  try {
    const snapshot = await getEntitlementSnapshot()
    if (runId !== entitlementRefreshRun) return
    await Promise.all(buttons.map(async (button) => {
      try {
        const payload = await purchasePayloadForElement(button)
        if (runId !== entitlementRefreshRun || !button.isConnected) return
        const details = purchaseEntitlementDetails(
          purchaseTargetForPayload(payload),
          snapshot.hierarchy,
          snapshot.grants,
          snapshot.context,
          snapshot.paidOrders
        )
        setPurchaseState(button, details.entitled ? 'entitled' : 'available', details)
      } catch (_error) {
        if (runId === entitlementRefreshRun && button.isConnected) setPurchaseState(button, 'unavailable')
      }
    }))
  } catch (error) {
    if (runId !== entitlementRefreshRun) return
    console.info('Purchase entitlement could not be resolved.', { message: error?.message, code: error?.code })
    buttons.forEach((button) => setPurchaseState(button, 'unavailable'))
  }
}

const currentReturnPath = () => `${window.location.pathname}${window.location.search}${window.location.hash}`

const handlePurchaseClick = async (event) => {
  const button = event.target.closest('[data-purchase-type]')
  if (!button) return
  event.preventDefault()
  event.stopPropagation()
  if (button.disabled || button.dataset.purchaseAccessState !== 'available') return
  button.disabled = true
  setStatus(button, 'Opening checkout...', 'info')
  try {
    const payload = await purchasePayloadForElement(button)
    const checkoutUrl = checkoutUrlForPayload(payload, currentReturnPath())
    if (!checkoutUrl) throw new Error('This purchase option is not configured.')
    window.location.assign(checkoutUrl)
  } catch (error) {
    setStatus(button, error?.message || 'Checkout could not be opened.', 'error')
    button.disabled = false
  }
}

const priceLabelForButton = (button) => {
  const type = normalizePurchaseType(button.dataset.purchaseType)
  const slug = getText(button.dataset.purchaseSlug).toLowerCase()
  if (type === 'book') return PRICE_LABELS.book
  return PRICE_LABELS[type]?.[slug] || ''
}

const normalizeStaticPurchaseLabels = () => {
  document.querySelectorAll('[data-purchase-type]').forEach((button) => {
    if (button.dataset.purchaseLabelReady) return
    const label = getText(button.dataset.purchaseLabel)
    const price = priceLabelForButton(button)
    if (label) button.textContent = label
    if (!label && price && !button.textContent.includes(price)) button.textContent = `Buy ${button.dataset.purchaseType} - ${price}`
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
    invalidateEntitlementSnapshot('purchase-complete')
    window.setTimeout(refreshPurchaseEntitlements, 0)
  })
  window.addEventListener('greyveil:access-changed', () => window.setTimeout(refreshPurchaseEntitlements, 0))
  supabase.auth.onAuthStateChange(() => {
    invalidateEntitlementSnapshot('auth-change')
    window.setTimeout(refreshPurchaseEntitlements, 0)
  })
}

initPurchases()
