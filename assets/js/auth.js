import { supabase } from './supabase-client.js'
import { friendlyAuthMessage, logAuthDiagnostic } from './auth-errors.js'
import { appUrl, safeReturnPath } from './site-config.js'

const ADMIN_ROLES = new Set(['admin', 'super_admin'])
const LOGIN_PATH = '/auth/login/'
const ACCOUNT_PATH = '/account/'
const ADMIN_PATH = '/admin/'
const RESET_PASSWORD_PATH = '/reset-password/'
const MIN_PASSWORD_LENGTH = 8
const MAX_PASSWORD_LENGTH = 128

const getFormValue = (form, name) => form.elements[name]?.value.trim() || ''

const setStatus = (node, message = '', type = '') => {
  if (!node) return
  node.textContent = message
  node.dataset.status = type
}

const setBusy = (button, busy, label) => {
  if (!button) return
  if (!button.dataset.defaultLabel) button.dataset.defaultLabel = button.textContent
  button.disabled = busy
  button.textContent = busy ? label : button.dataset.defaultLabel
}

const validateNewPassword = (password, confirmation) => {
  if (!password || !confirmation) return 'Please complete both password fields.'
  if (password.length < MIN_PASSWORD_LENGTH) return `Use at least ${MIN_PASSWORD_LENGTH} characters.`
  if (password.length > MAX_PASSWORD_LENGTH) return `Use no more than ${MAX_PASSWORD_LENGTH} characters.`
  if (password !== confirmation) return 'Passwords do not match.'
  return ''
}

const resetPasswordRedirectUrl = () => appUrl(RESET_PASSWORD_PATH)

