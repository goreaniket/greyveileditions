import { supabase } from './supabase-client.js'
import { getCurrentProfile, getCurrentUser } from './auth.js'

export const ADMIN_ROLES = new Set(['admin', 'super_admin'])
export const VISIBILITY_STATES = ['public', 'paid', 'private']

const DEFAULT_VISIBILITY = 'paid'
const COLLECTION_SELECT = 'id, slug, title, description, visibility, is_active, price_amount, sort_order, created_at, updated_at'
const VOLUME_SELECT = 'id, collection_id, slug, title, description, visibility, is_active, sort_order, created_at, updated_at'
const SERIES_SELECT = 'id, collection_id, volume_id, slug, title, description, visibility, is_active, price_amount, sort_order, created_at, updated_at'
const BOOK_SELECT = 'id, title, series, book_number, slug, visibility, series_id, is_public, is_active, price_amount, created_at, updated_at'
const PAID_ORDER_SELECT = 'id, user_id, purchase_type, book_id, series_id, collection_id, status, paid_at'
const ACCESS_PASS_SELECT = 'id, title, active, price_amount, duration_hours, scope_type, collection_id'
const PASS_ACTIVATION_SELECT = 'pass_id, expires_at'

let entitlementSnapshot = null
let entitlementSnapshotPromise = null
let entitlementSnapshotVersion = 0
let entitlementAuthGeneration = 0

export const isAdminRole = (role) => ADMIN_ROLES.has(role)

export const normalizeVisibility = (value, fallback = DEFAULT_VISIBILITY) => {
  const visibility = value == null ? '' : String(value).trim().toLowerCase()
  return VISIBILITY_STATES.includes(visibility) ? visibility : fallback
}

export const visibilityForBook = (book) => {
  const explicitVisibility = normalizeVisibility(book?.visibility, DEFAULT_VISIBILITY)
  if (explicitVisibility === 'private') return 'private'
  if (book?.is_public === true || explicitVisibility === 'public') return 'public'
  return DEFAULT_VISIBILITY
}

export const displayNameFor = (user, profile) => {
  return profile?.display_name
    || user?.user_metadata?.display_name
    || user?.email?.split('@')[0]
    || 'Reader'
}

export const getAccessContext = async () => {
  const user = await getCurrentUser()
  const profile = user ? await getCurrentProfile(user) : null
  const role = profile?.role || (user ? 'customer' : 'guest')

  return {
    user,
    profile,
    role,
    isAdmin: isAdminRole(role),
    displayName: displayNameFor(user, profile),
  }
}

export const isActive = (item) => item?.is_active !== false

export const hasPrivateVisibility = (...items) => {
  return items.some((item) => normalizeVisibility(item?.visibility, 'public') === 'private')
}

export const effectiveVisibility = ({
  collection = null,
  volume = null,
  series = null,
  book = null,
} = {}) => {
  const items = [collection, volume, series, book].filter(Boolean)

  if (!items.length) return 'private'
  if (items.some((item) => normalizeVisibility(item?.visibility, 'public') === 'private')) return 'private'
  if (items.some((item) => normalizeVisibility(item?.visibility, 'public') === 'paid')) return 'paid'

  return 'public'
}

export const effectiveVisibilityForBookHierarchy = ({
  collection = null,
  volume = null,
  series = null,
  book = null,
} = {}) => {
  if (book && visibilityForBook(book) === 'public') return 'public'
  return effectiveVisibility({
    collection,
    volume,
    series,
    book: book ? { ...book, visibility: visibilityForBook(book) } : null,
  })
}

export const hierarchyIsActive = ({
  collection = null,
  volume = null,
  series = null,
  book = null,
} = {}) => {
  return [collection, volume, series, book].every((item) => !item || isActive(item))
}

export const hierarchyIsComplete = ({
  collection = null,
  volume = null,
  series = null,
  book = null,
} = {}) => {
  if (book) return Boolean(collection && volume && series)
  if (series) return Boolean(collection && volume)
  if (volume) return Boolean(collection)
  return Boolean(collection)
}

