import { supabase } from './supabase-client.js'
import { getCurrentProfile, getCurrentUser } from './auth.js'

export const ADMIN_ROLES = new Set(['admin', 'super_admin'])
export const VISIBILITY_STATES = ['public', 'paid', 'private']

const DEFAULT_VISIBILITY = 'paid'

export const isAdminRole = (role) => ADMIN_ROLES.has(role)

export const normalizeVisibility = (value, fallback = DEFAULT_VISIBILITY) => {
  const visibility = value == null ? '' : String(value).trim().toLowerCase()
  return VISIBILITY_STATES.includes(visibility) ? visibility : fallback
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

export const hierarchyIsActive = ({ collection = null, series = null, book = null } = {}) => {
  return [collection, series, book].every((item) => !item || isActive(item))
}

export const canDiscoverContent = ({ collection = null, series = null, book = null } = {}, context = {}) => {
  if (isAdminRole(context.role)) return true
  if (!hierarchyIsActive({ collection, series, book })) return false
  return !hasPrivateVisibility(collection, series, book)
}

export const isGrantCurrent = (grant) => {
  if (!grant) return false
  if (grant.is_visible === false || grant.can_read === false) return false
  if (!grant.expires_at) return true

  const expiresAt = Date.parse(grant.expires_at)
  return Number.isFinite(expiresAt) && expiresAt > Date.now()
}

export const hasBookEntitlement = (book, grants = []) => {
  if (!book?.id) return false
  return grants.some((grant) => grant.book_id === book.id && isGrantCurrent(grant))
}

export const canReadBook = ({ collection = null, series = null, book = null, grants = [] } = {}, context = {}) => {
  if (!book) return false
  if (isAdminRole(context.role)) return isActive(book)
  if (!canDiscoverContent({ collection, series, book }, context)) return false

  const bookVisibility = normalizeVisibility(
    book.visibility,
    book.is_public === true ? 'public' : DEFAULT_VISIBILITY
  )

  if (bookVisibility === 'public') return true
  if (!context.user?.id) return false

  return hasBookEntitlement(book, grants)
}

export const mapById = (items = []) => new Map(items.map((item) => [item.id, item]))

export const collectionForSeries = (series, collections = []) => {
  if (!series?.collection_id) return null
  return mapById(collections).get(series.collection_id) || null
}

export const seriesForBook = (book, seriesItems = []) => {
  if (!book?.series_id) return null
  return mapById(seriesItems).get(book.series_id) || null
}

export const hierarchyForBook = (book, seriesItems = [], collections = []) => {
  const series = seriesForBook(book, seriesItems)
  const collection = collectionForSeries(series, collections)
  return { collection, series, book }
}

export const filterDiscoverableBooks = (books = [], seriesItems = [], collections = [], context = {}) => {
  return books.filter((book) => canDiscoverContent(hierarchyForBook(book, seriesItems, collections), context))
}

export const filterDiscoverableSeries = (seriesItems = [], collections = [], context = {}) => {
  return seriesItems.filter((series) => canDiscoverContent({
    collection: collectionForSeries(series, collections),
    series,
  }, context))
}

export const fetchViewerBookGrants = async (userId) => {
  if (!userId) return { data: [], error: null }

  const { data, error } = await supabase
    .from('book_access')
    .select('user_id, book_id, expires_at, is_visible, can_read')
    .eq('user_id', userId)

  return { data: data || [], error }
}

export const fetchContentHierarchy = async () => {
  const [collectionsResult, seriesResult, booksResult] = await Promise.all([
    supabase
      .from('collections')
      .select('id, slug, title, description, visibility, is_active, sort_order, created_at, updated_at')
      .order('sort_order', { ascending: true })
      .order('title', { ascending: true }),
    supabase
      .from('series')
      .select('id, collection_id, slug, title, description, visibility, is_active, sort_order, created_at, updated_at')
      .order('sort_order', { ascending: true })
      .order('title', { ascending: true }),
    supabase
      .from('books')
      .select('id, title, series, book_number, slug, visibility, series_id, is_public, is_active')
      .order('series', { ascending: true })
      .order('book_number', { ascending: true }),
  ])

  return {
    collections: collectionsResult.data || [],
    seriesItems: seriesResult.data || [],
    books: booksResult.data || [],
    errors: {
      collections: collectionsResult.error,
      series: seriesResult.error,
      books: booksResult.error,
    },
  }
}