const recoveryUrlState = () => {
  const search = new URLSearchParams(window.location.search)
  const hash = new URLSearchParams(window.location.hash.replace(/^#/, ''))
  const type = search.get('type') || hash.get('type') || ''

  return {
    hasError: search.has('error') || search.has('error_code') || hash.has('error') || hash.has('error_code'),
    hasImplicitRecovery: type === 'recovery' && hash.has('access_token'),
    hasPkceRecovery: search.has('code'),
    isRecovery: type === 'recovery' || search.has('code'),
  }
}

const hasAuthCallbackError = () => {
  const search = new URLSearchParams(window.location.search)
  const hash = new URLSearchParams(window.location.hash.replace(/^#/, ''))
  return search.has('error') || search.has('error_code') || hash.has('error') || hash.has('error_code')
}

const clearRecoveryUrl = () => {
  window.history.replaceState({}, document.title, window.location.pathname)
}

const isNetworkError = (error) => {
  const message = String(error?.message || '').toLowerCase()
  return message.includes('network') || message.includes('fetch') || message.includes('offline')
}

const isAdminRole = (role) => ADMIN_ROLES.has(role)

const formatRole = (role) => {
  if (role === 'super_admin') return 'Super admin'
  if (role === 'admin') return 'Admin'
  return 'Reader'
}

const displayNameFor = (user, profile) => {
  return profile?.display_name
    || user?.user_metadata?.display_name
    || user?.email?.split('@')[0]
    || 'Reader'
}

let accountLibraryRun = 0
let accountPaymentsRun = 0
let accountLibraryRefreshTimer = 0

const getText = (value, fallback = '') => {
  const text = value == null ? '' : String(value).trim()
  return text || fallback
}

const formatDate = (value) => {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date)
}

const formatAccessType = (value) => {
  const label = getText(value, 'manual')
    .replace(/[_-]+/g, ' ')
    .toLowerCase()

  return label.replace(/\b\w/g, (letter) => letter.toUpperCase())
}

const libraryNodes = () => ({
  section: document.querySelector('[data-account-library]'),
  eyebrow: document.querySelector('[data-library-eyebrow]'),
  title: document.querySelector('[data-library-title]'),
  note: document.querySelector('[data-library-note]'),
  status: document.querySelector('[data-library-status]'),
  grid: document.querySelector('[data-library-grid]'),
  empty: document.querySelector('[data-library-empty]'),
  refresh: document.querySelector('[data-library-refresh]'),
})

const readingProgressFor = (book) => {
  if (!book?.slug) return { percent: 0, state: 'start' }
  try {
    const prefix = `greyveil:${book.slug}:continuous-reader:`
    const key = Object.keys(localStorage).find((candidate) => candidate.startsWith(prefix))
    if (!key) return { percent: 0, state: 'start' }
    const saved = JSON.parse(localStorage.getItem(key) || '{}')
    const percent = Math.max(0, Math.min(100, Math.round(Number(saved.scrollRatio || 0) * 100)))
    return {
      percent,
      state: percent >= 95 ? 'completed' : percent > 1 ? 'continue' : 'start',
    }
  } catch (_error) {
    return { percent: 0, state: 'start' }
  }
}

const paymentNodes = () => ({
  section: document.querySelector('[data-account-payments]'),
  status: document.querySelector('[data-payments-status]'),
  list: document.querySelector('[data-payments-list]'),
  empty: document.querySelector('[data-payments-empty]'),
})

const clearNode = (node) => {
  if (!node) return
  while (node.firstChild) node.firstChild.remove()
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

const formatPurchaseType = (value) => formatAccessType(getText(value, 'purchase'))

const paymentStatusForOrder = (order, payment) => {
  const paymentStatus = getText(payment?.status).toLowerCase()
  if (paymentStatus === 'refunded') return 'refunded'
  if (paymentStatus === 'failed') return 'failed'
  if (paymentStatus === 'captured' || payment?.captured === true) return 'paid'
  return getText(order?.status, paymentStatus || 'pending').toLowerCase()
}

const paymentHistoryCard = (order, payment) => {
  const card = document.createElement('article')
  card.className = 'payment-history-card'

  const heading = document.createElement('div')
  heading.className = 'payment-history-card__heading'
  const title = document.createElement('h3')
  title.textContent = getText(order.item_name, 'Greyveil purchase')
  const originalAmount = Number(order.original_amount ?? payment?.original_amount ?? order.amount)
  const paidAmount = Number(order.amount ?? payment?.amount)
  const couponCode = getText(order.coupon_code || payment?.coupon_code)
  const discounted = couponCode && Number.isFinite(originalAmount) && originalAmount > paidAmount
  const amount = document.createElement('div')
  amount.className = 'payment-history-card__amount'

  if (discounted) {
    const original = document.createElement('span')
    const originalPrice = document.createElement('del')
    original.append('Original: ', originalPrice)
    originalPrice.textContent = formatCurrency(originalAmount, order.currency)

    const paid = document.createElement('strong')
    paid.textContent = `Paid: ${formatCurrency(paidAmount, order.currency)}`
    const coupon = document.createElement('span')
    coupon.textContent = `Coupon: ${couponCode}`
    amount.append(original, paid, coupon)
  } else {
    const paid = document.createElement('strong')
    paid.textContent = formatCurrency(paidAmount, order.currency)
    amount.append(paid)
  }

  heading.append(title, amount)

  const meta = document.createElement('div')
  meta.className = 'payment-history-card__meta'
  const type = document.createElement('span')
  type.textContent = formatPurchaseType(order.purchase_type)
  const date = document.createElement('time')
  date.dateTime = order.created_at || ''
  date.textContent = formatDate(order.paid_at || order.created_at) || 'Date unavailable'
  meta.append(type, date)

  const footer = document.createElement('div')
  footer.className = 'payment-history-card__footer'
  const status = document.createElement('span')
  const statusValue = paymentStatusForOrder(order, payment)
  status.className = `payment-history-status payment-history-status--${statusValue.replace(/[^a-z0-9]+/g, '-')}`
  status.textContent = formatAccessType(statusValue)
  footer.append(status)

  if (payment?.method) {
    const method = document.createElement('span')
    method.textContent = `Paid by ${formatAccessType(payment.method)}`
    footer.append(method)
  }

  card.append(heading, meta, footer)
  return card
}

const renderAccountPayments = async (user) => {
  const nodes = paymentNodes()
  if (!nodes.section || !nodes.list) return

  const runId = ++accountPaymentsRun
  nodes.section.hidden = false
  clearNode(nodes.list)
  if (nodes.empty) nodes.empty.hidden = true
  setStatus(nodes.status, 'Checking your payments...', 'info')

  try {
    const [ordersResult, paymentsResult] = await Promise.all([
      supabase
        .from('orders')
        .select('id, user_id, purchase_type, item_name, original_amount, amount, coupon_code, discount_amount, currency, status, created_at, paid_at, verified_at')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false }),
      supabase
        .from('payments')
        .select('order_id, user_id, original_amount, amount, coupon_code, discount_amount, currency, status, method, captured, created_at, verified_at, razorpay_created_at')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false }),
    ])

    if (ordersResult.error) throw ordersResult.error
    if (paymentsResult.error) throw paymentsResult.error
    if (runId !== accountPaymentsRun) return

    const paymentsByOrder = new Map()
    ;(paymentsResult.data || []).forEach((payment) => {
      const key = String(payment.order_id || '')
      if (key && !paymentsByOrder.has(key)) paymentsByOrder.set(key, payment)
    })

    const orders = ordersResult.data || []
    orders.forEach((order) => {
      nodes.list.append(paymentHistoryCard(order, paymentsByOrder.get(String(order.id))))
    })

    if (nodes.empty) nodes.empty.hidden = Boolean(orders.length)
    setStatus(nodes.status, '', '')
  } catch (error) {
    console.info('Account payments could not be loaded.', {
      name: error?.name,
      message: error?.message,
      code: error?.code,
    })
    clearNode(nodes.list)
    if (nodes.empty) nodes.empty.hidden = true
    setStatus(nodes.status, 'We could not load your payment history right now.', 'error')
  }
}

const bookReaderPath = (book, series) => {
  if (!book?.slug || !series?.slug) return ''
  return `/projects/${series.slug}/books/${book.slug}/reader/`
}

const bookCoverPath = (book) => {
  if (!book?.slug) return ''
  return `/assets/books/${book.slug}/cover/front-cover.webp`
}