export const canDiscoverContent = ({
  collection = null,
  volume = null,
  series = null,
  book = null,
} = {}, context = {}) => {
  if (!collection && !volume && !series && !book) return false
  if (!hierarchyIsComplete({ collection, volume, series, book })) return false
  if (!hierarchyIsActive({ collection, volume, series, book })) return false
  if (isAdminRole(context.role)) return true
  return effectiveVisibility({ collection, volume, series, book }) !== 'private'
}

export const isGrantCurrent = (grant) => {
  if (!grant) return false
  if (grant.is_visible !== true || grant.can_read !== true) return false
  if (!grant.expires_at) return true

  const expiresAt = Date.parse(grant.expires_at)
  return Number.isFinite(expiresAt) && expiresAt > Date.now()
}

export const hasBookEntitlement = (book, grants = []) => {
  if (!book?.id) return false
  return grants.some((grant) => grant.book_id === book.id && isGrantCurrent(grant))
}

const idsMatch = (left, right) => String(left ?? '') === String(right ?? '')

export const isTrustedPaidOrder = (order) => {
  return String(order?.status || '').trim().toLowerCase() === 'paid'
}

const paidOrderType = (order) => {
  const explicitType = String(order?.purchase_type || '').trim().toLowerCase()
  if (['book', 'series', 'collection'].includes(explicitType)) return explicitType

  const populatedTargets = ['book', 'series', 'collection']
    .filter((type) => order?.[`${type}_id`] != null && String(order[`${type}_id`]).trim())
  return populatedTargets.length === 1 ? populatedTargets[0] : ''
}

export const hasPaidOrderForProduct = ({ purchaseType, targetId } = {}, paidOrders = []) => {
  const type = String(purchaseType || '').trim().toLowerCase()
  if (!['book', 'series', 'collection'].includes(type) || !targetId) return false

  return paidOrders.some((order) => {
    return isTrustedPaidOrder(order)
      && paidOrderType(order) === type
      && idsMatch(order[`${type}_id`], targetId)
  })
}

export const hasInheritedPaidOrderEntitlement = ({
  collection = null,
  series = null,
  book = null,
} = {}, paidOrders = []) => {
  return hasPaidOrderForProduct({ purchaseType: 'book', targetId: book?.id }, paidOrders)
    || hasPaidOrderForProduct({ purchaseType: 'series', targetId: series?.id }, paidOrders)
    || hasPaidOrderForProduct({ purchaseType: 'collection', targetId: collection?.id }, paidOrders)
}

export const isPassActivationCurrent = (activation) => {
  const expiresAt = Date.parse(activation?.expires_at || '')
  return Number.isFinite(expiresAt) && expiresAt > Date.now()
}

export const passCoversHierarchy = (pass, { collection = null } = {}) => {
  if (!pass?.id) return false
  if (pass.scope_type === 'library') return true
  return pass.scope_type === 'collection' && idsMatch(pass.collection_id, collection?.id)
}

export const hasActivePassEntitlement = (hierarchy = {}, passes = [], activations = []) => {
  const activePassIds = new Set(
    activations.filter(isPassActivationCurrent).map((activation) => String(activation.pass_id))
  )
  return passes.some((pass) => activePassIds.has(String(pass.id)) && passCoversHierarchy(pass, hierarchy))
}

export const canReadBook = ({
  collection = null,
  volume = null,
  series = null,
  book = null,
  grants = [],
  paidOrders = [],
  accessPasses = [],
  passActivations = [],
} = {}, context = {}) => {
  if (!book) return false
  if (!hierarchyIsComplete({ collection, volume, series, book })
      || !hierarchyIsActive({ collection, volume, series, book })) return false
  if (visibilityForBook(book) === 'public') return true
  if (isAdminRole(context.role)) {
    return true
  }
  if (!canDiscoverContent({ collection, volume, series, book }, context)) return false

  const bookVisibility = effectiveVisibilityForBookHierarchy({ collection, volume, series, book })

  if (bookVisibility === 'public') return true
  if (!context.user?.id) return false

  return hasBookEntitlement(book, grants)
    || hasInheritedPaidOrderEntitlement({ collection, series, book }, paidOrders)
    || hasActivePassEntitlement({ collection, volume, series, book }, accessPasses, passActivations)
}

