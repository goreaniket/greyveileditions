import { supabase } from './supabase-client.js'
import { getCurrentProfile, getCurrentUser } from './auth.js'

export const ADMIN_ROLES = new Set(['admin', 'super_admin'])
export const VISIBILITY_STATES = ['public', 'paid', 'private']

const DEFAULT_VISIBILITY = 'paid'
const COLLECTION_SELECT = 'id, slug, title, description, visibility, is_active, sort_order, created_at, updated_at'
const VOLUME_SELECT = 'id, collection_id, slug, title, description, visibility, is_active, sort_order, created_at, updated_at'
const SERIES_SELECT = 'id, collection_id, volume_id, slug, title, description, visibility, is_active, sort_order, created_at, updated_at'
const BOOK_SELECT = 'id, title, series, book_number, slug, visibility, series_id, is_public, is_active'

export const isAdminRole = (role) => ADMIN_ROLES.has(role)

export const normalizeVisibility = (value, fallback = DEFAULT_VISIBILITY) => {
  const visibility = value == null ? '' : String(value).trim().toLowerCase()
  return VISIBILITY_STATES.includes(visibility) ? visibility : fallback
}

export const visibilityForBook = (book) => {
  return normalizeVisibility(book?.visibility, book?.is_public === true ? 'public' : DEFAULT_VISIBILITY)
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

export const canReadBook = ({
  collection = null,
  volume = null,
  series = null,
  book = null,
  grants = [],
} = {}, context = {}) => {
  if (!book) return false
  if (isAdminRole(context.role)) {
    return hierarchyIsComplete({ collection, volume, series, book })
      && hierarchyIsActive({ collection, volume, series, book })
  }
  if (!canDiscoverContent({ collection, volume, series, book }, context)) return false

  const bookVisibility = effectiveVisibilityForBookHierarchy({ collection, volume, series, book })

  if (bookVisibility === 'public') return true
  if (!context.user?.id) return false

  return hasBookEntitlement(book, grants)
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

const idsMatch = (left, right) => String(left ?? '') === String(right ?? '')

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

export const hasEffectivePurchaseEntitlement = (
  purchase,
  hierarchy = {},
  grants = [],
  context = {}
) => {
  if (isAdminRole(context.role)) return true

  const eligibleBooks = eligibleBooksForPurchase(purchase, hierarchy)
  return eligibleBooks.length > 0 && eligibleBooks.every((item) => canReadBook({
    ...item,
    grants,
  }, context))
}

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
  const context = await getAccessContext()
  const hierarchy = await fetchHierarchyForBookSlug(bookSlug)
  const errors = Object.entries(hierarchy.errors || {}).filter(([, error]) => error)

  if (errors.length) {
    return {
      allowed: false,
      reason: 'unavailable',
      context,
      hierarchy,
      errors,
    }
  }

  const book = hierarchy.books.find((item) => item.slug === bookSlug)
  if (!book) {
    return {
      allowed: false,
      reason: 'unavailable',
      context,
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
      context,
      hierarchy,
      book,
      bookHierarchy,
      visibility,
      errors: [],
    }
  }

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

  if (visibility === 'public') {
    return {
      allowed: true,
      reason: 'public',
      context,
      hierarchy,
      book,
      bookHierarchy,
      visibility,
      grants: [],
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

  const grantsResult = await fetchViewerBookGrants(context.user.id)
  if (grantsResult.error) {
    return {
      allowed: false,
      reason: 'access_required',
      context,
      hierarchy,
      book,
      bookHierarchy,
      visibility,
      grants: [],
      errors: [['book_access', grantsResult.error]],
    }
  }

  const grants = grantsResult.data || []
  return {
    allowed: hasBookEntitlement(book, grants),
    reason: hasBookEntitlement(book, grants) ? 'entitled' : 'access_required',
    context,
    hierarchy,
    book,
    bookHierarchy,
    visibility,
    grants,
    errors: [],
  }
}