const sortLibraryItems = (items) => {
  return [...items].sort((a, b) => {
    const seriesCompare = getText(a.series?.title, a.book?.series).localeCompare(getText(b.series?.title, b.book?.series))
    if (seriesCompare) return seriesCompare

    const aNumber = Number(a.book?.book_number)
    const bNumber = Number(b.book?.book_number)
    if (Number.isFinite(aNumber) && Number.isFinite(bNumber) && aNumber !== bNumber) return aNumber - bNumber

    return getText(a.book?.title).localeCompare(getText(b.book?.title))
  })
}

const currentGrantMap = (grants = [], access) => {
  const map = new Map()
  grants
    .filter((grant) => access.isGrantCurrent(grant))
    .forEach((grant) => {
      if (!map.has(grant.book_id)) map.set(grant.book_id, grant)
    })
  return map
}

const libraryHierarchyReady = (hierarchy, access) => {
  return access.hierarchyIsComplete(hierarchy) && access.hierarchyIsActive(hierarchy)
}

const configureLibraryCopy = (nodes, role) => {
  const admin = isAdminRole(role)
  if (nodes.eyebrow) nodes.eyebrow.textContent = admin ? 'Admin Library' : 'My Library'
  if (nodes.title) nodes.title.textContent = admin ? 'Full Catalogue Access' : 'My Library'
  if (nodes.note) {
    nodes.note.textContent = admin
      ? 'All active Greyveil books are available from this account.'
      : 'Your available Greyveil readers appear here.'
  }
}

const libraryAccessCopy = (item, role) => {
  if (isAdminRole(role)) {
    return {
      label: 'Full Access',
      detail: 'Admin Access',
    }
  }

  return {
    label: `${formatAccessType(item.grant?.access_type)} Access`,
    detail: item.grant?.expires_at
      ? `Expires ${formatDate(item.grant.expires_at)}`
      : 'Lifetime Access',
  }
}

const libraryBookState = (item, access) => {
  if (!access.hierarchyIsActive(item)) return { key: 'coming-soon', label: 'Coming Soon' }
  if (access.effectiveVisibilityForBookHierarchy(item) === 'private') {
    return { key: 'unavailable', label: 'Unavailable' }
  }

  const progress = readingProgressFor(item.book)
  if (progress.state === 'completed') return { key: 'completed', label: 'Completed', progress }
  if (progress.state === 'continue') return { key: 'continue', label: 'Continue Reading', progress }
  return { key: 'start', label: 'Start Reading', progress }
}

const libraryCard = (item, role, access) => {
  const { book, collection, volume, series } = item
  const readingState = libraryBookState(item, access)
  const card = document.createElement('article')
  card.className = 'library-card'

  const cover = document.createElement('figure')
  cover.className = 'library-card__cover'
  const coverPath = bookCoverPath(book)
  if (coverPath) {
    const image = document.createElement('img')
    image.src = coverPath
    image.alt = `${getText(book.title, 'Book')} cover`
    image.loading = 'lazy'
    image.addEventListener('error', () => {
      image.remove()
      card.classList.add('library-card--no-cover')
    }, { once: true })
    cover.append(image)
  } else {
    card.classList.add('library-card--no-cover')
  }

  const body = document.createElement('div')
  body.className = 'library-card__body'

  const title = document.createElement('h3')
  title.textContent = getText(book.title, 'Untitled Book')

  const meta = document.createElement('p')
  meta.className = 'library-card__meta'
  ;[
    getText(collection?.title),
    getText(volume?.title),
    getText(series?.title, book.series),
  ].filter(Boolean).forEach((value) => {
    const line = document.createElement('span')
    line.textContent = value
    meta.append(line)
  })

  const accessCopy = libraryAccessCopy(item, role)
  const accessNode = document.createElement('p')
  accessNode.className = 'library-card__access'
  const accessLabel = document.createElement('strong')
  const accessDetail = document.createElement('span')
  accessLabel.textContent = accessCopy.label
  accessDetail.textContent = accessCopy.detail
  accessNode.append(accessLabel, accessDetail)

  const stateNode = document.createElement('p')
  stateNode.className = `library-card__state library-card__state--${readingState.key}`
  stateNode.textContent = readingState.progress?.percent > 1 && readingState.key !== 'completed'
    ? `${readingState.label} - ${readingState.progress.percent}%`
    : readingState.label

  const readAction = document.createElement(readingState.key === 'coming-soon' || readingState.key === 'unavailable' ? 'span' : 'a')
  readAction.className = `button ${readingState.key === 'completed' ? 'ghost' : 'primary'}`
  readAction.textContent = readingState.label
  if (readAction.tagName === 'A') readAction.href = bookReaderPath(book, series)
  else readAction.setAttribute('aria-disabled', 'true')

  body.append(title, meta, accessNode, stateNode, readAction)
  card.append(cover, body)
  return card
}