export const mapById = (items = []) => new Map(items.map((item) => [item.id, item]))

const uniqueIds = (items = []) => [...new Set(items.filter(Boolean))]

export const collectionForSeries = (series, collections = []) => {
  if (!series?.collection_id) return null
  return mapById(collections).get(series.collection_id) || null
}

export const collectionForVolume = (volume, collections = []) => {
  if (!volume?.collection_id) return null
  return mapById(collections).get(volume.collection_id) || null
}

export const volumeForSeries = (series, volumes = []) => {
  if (!series?.volume_id) return null
  return mapById(volumes).get(series.volume_id) || null
}

export const seriesForBook = (book, seriesItems = []) => {
  if (!book?.series_id) return null
  return mapById(seriesItems).get(book.series_id) || null
}

export const hierarchyForBook = (book, seriesItems = [], collections = [], volumes = []) => {
  const series = seriesForBook(book, seriesItems)
  const volume = volumeForSeries(series, volumes)
  const collection = collectionForSeries(series, collections) || collectionForVolume(volume, collections)
  return { collection, volume, series, book }
}

export const eligibleBooksForPurchase = ({ purchaseType, targetId } = {}, hierarchy = {}) => {
  const type = String(purchaseType || '').trim().toLowerCase()
  if (!['book', 'series', 'collection'].includes(type) || !targetId) return []

  return (hierarchy.books || [])
    .map((book) => hierarchyForBook(
      book,
      hierarchy.seriesItems || [],
      hierarchy.collections || [],
      hierarchy.volumes || []
    ))
    .filter((item) => hierarchyIsComplete(item) && hierarchyIsActive(item))
    .filter((item) => effectiveVisibilityForBookHierarchy(item) !== 'private')
    .filter((item) => {
      if (type === 'book') return idsMatch(item.book?.id, targetId)
      if (type === 'series') return idsMatch(item.series?.id, targetId)
      return idsMatch(item.collection?.id, targetId)
    })
}

