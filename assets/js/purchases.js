import { supabase } from './supabase-client.js'
import {
  checkoutUrlForPayload,
  formatCurrency,
  getText,
  purchasePayloadForElement,
  purchaseTargetForPayload,
} from './commerce.js?v=20260819-commerce-stabilization'
import {
  getEntitlementSnapshot,
  hierarchyForBook,
  invalidateEntitlementSnapshot,
  collectionForSeries,
  collectionForVolume,
  purchaseEntitlementDetails,
  volumeForSeries,
} from './content-access.js?v=20260819-commerce-stabilization'

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
  button.removeAttribute('aria-label')
  button.removeAttribute('title')
  button.hidden = detail.reason === 'public'

  if (detail.reason === 'public') {
    button.disabled = true
    button.dataset.purchaseAccessState = 'public'
    return
  }

  if (state === 'checking') {
    button.disabled = true
    button.setAttribute('aria-busy', 'true')
    button.setAttribute('aria-label', 'Checking access')
    button.textContent = 'Checking access…'
    return
  }
  if (state === 'entitled') {
    const ownerGranted = ['owner_grant', 'admin'].includes(detail.reason)
    button.disabled = true
    button.textContent = detail.reason === 'temporary_pass'
      ? '1-Day access active'
      : ownerGranted ? 'Access granted by owner' : 'Access granted'
    button.title = detail.reason === 'temporary_pass'
      ? 'Temporary access is active for this content.'
      : ownerGranted ? 'Access was provided by Greyveil Editions.' : 'Already in your library'
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

const hierarchyForPurchase = (purchase, hierarchy) => {
  if (purchase.purchaseType === 'book') {
    const book = (hierarchy.books || []).find((item) => String(item.id) === String(purchase.targetId))
    return hierarchyForBook(book, hierarchy.seriesItems, hierarchy.collections, hierarchy.volumes)
  }
  if (purchase.purchaseType === 'series') {
    const series = (hierarchy.seriesItems || []).find((item) => String(item.id) === String(purchase.targetId))
    const volume = volumeForSeries(series, hierarchy.volumes || [])
    return { collection: collectionForSeries(series, hierarchy.collections || []) || collectionForVolume(volume, hierarchy.collections || []), volume, series }
  }
  const collection = (hierarchy.collections || []).find((item) => String(item.id) === String(purchase.targetId))
  return { collection }
}

const purchaseContainerFor = (button) => button.closest('.button-row, .card-actions') || button.parentElement

const removePassOffer = (button) => {
  const container = purchaseContainerFor(button)
  container?.querySelectorAll('[data-generated-pass-offer]').forEach((offer) => offer.remove())
}

const applicablePassFor = (purchase, snapshot) => {
  const itemHierarchy = hierarchyForPurchase(purchase, snapshot.hierarchy)
  return (snapshot.accessPasses || []).find((pass) => {
    if (pass.scope_type === 'library') return true
    return pass.scope_type === 'collection' && String(pass.collection_id) === String(itemHierarchy.collection?.id)
  }) || null
}

const ensurePassOffer = (button, payload, snapshot, details) => {
  if (!['book', 'series', 'collection'].includes(payload.purchase_type) || details.entitled) {
    removePassOffer(button)
    return
  }

  const pass = applicablePassFor(purchaseTargetForPayload(payload), snapshot)
  const duration = Number(pass?.duration_hours)
  const price = Number(pass?.price_amount)
  if (!pass || !Number.isInteger(duration) || duration <= 0 || !Number.isInteger(price) || price <= 0) {
    removePassOffer(button)
    return
  }

  const container = purchaseContainerFor(button)
  if (!container) return
  const existing = container.querySelector('[data-generated-pass-offer]')
  if (existing && existing.dataset.purchasePassId !== String(pass.id)) existing.remove()
  const offer = existing?.isConnected ? existing : document.createElement('button')
  offer.type = 'button'
  offer.className = 'button ghost purchase-button pass-purchase-option'
  offer.dataset.generatedPassOffer = ''
  offer.dataset.purchaseType = 'pass'
  offer.dataset.purchasePassId = String(pass.id)
  offer.dataset.purchaseLabel = `1-Day Access · ${duration} hours · ${formatCurrency(price)}`
  offer.dataset.purchaseDefaultLabel = offer.dataset.purchaseLabel
  offer.dataset.purchaseAccessState = 'available'
  offer.disabled = false
  offer.textContent = offer.dataset.purchaseLabel
  if (!existing?.isConnected) container.append(offer)
}

const refreshPurchaseEntitlements = async () => {
  const runId = ++entitlementRefreshRun
  const buttons = Array.from(document.querySelectorAll('[data-purchase-type]'))
    .filter((button) => !button.dataset.generatedPassOffer)
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
          snapshot.paidOrders,
          snapshot.accessPasses,
          snapshot.passActivations
        )
        setPurchaseState(button, details.entitled ? 'entitled' : 'available', details)
        ensurePassOffer(button, payload, snapshot, details)
      } catch (_error) {
        if (runId === entitlementRefreshRun && button.isConnected) {
          setPurchaseState(button, 'unavailable')
          removePassOffer(button)
        }
      }
    }))
  } catch (error) {
    if (runId !== entitlementRefreshRun) return
    console.info('Purchase entitlement could not be resolved.', { message: error?.message, code: error?.code })
    buttons.forEach((button) => setPurchaseState(button, 'unavailable'))
    document.querySelectorAll('[data-generated-pass-offer]').forEach((offer) => offer.remove())
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

const normalizeStaticPurchaseLabels = () => {
  document.querySelectorAll('[data-purchase-type]').forEach((button) => {
    if (button.dataset.purchaseLabelReady) return
    const label = getText(button.dataset.purchaseLabel)
    if (label) button.textContent = label
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
    entitlementRefreshRun += 1
    window.setTimeout(refreshPurchaseEntitlements, 0)
  })
}

initPurchases()