export const buildCustomerLibraryItems = (hierarchy, grants, paidOrders, access) => {
  const grantsByBook = currentGrantMap(grants, access)

  return hierarchy.books
    .map((book) => {
      const itemHierarchy = access.hierarchyForBook(book, hierarchy.seriesItems, hierarchy.collections, hierarchy.volumes)
      const directGrant = grantsByBook.get(book.id)
      const inheritedPurchase = access.hasInheritedPaidOrderEntitlement(itemHierarchy, paidOrders)
      const grant = directGrant || (inheritedPurchase ? { access_type: 'purchase', expires_at: null } : null)
      return { ...itemHierarchy, grant }
    })
    .filter((item) => {
      if (!item.grant) return false
      if (!access.hierarchyIsComplete(item)) return false
      return Boolean(bookReaderPath(item.book, item.series))
    })
}

const logCustomerLibraryDiagnostics = (hierarchy, grants, items, access) => {
  if (!grants.length) return

  const visibleBookIds = new Set(items.map((item) => item.book?.id).filter(Boolean))
  const booksById = new Map((hierarchy.books || []).map((book) => [book.id, book]))
  const hidden = grants
    .filter((grant) => !visibleBookIds.has(grant.book_id))
    .map((grant) => {
      const book = booksById.get(grant.book_id)
      if (!book) {
        return {
          book_id: grant.book_id,
          reason: 'book row was not readable or no longer exists',
        }
      }

      const item = access.hierarchyForBook(book, hierarchy.seriesItems, hierarchy.collections, hierarchy.volumes)
      if (!libraryHierarchyReady(item, access)) {
        return {
          book_id: grant.book_id,
          title: book.title,
          reason: 'inactive or incomplete hierarchy',
        }
      }

      if (access.effectiveVisibilityForBookHierarchy(item) === 'private') {
        return {
          book_id: grant.book_id,
          title: book.title,
          reason: 'private hierarchy',
        }
      }

      if (!bookReaderPath(item.book, item.series)) {
        return {
          book_id: grant.book_id,
          title: book.title,
          reason: 'missing reader route',
        }
      }

      return {
        book_id: grant.book_id,
        title: book.title,
        reason: 'filtered after access rules',
      }
    })

  if (!hidden.length) return

  console.info('Some current book access grants are hidden from My Library.', {
    currentGrantCount: grants.length,
    visibleBookCount: items.length,
    hidden,
  })
}

const buildAdminLibraryItems = (hierarchy, access) => {
  return hierarchy.books
    .map((book) => access.hierarchyForBook(book, hierarchy.seriesItems, hierarchy.collections, hierarchy.volumes))
    .filter((item) => {
      return libraryHierarchyReady(item, access) && Boolean(bookReaderPath(item.book, item.series))
    })
}

export const groupLibraryItems = (items = []) => {
  const groups = new Map()
  items.forEach((item) => {
    const collectionKey = String(item.collection?.id || `series:${item.series?.id || 'standalone'}`)
    if (!groups.has(collectionKey)) {
      groups.set(collectionKey, {
        collection: item.collection || null,
        label: getText(item.collection?.title, item.series ? 'Independent Series' : 'Standalone Books'),
        series: new Map(),
      })
    }
    const collectionGroup = groups.get(collectionKey)
    const seriesKey = String(item.series?.id || 'standalone')
    if (!collectionGroup.series.has(seriesKey)) {
      collectionGroup.series.set(seriesKey, {
        series: item.series || null,
        label: getText(item.series?.title, item.book?.series || 'Standalone'),
        items: [],
      })
    }
    collectionGroup.series.get(seriesKey).items.push(item)
  })
  return Array.from(groups.values()).map((group) => ({
    ...group,
    series: Array.from(group.series.values()).map((seriesGroup) => ({
      ...seriesGroup,
      items: sortLibraryItems(seriesGroup.items),
    })),
  }))
}

const renderLibraryHierarchy = (container, items, role, access) => {
  clearNode(container)
  const continuing = items
    .map((item) => ({ item, state: libraryBookState(item, access) }))
    .filter(({ state }) => state.key === 'continue')
    .sort((left, right) => right.state.progress.percent - left.state.progress.percent)
    .slice(0, 4)
  const continuingIds = new Set(continuing.map(({ item }) => String(item.book.id)))
  const recentCutoff = Date.now() - 90 * 24 * 60 * 60 * 1000
  const recent = items
    .filter((item) => !continuingIds.has(String(item.book.id)))
    .filter((item) => {
      const createdAt = Date.parse(item.book.created_at)
      return Number.isFinite(createdAt) && createdAt >= recentCutoff
    })
    .sort((left, right) => Date.parse(right.book.created_at) - Date.parse(left.book.created_at))
    .slice(0, 4)

  if (continuing.length || recent.length) {
    const highlights = createLibraryHighlights(continuing, recent)
    container.append(highlights)
  }

  groupLibraryItems(items).forEach((collectionGroup) => {
    const section = document.createElement('section')
    section.className = 'library-collection'
    const heading = document.createElement('div')
    heading.className = 'library-collection__heading'
    const eyebrow = document.createElement('p')
    eyebrow.className = 'eyebrow'
    eyebrow.textContent = collectionGroup.collection ? 'Collection' : 'Library'
    const title = document.createElement('h3')
    title.textContent = collectionGroup.label
    heading.append(eyebrow, title)
    section.append(heading)

    collectionGroup.series.forEach((seriesGroup) => {
      const seriesSection = document.createElement('section')
      seriesSection.className = 'library-series'
      const seriesHeading = document.createElement('div')
      seriesHeading.className = 'library-series__heading'
      const seriesTitle = document.createElement('h4')
      seriesTitle.textContent = seriesGroup.label
      const count = document.createElement('span')
      count.textContent = `${seriesGroup.items.length} ${seriesGroup.items.length === 1 ? 'book' : 'books'}`
      seriesHeading.append(seriesTitle, count)
      const grid = document.createElement('div')
      grid.className = 'library-grid'
      seriesGroup.items.forEach((item) => grid.append(libraryCard(item, role, access)))
      seriesSection.append(seriesHeading, grid)
      section.append(seriesSection)
    })
    container.append(section)
  })
}