export const purchaseEntitlementDetails = (
  purchase,
  hierarchy = {},
  grants = [],
  context = {},
  paidOrders = [],
  accessPasses = [],
  passActivations = []
) => {
  if (isAdminRole(context.role)) return { entitled: true, reason: 'admin' }

  const purchaseType = String(purchase?.purchaseType || '').trim().toLowerCase()
  const targetId = purchase?.targetId
  if (!['book', 'series', 'collection'].includes(purchaseType) || !targetId) {
    return { entitled: false, reason: 'invalid' }
  }

  if (purchaseType === 'book') {
    const [bookHierarchy] = eligibleBooksForPurchase(purchase, hierarchy)
    if (!bookHierarchy) return { entitled: false, reason: 'not_entitled' }
    const { book, series, collection } = bookHierarchy
    if (visibilityForBook(book) === 'public') return { entitled: true, reason: 'public' }
    if (hasPaidOrderForProduct({ purchaseType: 'book', targetId: book.id }, paidOrders)
        || hasPaidOrderForProduct({ purchaseType: 'series', targetId: series?.id }, paidOrders)
        || hasPaidOrderForProduct({ purchaseType: 'collection', targetId: collection?.id }, paidOrders)) {
      return { entitled: true, reason: 'paid' }
    }
    if (hasBookEntitlement(book, grants)) return { entitled: true, reason: 'owner_grant' }
    if (hasActivePassEntitlement(bookHierarchy, accessPasses, passActivations)) return { entitled: true, reason: 'temporary_pass' }
    if (effectiveVisibilityForBookHierarchy(bookHierarchy) === 'public') return { entitled: true, reason: 'public' }
    return { entitled: false, reason: 'not_entitled' }
  }

  if (purchaseType === 'collection') {
    const collection = (hierarchy.collections || []).find((item) => idsMatch(item.id, targetId))
    const entitled = hasPaidOrderForProduct(purchase, paidOrders)
      || hasActivePassEntitlement({ collection }, accessPasses, passActivations)
    return { entitled, reason: entitled ? (hasPaidOrderForProduct(purchase, paidOrders) ? 'paid' : 'temporary_pass') : 'not_entitled' }
  }

  const series = (hierarchy.seriesItems || []).find((item) => idsMatch(item.id, targetId))
  if (!series) return { entitled: false, reason: 'not_entitled' }
  const volume = volumeForSeries(series, hierarchy.volumes || [])
  const collection = collectionForSeries(series, hierarchy.collections || [])
    || collectionForVolume(volume, hierarchy.collections || [])

  if (hasPaidOrderForProduct(purchase, paidOrders)
      || hasPaidOrderForProduct({ purchaseType: 'collection', targetId: collection?.id }, paidOrders)) {
    return { entitled: true, reason: 'paid' }
  }

  if (hasActivePassEntitlement({ collection, volume, series }, accessPasses, passActivations)) {
    return { entitled: true, reason: 'temporary_pass' }
  }

  const eligibleBooks = eligibleBooksForPurchase(purchase, hierarchy)
  const fullyGranted = eligibleBooks.length > 0
    && eligibleBooks.every((item) => hasBookEntitlement(item.book, grants))
  return { entitled: fullyGranted, reason: fullyGranted ? 'owner_grant' : 'not_entitled' }
}

export const hasEffectivePurchaseEntitlement = (...args) => purchaseEntitlementDetails(...args).entitled

export const filterDiscoverableBooks = (books = [], seriesItems = [], collections = [], volumes = [], context = {}) => {
  return books.filter((book) => canDiscoverContent(hierarchyForBook(book, seriesItems, collections, volumes), context))
}

export const filterDiscoverableSeries = (seriesItems = [], collections = [], volumes = [], context = {}) => {
  return seriesItems.filter((series) => canDiscoverContent({
    collection: collectionForSeries(series, collections),
    volume: volumeForSeries(series, volumes),
    series,
  }, context))
}

export const fetchViewerBookGrants = async (userId) => {
  if (!userId) return { data: [], error: null }

  const { data, error } = await supabase
    .from('book_access')
    .select('user_id, book_id, access_type, granted_at, expires_at, is_visible, can_read')
    .eq('user_id', userId)
    .order('granted_at', { ascending: false })

  return { data: data || [], error }
}

export const fetchViewerPaidOrders = async (userId) => {
  if (!userId) return { data: [], error: null }

  const { data, error } = await supabase
    .from('orders')
    .select(PAID_ORDER_SELECT)
    .eq('user_id', userId)
    .eq('status', 'paid')
    .order('paid_at', { ascending: false })

  return { data: data || [], error }
}

export const fetchActiveAccessPasses = async () => {
  const { data, error } = await supabase
    .from('temporary_access_passes')
    .select(ACCESS_PASS_SELECT)
    .eq('active', true)
    .order('created_at', { ascending: true })

  return { data: data || [], error }
}

export const fetchViewerPassActivations = async (userId) => {
  if (!userId) return { data: [], error: null }

  const { data, error } = await supabase
    .from('temporary_access_pass_activations')
    .select(PASS_ACTIVATION_SELECT)
    .eq('user_id', userId)
    .gt('expires_at', new Date().toISOString())

  return { data: data || [], error }
}