const createLibraryHighlights = (continuing, recent) => {
  const highlights = document.createElement('div')
  highlights.className = 'library-highlights'
  const appendGroup = (title, records, continuingGroup = false) => {
    if (!records.length) return
    const section = document.createElement('section')
    const heading = document.createElement('h3')
    heading.textContent = title
    const list = document.createElement('div')
    list.className = 'library-highlight-links'
    records.forEach((record) => {
      const item = record.item || record
      const link = document.createElement('a')
      link.href = bookReaderPath(item.book, item.series)
      const label = document.createElement('strong')
      label.textContent = item.book.title
      const meta = document.createElement('span')
      meta.textContent = continuingGroup
        ? `${record.state.progress.percent}% read`
        : getText(item.series?.title, item.book.series)
      link.append(label, meta)
      list.append(link)
    })
    section.append(heading, list)
    highlights.append(section)
  }
  appendGroup('Continue Reading', continuing, true)
  appendGroup('Recently Added', recent)
  return highlights
}

const renderAccountLibrary = async (user, profile, role, { force = false } = {}) => {
  const nodes = libraryNodes()
  if (!nodes.section || !nodes.grid) return

  const runId = ++accountLibraryRun
  nodes.section.hidden = false
  clearNode(nodes.grid)
  if (nodes.empty) nodes.empty.hidden = true
  configureLibraryCopy(nodes, role)
  setBusy(nodes.refresh, true, 'Refreshing...')
  setStatus(nodes.status, 'Loading your library...', 'info')

  try {
    const access = await import('./content-access.js')
    const snapshot = await access.getEntitlementSnapshot({ force })
    const { hierarchy, paidOrders } = snapshot
    const grants = (snapshot.grants || []).filter((grant) => access.isGrantCurrent(grant))

    const hierarchyErrors = Object.entries(hierarchy.errors || {}).filter(([, error]) => error)

    if (runId !== accountLibraryRun) return

    if (hierarchyErrors.length) {
      const [table, error] = hierarchyErrors[0]
      const libraryError = new Error(error?.message || 'Content hierarchy could not be read.')
      libraryError.table = table
      libraryError.code = error?.code
      throw libraryError
    }

    const items = isAdminRole(role)
      ? buildAdminLibraryItems(hierarchy, access)
      : buildCustomerLibraryItems(hierarchy, grants, paidOrders, access)

    if (!isAdminRole(role)) logCustomerLibraryDiagnostics(hierarchy, grants, items, access)

    if (runId !== accountLibraryRun) return

    const sortedItems = sortLibraryItems(items)
    renderLibraryHierarchy(nodes.grid, sortedItems, role, access)

    if (nodes.empty) nodes.empty.hidden = Boolean(sortedItems.length)
    setStatus(nodes.status, '', '')
  } catch (error) {
    console.info('Account library could not be loaded.', {
      table: error?.table,
      name: error?.name,
      message: error?.message,
      code: error?.code,
    })
    clearNode(nodes.grid)
    if (nodes.empty) nodes.empty.hidden = true
    setStatus(nodes.status, 'We could not load your library right now. Please refresh and try again.', 'error')
  } finally {
    if (runId === accountLibraryRun) setBusy(nodes.refresh, false)
  }
}

export async function getCurrentUser() {
  const { data, error } = await supabase.auth.getUser()
  if (error || !data?.user) return null
  return data.user
}

export async function getCurrentProfile(user = null) {
  const currentUser = user || await getCurrentUser()
  if (!currentUser) return null

  const { data, error } = await supabase
    .from('profiles')
    .select('id, display_name, role')
    .eq('id', currentUser.id)
    .maybeSingle()

  if (error) return null
  return data
}

export async function getUserRole(user = null) {
  const profile = await getCurrentProfile(user)
  return profile?.role || 'customer'
}

export async function signOut() {
  const { error } = await supabase.auth.signOut()
  if (error) throw error
}

const safeLoginReturnPath = () => {
  const next = new URLSearchParams(window.location.search).get('next') || ''
  return safeReturnPath(next)
}

const signupConfirmationRedirectUrl = () => {
  const url = new URL(LOGIN_PATH, appUrl('/'))
  url.searchParams.set('confirmed', '1')
  url.searchParams.set('next', safeLoginReturnPath() || ACCOUNT_PATH)
  return url.href
}

const preserveAuthReturnLinks = () => {
  const next = safeLoginReturnPath()
  if (!next) return
  document.querySelectorAll('[data-auth-switch]').forEach((link) => {
    const url = new URL(link.href, window.location.origin)
    url.searchParams.set('next', next)
    link.href = `${url.pathname}${url.search}`
  })
}

export async function redirectByRole() {
  window.location.assign(safeLoginReturnPath() || ACCOUNT_PATH)
}

const showAuthView = (view) => {
  if (view) view.hidden = false
}

const guardAuthPage = async (view) => {
  const user = await getCurrentUser()
  if (user) {
    await redirectByRole(user)
    return false
  }

  showAuthView(view)
  return true
}

const clearAccountAdminAction = (accountActions) => {
  accountActions
    ?.querySelectorAll('[data-account-admin]')
    .forEach((node) => node.remove())
}

const renderAccountAdminAction = (accountActions, logoutButton, role) => {
  clearAccountAdminAction(accountActions)
  if (!accountActions || !isAdminRole(role)) return

  const link = document.createElement('a')
  link.className = 'button ghost'
  link.href = ADMIN_PATH
  link.dataset.accountAdmin = ''
  link.textContent = 'Admin Portal'

  if (logoutButton?.parentElement === accountActions) {
    accountActions.insertBefore(link, logoutButton)
    return
  }

  accountActions.prepend(link)
}

const initSignupPage = async () => {
  const view = document.querySelector('[data-auth-view]')
  const form = document.querySelector('[data-signup-form]')
  const status = document.querySelector('[data-auth-status]')
  const submitButton = form?.querySelector('button[type="submit"]')

  if (!form || !await guardAuthPage(view)) return

  form.addEventListener('submit', async (event) => {
    event.preventDefault()

    const displayName = getFormValue(form, 'display_name')
    const email = getFormValue(form, 'email')
    const password = form.elements.password?.value || ''
    const confirmPassword = form.elements.confirm_password?.value || ''

    if (!displayName || !email || !password || !confirmPassword) {
      setStatus(status, 'Please complete every field.', 'error')
      return
    }

    if (password !== confirmPassword) {
      setStatus(status, 'Passwords do not match.', 'error')
      return
    }

    const passwordError = validateNewPassword(password, confirmPassword)
    if (passwordError) {
      setStatus(status, passwordError, 'error')
      return
    }

    setBusy(submitButton, true, 'Creating account...')
    setStatus(status, 'Creating your account...', 'info')

    let data = null
    let error = null
    try {
      const result = await supabase.auth.signUp({
        email,
        password,
        options: {
          emailRedirectTo: signupConfirmationRedirectUrl(),
          data: {
            display_name: displayName,
          },
        },
      })
      data = result.data
      error = result.error
    } catch (signupError) {
      error = signupError
    }

    form.elements.password.value = ''
    form.elements.confirm_password.value = ''
    setBusy(submitButton, false)

    if (error) {
      logAuthDiagnostic('signup', error)
      setStatus(status, friendlyAuthMessage(error, 'We could not create the account. Please try again.'), 'error')
      return
    }

    if (data?.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
      setStatus(status, 'An account already exists for this email. Try signing in instead.', 'error')
      return
    }

    if (data?.session) {
      setStatus(status, 'Account created. Redirecting...', 'success')
      window.setTimeout(() => redirectByRole(data.user), 500)
      return
    }

    setStatus(status, 'Account created. Please check your email to confirm your address before signing in.', 'success')
    form.reset()
  })
}

const initLoginPage = async () => {
  const view = document.querySelector('[data-auth-view]')
  const form = document.querySelector('[data-login-form]')
  const status = document.querySelector('[data-auth-status]')
  const submitButton = form?.querySelector('button[type="submit"]')

  if (!form || !await guardAuthPage(view)) return

  if (hasAuthCallbackError()) {
    setStatus(status, 'This email confirmation link is invalid or has expired. Try signing in or create the account again.', 'error')
  } else if (new URLSearchParams(window.location.search).get('confirmed') === '1') {
    setStatus(status, 'Email confirmed. Sign in to continue.', 'success')
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault()

    const email = getFormValue(form, 'email')
    const password = form.elements.password?.value || ''

    if (!email || !password) {
      setStatus(status, 'Please enter your email and password.', 'error')
      return
    }

    setBusy(submitButton, true, 'Signing in...')
    setStatus(status, 'Signing in...', 'info')

    let error = null
    try {
      const result = await supabase.auth.signInWithPassword({ email, password })
      error = result.error
    } catch (loginError) {
      error = loginError
    }

    form.elements.password.value = ''

    if (error) {
      logAuthDiagnostic('login', error)
      setBusy(submitButton, false)
      setStatus(status, friendlyAuthMessage(error, 'We could not sign you in. Please try again.'), 'error')
      return
    }

    const user = await getCurrentUser()
    if (!user) {
      setBusy(submitButton, false)
      setStatus(status, 'We could not confirm your session. Please try again.', 'error')
      return
    }

    setStatus(status, 'Signed in. Redirecting...', 'success')
    await redirectByRole(user)
  })
}