export const fetchContentHierarchy = async () => {
  const [collectionsResult, volumesResult, seriesResult, booksResult] = await Promise.all([
    supabase
      .from('collections')
      .select(COLLECTION_SELECT)
      .order('sort_order', { ascending: true })
      .order('title', { ascending: true }),
    supabase
      .from('volumes')
      .select(VOLUME_SELECT)
      .order('sort_order', { ascending: true })
      .order('title', { ascending: true }),
    supabase
      .from('series')
      .select(SERIES_SELECT)
      .order('sort_order', { ascending: true })
      .order('title', { ascending: true }),
    supabase
      .from('books')
      .select(BOOK_SELECT)
      .order('series', { ascending: true })
      .order('book_number', { ascending: true }),
  ])

  return {
    collections: collectionsResult.data || [],
    volumes: volumesResult.data || [],
    seriesItems: seriesResult.data || [],
    books: booksResult.data || [],
    errors: {
      collections: collectionsResult.error,
      volumes: volumesResult.error,
      series: seriesResult.error,
      books: booksResult.error,
    },
  }
}

const snapshotOwnership = (paidOrders = []) => {
  const ownedBookIds = new Set()
  const ownedSeriesIds = new Set()
  const ownedCollectionIds = new Set()

  paidOrders.filter(isTrustedPaidOrder).forEach((order) => {
    const type = paidOrderType(order)
    const targetId = order?.[`${type}_id`]
    if (!targetId) return
    if (type === 'book') ownedBookIds.add(String(targetId))
    if (type === 'series') ownedSeriesIds.add(String(targetId))
    if (type === 'collection') ownedCollectionIds.add(String(targetId))
  })

  return { ownedBookIds, ownedSeriesIds, ownedCollectionIds }
}

export const invalidateEntitlementSnapshot = (reason = 'manual') => {
  entitlementSnapshotVersion += 1
  entitlementSnapshot = null
  entitlementSnapshotPromise = null
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('greyveil:entitlements-invalidated', {
      detail: { reason, version: entitlementSnapshotVersion },
    }))
  }
}

export const getEntitlementSnapshot = async ({ force = false } = {}) => {
  if (force) invalidateEntitlementSnapshot('force-refresh')
  if (entitlementSnapshot) return entitlementSnapshot
  if (entitlementSnapshotPromise) return entitlementSnapshotPromise

  const requestedVersion = entitlementSnapshotVersion
  const requestedAuthGeneration = entitlementAuthGeneration
  const requestPromise = (async () => {
    const [context, hierarchy, accessPassesResult] = await Promise.all([
      getAccessContext(),
      fetchContentHierarchy(),
      fetchActiveAccessPasses(),
    ])
    const hierarchyErrors = Object.entries(hierarchy.errors || {}).filter(([, error]) => error)
    if (hierarchyErrors.length) {
      const error = new Error('Content hierarchy could not be resolved.')
      error.sources = hierarchyErrors
      throw error
    }

    const [grantsResult, paidOrdersResult, passActivationsResult] = context.user?.id && !context.isAdmin
      ? await Promise.all([
        fetchViewerBookGrants(context.user.id),
        fetchViewerPaidOrders(context.user.id),
        fetchViewerPassActivations(context.user.id),
      ])
      : [{ data: [], error: null }, { data: [], error: null }, { data: [], error: null }]

    if (grantsResult.error || paidOrdersResult.error || passActivationsResult.error) {
      const error = new Error('Account access could not be resolved.')
      error.sources = [
        ...(grantsResult.error ? [['book_access', grantsResult.error]] : []),
        ...(paidOrdersResult.error ? [['orders', paidOrdersResult.error]] : []),
        ...(passActivationsResult.error ? [['temporary_access_pass_activations', passActivationsResult.error]] : []),
      ]
      throw error
    }

    const grants = grantsResult.data || []
    const paidOrders = paidOrdersResult.data || []
    const directBookIds = new Set(
      grants.filter(isGrantCurrent).map((grant) => String(grant.book_id))
    )
    if (requestedVersion !== entitlementSnapshotVersion
        || requestedAuthGeneration !== entitlementAuthGeneration) {
      return getEntitlementSnapshot()
    }
    const snapshot = {
      version: requestedVersion,
      authGeneration: requestedAuthGeneration,
      ownerKey: context.user?.id ? String(context.user.id) : 'guest',
      context,
      hierarchy,
      grants,
      paidOrders,
      accessPasses: accessPassesResult.error ? [] : accessPassesResult.data || [],
      passActivations: passActivationsResult.data || [],
      directBookIds,
      ...snapshotOwnership(paidOrders),
    }

    entitlementSnapshot = snapshot
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('greyveil:entitlements-ready', {
        detail: { snapshot },
      }))
    }
    return snapshot
  })()
  entitlementSnapshotPromise = requestPromise

  try {
    return await requestPromise
  } finally {
    if (entitlementSnapshotPromise === requestPromise) entitlementSnapshotPromise = null
  }
}