const initForgotPasswordPage = async () => {
  const view = document.querySelector('[data-auth-view]')
  const form = document.querySelector('[data-forgot-password-form]')
  const status = document.querySelector('[data-auth-status]')
  const submitButton = form?.querySelector('button[type="submit"]')
  let completed = false

  if (!form || !await guardAuthPage(view)) return

  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    if (completed || submitButton?.disabled) return

    const email = getFormValue(form, 'email')
    if (!email || !form.elements.email?.validity?.valid) {
      setStatus(status, 'Please enter a valid email address.', 'error')
      return
    }

    setBusy(submitButton, true, 'Sending instructions...')
    setStatus(status, 'Preparing password reset instructions...', 'info')

    let error = null
    try {
      const result = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: resetPasswordRedirectUrl(),
      })
      error = result.error
    } catch (requestError) {
      error = requestError
    }

    if (error) logAuthDiagnostic('forgot_password', error)

    form.reset()
    if (error && isNetworkError(error)) {
      setBusy(submitButton, false)
      setStatus(status, 'We could not reach the account service. Please try again.', 'error')
      return
    }

    completed = true
    submitButton.disabled = true
    submitButton.textContent = 'Instructions requested'
    setStatus(status, "If an account exists for this email, we've sent password reset instructions.", 'success')
  })
}

const initResetPasswordPage = async () => {
  const loading = document.querySelector('[data-reset-loading]')
  const form = document.querySelector('[data-reset-password-form]')
  const invalid = document.querySelector('[data-reset-invalid]')
  const success = document.querySelector('[data-reset-success]')
  const status = form?.querySelector('[data-auth-status]')
  const submitButton = form?.querySelector('button[type="submit"]')
  const urlState = recoveryUrlState()
  let recoverySession = null
  let passwordUpdated = false
  let resolveRecoveryEvent
  const recoveryEvent = new Promise((resolve) => {
    resolveRecoveryEvent = resolve
  })

  const showOnly = (active) => {
    ;[loading, form, invalid, success].forEach((node) => {
      if (node) node.hidden = node !== active
    })
  }

  const showInvalid = () => {
    recoverySession = null
    if (form) {
      form.elements.password.value = ''
      form.elements.confirm_password.value = ''
    }
    clearRecoveryUrl()
    showOnly(invalid)
  }

  if (!form || !loading || !invalid || !success) return
  showOnly(loading)

  const { data: listenerData } = supabase.auth.onAuthStateChange((event, session) => {
    if (event !== 'PASSWORD_RECOVERY' || !session) return
    recoverySession = session
    resolveRecoveryEvent(session)
  })
  const subscription = listenerData?.subscription

  if (urlState.hasError || !urlState.isRecovery) {
    subscription?.unsubscribe()
    showInvalid()
    return
  }

  if (urlState.hasPkceRecovery) {
    const code = new URLSearchParams(window.location.search).get('code') || ''
    let data = null
    let error = null
    try {
      const result = await supabase.auth.exchangeCodeForSession(code)
      data = result.data
      error = result.error
    } catch (exchangeError) {
      error = exchangeError
    }
    if (error || !data?.session) {
      logAuthDiagnostic('password_recovery_exchange', error)
      subscription?.unsubscribe()
      showInvalid()
      return
    }
    recoverySession = data.session
  }

  const { data: sessionData, error: sessionError } = await supabase.auth.getSession()
  if (!sessionError && urlState.hasImplicitRecovery && sessionData?.session) {
    recoverySession = sessionData.session
  }

  if (!recoverySession) {
    recoverySession = await Promise.race([
      recoveryEvent,
      new Promise((resolve) => window.setTimeout(() => resolve(null), 2200)),
    ])
  }

  if (!recoverySession) {
    subscription?.unsubscribe()
    showInvalid()
    return
  }

  clearRecoveryUrl()
  showOnly(form)
  form.elements.password.focus({ preventScroll: true })

  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    if (passwordUpdated || !recoverySession || submitButton?.disabled) return

    const password = form.elements.password?.value || ''
    const confirmation = form.elements.confirm_password?.value || ''
    const passwordError = validateNewPassword(password, confirmation)
    if (passwordError) {
      setStatus(status, passwordError, 'error')
      return
    }

    setBusy(submitButton, true, 'Updating password...')
    setStatus(status, 'Updating your password securely...', 'info')

    let error = null
    try {
      const result = await supabase.auth.updateUser({ password })
      error = result.error
    } catch (updateError) {
      error = updateError
    }
    form.elements.password.value = ''
    form.elements.confirm_password.value = ''

    if (error) {
      logAuthDiagnostic('password_update', error)
      const message = String(error.message || '').toLowerCase()
      if (message.includes('session') || message.includes('jwt') || message.includes('expired')) {
        subscription?.unsubscribe()
        showInvalid()
        return
      }

      setBusy(submitButton, false)
      setStatus(status, friendlyAuthMessage(error, 'We could not update the password. Please request a new reset link.'), 'error')
      return
    }

    passwordUpdated = true
    recoverySession = null
    submitButton.disabled = true
    subscription?.unsubscribe()
    showOnly(success)
  })
}