supabase.auth?.onAuthStateChange?.(() => {
  entitlementAuthGeneration += 1
  invalidateEntitlementSnapshot('auth-change')
})

if (typeof window !== 'undefined') {
  window.addEventListener('greyveil:access-changed', () => invalidateEntitlementSnapshot('access-change'))
  window.addEventListener('greyveil:role-changed', () => invalidateEntitlementSnapshot('role-change'))
  window.addEventListener('greyveil:profile-changed', () => invalidateEntitlementSnapshot('profile-change'))
}

export const fetchHierarchyForBooks = async (bookIds = []) => {
  const ids = uniqueIds(bookIds)
  if (!ids.length) {
    return {
      collections: [],
      volumes: [],
      seriesItems: [],
      books: [],
      errors: {
        collections: null,
        volumes: null,
        series: null,
        books: null,
      },
    }
  }

  const booksResult = await supabase
    .from('books')
    .select(BOOK_SELECT)
    .in('id', ids)
    .order('series', { ascending: true })
    .order('book_number', { ascending: true })

  if (booksResult.error) {
    return {
      collections: [],
      volumes: [],
      seriesItems: [],
      books: [],
      errors: {
        collections: null,
        volumes: null,
        series: null,
        books: booksResult.error,
      },
    }
  }

  const books = booksResult.data || []
  const seriesIds = uniqueIds(books.map((book) => book.series_id))
  const seriesResult = seriesIds.length
    ? await supabase
      .from('series')
      .select(SERIES_SELECT)
      .in('id', seriesIds)
      .order('sort_order', { ascending: true })
      .order('title', { ascending: true })
    : { data: [], error: null }

  const seriesItems = seriesResult.data || []
  const volumeIds = uniqueIds(seriesItems.map((series) => series.volume_id))
  const collectionIdsFromSeries = uniqueIds(seriesItems.map((series) => series.collection_id))
  const volumesResult = volumeIds.length
    ? await supabase
      .from('volumes')
      .select(VOLUME_SELECT)
      .in('id', volumeIds)
      .order('sort_order', { ascending: true })
      .order('title', { ascending: true })
    : { data: [], error: null }

  const volumes = volumesResult.data || []
  const collectionIds = uniqueIds([
    ...collectionIdsFromSeries,
    ...volumes.map((volume) => volume.collection_id),
  ])
  const collectionsResult = collectionIds.length
    ? await supabase
      .from('collections')
      .select(COLLECTION_SELECT)
      .in('id', collectionIds)
      .order('sort_order', { ascending: true })
      .order('title', { ascending: true })
    : { data: [], error: null }

  return {
    collections: collectionsResult.data || [],
    volumes,
    seriesItems,
    books,
    errors: {
      collections: collectionsResult.error,
      volumes: volumesResult.error,
      series: seriesResult.error,
      books: booksResult.error,
    },
  }
}