const initAccountPage = async () => {
  const view = document.querySelector('[data-auth-view]')
  const status = document.querySelector('[data-auth-status]')
  const logoutButton = document.querySelector('[data-logout-button]')
  const nameNode = document.querySelector('[data-account-name]')
  const emailNode = document.querySelector('[data-account-email]')
  const roleRow = document.querySelector('[data-account-role-row]')
  const roleNode = document.querySelector('[data-account-role]')
  const accountActions = document.querySelector('[data-account-actions]')
  const libraryRefreshButton = document.querySelector('[data-library-refresh]')
  const profileForm = document.querySelector('[data-account-profile-form]')
  const profileStatus = document.querySelector('[data-account-profile-status]')
  let activeUser = null
  let activeProfile = null
  let activeRole = 'customer'

  const refreshCurrentLibrary = ({ force = false } = {}) => {
    if (!activeUser) return

    window.clearTimeout(accountLibraryRefreshTimer)
    accountLibraryRefreshTimer = window.setTimeout(() => {
      renderAccountLibrary(activeUser, activeProfile, activeRole, { force })
      renderAccountPayments(activeUser)
    }, 150)
  }

  clearAccountAdminAction(accountActions)

  const user = await getCurrentUser()
  if (!user) {
    window.location.replace(LOGIN_PATH)
    return
  }

  const renderCurrentAccount = async (currentUser) => {
    clearAccountAdminAction(accountActions)
    const profile = await getCurrentProfile(currentUser)
    const role = profile?.role || 'customer'
    activeUser = currentUser
    activeProfile = profile
    activeRole = role

    if (nameNode) nameNode.textContent = displayNameFor(currentUser, profile)
    if (emailNode) emailNode.textContent = currentUser.email || ''
    if (profileForm?.elements.display_name) profileForm.elements.display_name.value = displayNameFor(currentUser, profile)

    if (roleRow && roleNode) {
      roleNode.textContent = formatRole(role)
      roleRow.hidden = !isAdminRole(role)
    }

    renderAccountAdminAction(accountActions, logoutButton, role)

    showAuthView(view)
    await Promise.all([
      renderAccountLibrary(currentUser, profile, role),
      renderAccountPayments(currentUser),
    ])
  }

  await renderCurrentAccount(user)

  profileForm?.addEventListener('submit', async (event) => {
    event.preventDefault()
    if (!activeUser?.id) return
    const displayName = getFormValue(profileForm, 'display_name').replace(/\s+/g, ' ')
    if (displayName.length < 2 || displayName.length > 80 || /[\u0000-\u001f\u007f]/.test(displayName)) {
      setStatus(profileStatus, 'Use a display name between 2 and 80 characters.', 'error')
      return
    }
    const button = profileForm.querySelector('button[type="submit"]')
    setBusy(button, true, 'Saving...')
    setStatus(profileStatus, 'Saving your display name...', 'info')
    const { data, error } = await supabase
      .from('profiles')
      .update({ display_name: displayName })
      .eq('id', activeUser.id)
      .select('id, display_name, role')
      .maybeSingle()
    setBusy(button, false)
    if (error || !data) {
      setStatus(profileStatus, 'Your display name could not be updated. Please try again.', 'error')
      return
    }
    activeProfile = { ...activeProfile, ...data }
    if (nameNode) nameNode.textContent = data.display_name
    profileForm.elements.display_name.value = data.display_name
    setStatus(profileStatus, 'Display name updated.', 'success')
    window.dispatchEvent(new CustomEvent('greyveil:profile-changed', { detail: { userId: activeUser.id } }))
  })

  supabase.auth.onAuthStateChange((_event, session) => {
    window.setTimeout(async () => {
      const nextUser = session?.user || await getCurrentUser()
      if (!nextUser) {
        activeUser = null
        activeProfile = null
        activeRole = 'customer'
        clearAccountAdminAction(accountActions)
        window.location.replace(LOGIN_PATH)
        return
      }

      await renderCurrentAccount(nextUser)
    }, 0)
  })

  libraryRefreshButton?.addEventListener('click', () => refreshCurrentLibrary({ force: true }))
  window.addEventListener('focus', refreshCurrentLibrary)
  window.addEventListener('pageshow', refreshCurrentLibrary)
  window.addEventListener('greyveil:purchase-complete', refreshCurrentLibrary)
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refreshCurrentLibrary()
  })

  logoutButton?.addEventListener('click', async () => {
    clearAccountAdminAction(accountActions)
    setBusy(logoutButton, true, 'Signing out...')
    setStatus(status, 'Signing out...', 'info')

    try {
      await signOut()
      window.location.assign(LOGIN_PATH)
    } catch (error) {
      setBusy(logoutButton, false)
      setStatus(status, friendlyAuthMessage(error, 'We could not sign you out. Please try again.'), 'error')
      renderAccountAdminAction(accountActions, logoutButton, activeRole)
    }
  })
}

const page = document.body.dataset.authPage

preserveAuthReturnLinks()
if (page === 'signup') initSignupPage()
if (page === 'login') initLoginPage()
if (page === 'forgot-password') initForgotPasswordPage()
if (page === 'reset-password') initResetPasswordPage()
if (page === 'account') initAccountPage()