export const fetchHierarchyForBookSlug = async (bookSlug) => {
  const slug = String(bookSlug || '').trim()
  if (!slug) {
    return {
      collections: [],
      volumes: [],
      seriesItems: [],
      books: [],
      errors: {
        collections: null,
        volumes: null,
        series: null,
        books: null,
      },
    }
  }

  const bookResult = await supabase
    .from('books')
    .select(BOOK_SELECT)
    .eq('slug', slug)
    .maybeSingle()

  if (bookResult.error || !bookResult.data) {
    return {
      collections: [],
      volumes: [],
      seriesItems: [],
      books: bookResult.data ? [bookResult.data] : [],
      errors: {
        collections: null,
        volumes: null,
        series: null,
        books: bookResult.error,
      },
    }
  }

  return fetchHierarchyForBooks([bookResult.data.id])
}

export const resolveReaderAccess = async (bookSlug) => {
  const hierarchy = await fetchHierarchyForBookSlug(bookSlug)
  const errors = Object.entries(hierarchy.errors || {}).filter(([, error]) => error)
  const guestContext = { user: null, profile: null, role: 'guest', isAdmin: false, displayName: 'Reader' }

  if (errors.length) {
    return {
      allowed: false,
      reason: 'unavailable',
      context: guestContext,
      hierarchy,
      errors,
    }
  }

  const book = hierarchy.books.find((item) => item.slug === bookSlug)
  if (!book) {
    return {
      allowed: false,
      reason: 'unavailable',
      context: guestContext,
      hierarchy,
      errors: [],
    }
  }

  const bookHierarchy = hierarchyForBook(book, hierarchy.seriesItems, hierarchy.collections, hierarchy.volumes)
  const complete = hierarchyIsComplete(bookHierarchy)
  const active = hierarchyIsActive(bookHierarchy)
  const visibility = effectiveVisibilityForBookHierarchy(bookHierarchy)

  if (!complete || !active) {
    return {
      allowed: false,
      reason: 'unavailable',
      context: guestContext,
      hierarchy,
      book,
      bookHierarchy,
      visibility,
      errors: [],
    }
  }

  if (visibilityForBook(book) === 'public') {
    return {
      allowed: true,
      reason: 'public',
      context: guestContext,
      hierarchy,
      book,
      bookHierarchy,
      visibility: 'public',
      grants: [],
      errors: [],
    }
  }

  const context = await getAccessContext()

  if (isAdminRole(context.role)) {
    return {
      allowed: true,
      reason: 'admin',
      context,
      hierarchy,
      book,
      bookHierarchy,
      visibility,
      grants: [],
      errors: [],
    }
  }

  if (visibility === 'private') {
    return {
      allowed: false,
      reason: 'unavailable',
      context,
      hierarchy,
      book,
      bookHierarchy,
      visibility,
      errors: [],
    }
  }

  if (!context.user?.id) {
    return {
      allowed: false,
      reason: 'login_required',
      context,
      hierarchy,
      book,
      bookHierarchy,
      visibility,
      errors: [],
    }
  }

  const [grantsResult, paidOrdersResult] = await Promise.all([
    fetchViewerBookGrants(context.user.id),
    fetchViewerPaidOrders(context.user.id),
  ])
  if (grantsResult.error || paidOrdersResult.error) {
    return {
      allowed: false,
      reason: 'access_required',
      context,
      hierarchy,
      book,
      bookHierarchy,
      visibility,
      grants: [],
      paidOrders: [],
      errors: [
        ...(grantsResult.error ? [['book_access', grantsResult.error]] : []),
        ...(paidOrdersResult.error ? [['orders', paidOrdersResult.error]] : []),
      ],
    }
  }

  const grants = grantsResult.data || []
  const paidOrders = paidOrdersResult.data || []
  const entitled = hasBookEntitlement(book, grants)
    || hasInheritedPaidOrderEntitlement(bookHierarchy, paidOrders)
  return {
    allowed: entitled,
    reason: entitled ? 'entitled' : 'access_required',
    context,
    hierarchy,
    book,
    bookHierarchy,
    visibility,
    grants,
    paidOrders,
    errors: [],
  }
}
