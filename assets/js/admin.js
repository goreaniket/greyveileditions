import { supabase } from './supabase-client.js'
import { getCurrentUser, signOut } from './auth.js'
import { effectiveVisibility, hierarchyForBook, hierarchyIsActive, hierarchyIsComplete, normalizeVisibility, VISIBILITY_STATES } from './content-access.js'

const ADMIN_ROLES = new Set(['admin', 'super_admin'])
const STATUS_OPTIONS = ['new', 'reviewed', 'archived']
const ACCESS_TYPES = ['manual', 'promotion', 'complimentary', 'purchase']
const LOGIN_PATH = '/auth/login/'
const ACCOUNT_PATH = '/account/'

const selectors = {
  loading: '[data-admin-loading]',
  locked: '[data-admin-locked]',
  lockedMessage: '[data-admin-locked-message]',
  app: '[data-admin-app]',
  alerts: '[data-admin-alerts]',
  name: '[data-admin-name]',
  role: '[data-admin-role]',
  logout: '[data-admin-logout]',
  refresh: '[data-admin-refresh]',
  menu: '[data-admin-menu]',
  navButtons: '[data-admin-tab]',
  tabLinks: '[data-admin-tab-link]',
  panels: '[data-admin-panel]',
  userSearch: '[data-user-search]',
  userRole: '[data-user-role]',
  usersTable: '[data-users-table]',
  usersEmpty: '[data-users-empty]',
  collectionForm: '[data-collection-form]',
  collectionStatus: '[data-collection-status]',
  collectionsTable: '[data-collections-table]',
  collectionsEmpty: '[data-collections-empty]',
  collectionsCount: '[data-collections-count]',
  volumeForm: '[data-volume-form]',
  volumeStatus: '[data-volume-status]',
  volumeCollectionSelect: '[data-volume-collection-select]',
  volumesTable: '[data-volumes-table]',
  volumesEmpty: '[data-volumes-empty]',
  volumesCount: '[data-volumes-count]',
  seriesForm: '[data-series-form]',
  seriesStatus: '[data-series-status]',
  seriesCollectionSelect: '[data-series-collection-select]',
  seriesVolumeSelect: '[data-series-volume-select]',
  seriesTable: '[data-series-table]',
  seriesEmpty: '[data-series-empty]',
  seriesCount: '[data-series-count]',
  hierarchyTree: '[data-content-hierarchy]',
  hierarchyEmpty: '[data-hierarchy-empty]',
  booksTable: '[data-books-table]',
  booksEmpty: '[data-books-empty]',
  booksCount: '[data-books-count]',
  accessForm: '[data-access-form]',
  accessUserSearch: '[data-access-user-search]',
  accessUser: '[data-access-user]',
  accessBook: '[data-access-book]',
  accessType: '[data-access-type]',
  accessVisible: '[data-access-visible]',
  accessCanRead: '[data-access-can-read]',
  accessExpires: '[data-access-expires]',
  accessFormStatus: '[data-access-form-status]',
  accessTable: '[data-access-table]',
  accessEmpty: '[data-access-empty]',
  feedbackSearch: '[data-feedback-search]',
  feedbackStatus: '[data-feedback-status-filter]',
  feedbackRating: '[data-feedback-rating-filter]',
  feedbackSeries: '[data-feedback-series-filter]',
  feedbackBook: '[data-feedback-book-filter]',
  feedbackList: '[data-feedback-list]',
  feedbackEmpty: '[data-feedback-empty]',
  recentFeedback: '[data-recent-feedback]',
  recentUsers: '[data-recent-users]',
  accessStatus: '[data-access-status]',
}

const state = {
  user: null,
  profile: null,
  users: [],
  collections: [],
  volumes: [],
  seriesItems: [],
  books: [],
  feedbacks: [],
  accessGrants: [],
  counts: {
    users: null,
    books: null,
    feedbacks: null,
    accessGrants: null,
  },
  errors: {},
}

const $ = (selector, root = document) => root.querySelector(selector)
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector))

const singleNodes = {
  loading: $(selectors.loading),
  locked: $(selectors.locked),
  lockedMessage: $(selectors.lockedMessage),
  app: $(selectors.app),
  alerts: $(selectors.alerts),
  name: $(selectors.name),
  role: $(selectors.role),
  logout: $(selectors.logout),
  refresh: $(selectors.refresh),
  menu: $(selectors.menu),
  userSearch: $(selectors.userSearch),
  userRole: $(selectors.userRole),
  usersTable: $(selectors.usersTable),
  usersEmpty: $(selectors.usersEmpty),
  collectionForm: $(selectors.collectionForm),
  collectionStatus: $(selectors.collectionStatus),
  collectionsTable: $(selectors.collectionsTable),
  collectionsEmpty: $(selectors.collectionsEmpty),
  collectionsCount: $(selectors.collectionsCount),
  volumeForm: $(selectors.volumeForm),
  volumeStatus: $(selectors.volumeStatus),
  volumeCollectionSelect: $(selectors.volumeCollectionSelect),
  volumesTable: $(selectors.volumesTable),
  volumesEmpty: $(selectors.volumesEmpty),
  volumesCount: $(selectors.volumesCount),
  seriesForm: $(selectors.seriesForm),
  seriesStatus: $(selectors.seriesStatus),
  seriesCollectionSelect: $(selectors.seriesCollectionSelect),
  seriesVolumeSelect: $(selectors.seriesVolumeSelect),
  seriesTable: $(selectors.seriesTable),
  seriesEmpty: $(selectors.seriesEmpty),
  seriesCount: $(selectors.seriesCount),
  hierarchyTree: $(selectors.hierarchyTree),
  hierarchyEmpty: $(selectors.hierarchyEmpty),
  booksTable: $(selectors.booksTable),
  booksEmpty: $(selectors.booksEmpty),
  booksCount: $(selectors.booksCount),
  accessForm: $(selectors.accessForm),
  accessUserSearch: $(selectors.accessUserSearch),
  accessUser: $(selectors.accessUser),
  accessBook: $(selectors.accessBook),
  accessType: $(selectors.accessType),
  accessVisible: $(selectors.accessVisible),
  accessCanRead: $(selectors.accessCanRead),
  accessExpires: $(selectors.accessExpires),
  accessFormStatus: $(selectors.accessFormStatus),
  accessTable: $(selectors.accessTable),
  accessEmpty: $(selectors.accessEmpty),
  feedbackSearch: $(selectors.feedbackSearch),
  feedbackStatus: $(selectors.feedbackStatus),
  feedbackRating: $(selectors.feedbackRating),
  feedbackSeries: $(selectors.feedbackSeries),
  feedbackBook: $(selectors.feedbackBook),
  feedbackList: $(selectors.feedbackList),
  feedbackEmpty: $(selectors.feedbackEmpty),
  recentFeedback: $(selectors.recentFeedback),
  recentUsers: $(selectors.recentUsers),
  accessStatus: $(selectors.accessStatus),
}

const createNode = (tagName, className = '', text = '') => {
  const node = document.createElement(tagName)
  if (className) node.className = className
  if (text !== '') node.textContent = text
  return node
}

const clearNode = (node) => {
  if (!node) return
  while (node.firstChild) node.firstChild.remove()
}

const getText = (value, fallback = '-') => {
  const text = value == null ? '' : String(value).trim()
  return text || fallback
}

const formatRole = (role) => {
  if (role === 'super_admin') return 'Super Admin'
  if (role === 'admin') return 'Admin'
  if (role === 'customer') return 'Customer'
  return getText(role, 'Customer')
}

const displayNameFor = (user, profile) => {
  return profile?.display_name
    || user?.user_metadata?.display_name
    || user?.email?.split('@')[0]
    || 'Admin'
}

const normalize = (value) => getText(value, '').toLowerCase()

const formatDate = (value) => {
  if (!value) return '-'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return getText(value)

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date)
}

const parseFeedbackDate = (value) => {
  if (!value) return 0

  const isoTime = Date.parse(value)
  if (Number.isFinite(isoTime)) return isoTime

  const legacyMatch = String(value).trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/)
  if (!legacyMatch) return 0

  const [, day, month, year, hour = '0', minute = '0', second = '0'] = legacyMatch
  const legacyDate = new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second)
  )

  return Number.isNaN(legacyDate.getTime()) ? 0 : legacyDate.getTime()
}

const sortFeedbackNewestFirst = (feedbacks) => {
  return [...feedbacks].sort((a, b) => parseFeedbackDate(b['Date & time']) - parseFeedbackDate(a['Date & time']))
}

const boolLabel = (value) => {
  if (value === true) return 'Yes'
  if (value === false) return 'No'
  return '-'
}

const boolValueLabel = (value) => value === false ? 'Inactive' : 'Active'

const visibilityLabel = (value, fallback = 'paid') => {
  const visibility = normalizeVisibility(value, fallback)
  return visibility.charAt(0).toUpperCase() + visibility.slice(1)
}

const bookVisibility = (book) => {
  return normalizeVisibility(book?.visibility, book?.is_public === true ? 'public' : 'paid')
}

const toSortOrder = (value) => {
  const number = Number(value)
  return Number.isFinite(number) ? number : 0
}

const formValue = (formData, name) => String(formData.get(name) || '').trim()

const visibilitySelect = (value, dataset = {}) => {
  const select = document.createElement('select')
  select.className = 'admin-compact-control'
  Object.entries(dataset).forEach(([key, dataValue]) => {
    select.dataset[key] = dataValue
  })

  VISIBILITY_STATES.forEach((visibility) => {
    const option = document.createElement('option')
    option.value = visibility
    option.textContent = visibilityLabel(visibility)
    select.append(option)
  })

  select.value = normalizeVisibility(value)
  return select
}

const activeSelect = (value) => {
  const select = document.createElement('select')
  select.className = 'admin-compact-control'

  ;[
    ['true', 'Active'],
    ['false', 'Inactive'],
  ].forEach(([optionValue, label]) => {
    const option = document.createElement('option')
    option.value = optionValue
    option.textContent = label
    select.append(option)
  })

  select.value = value === false ? 'false' : 'true'
  return select
}

const toDateTimeLocal = (value) => {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''

  const localDate = new Date(date.getTime() - date.getTimezoneOffset() * 60000)
  return localDate.toISOString().slice(0, 16)
}

const fromDateTimeLocal = (value) => {
  if (!value) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

const boolFromSelect = (value) => value === 'true'

const accessFlagLabel = (value) => value === false ? 'OFF' : 'ON'

const isAccessActive = (grant) => {
  if (!grant?.expires_at) return true
  const expiresAt = Date.parse(grant.expires_at)
  return Number.isFinite(expiresAt) && expiresAt > Date.now()
}

const accessKey = (grant) => `${grant.user_id}::${grant.book_id}`

const bookForGrant = (grant) => state.books.find((book) => book.id === grant.book_id)

const accessGrantStatus = (grant) => {
  const book = bookForGrant(grant)

  if (book) {
    const hierarchy = hierarchyForBook(book, state.seriesItems, state.collections, state.volumes)
    if (!hierarchyIsComplete(hierarchy) || !hierarchyIsActive(hierarchy)) {
      return { label: 'BOOK DISABLED', className: 'admin-badge--disabled' }
    }
  }

  if (!book && grant.book_id) {
    return { label: 'BOOK DISABLED', className: 'admin-badge--disabled' }
  }

  if (!isAccessActive(grant)) {
    return { label: 'EXPIRED', className: 'admin-badge--expired' }
  }

  if (grant.is_visible === false) {
    return { label: 'HIDDEN', className: 'admin-badge--hidden' }
  }

  if (grant.can_read === false) {
    return { label: 'READ OFF', className: 'admin-badge--restricted' }
  }

  return { label: 'ACTIVE', className: 'admin-badge--active' }
}

const activeAccessGrantCount = () => {
  return state.accessGrants.filter((grant) => accessGrantStatus(grant).label === 'ACTIVE').length
}

const isPolicyError = (error) => {
  const message = normalize(error?.message)
  return error?.code === '42501'
    || message.includes('row-level security')
    || message.includes('permission denied')
}

const isSchemaError = (error) => {
  const message = normalize(error?.message)
  return error?.code === '42703'
    || error?.code === '42P01'
    || error?.code === 'PGRST205'
    || message.includes('could not find the table')
    || message.includes('could not find')
    || message.includes('does not exist')
    || message.includes('schema cache')
}

const describeError = (table, error, action = 'read') => {
  const kind = isPolicyError(error) ? 'RLS policy blocked' : 'Supabase query failed'
  const code = error?.code ? ` (${error.code})` : ''
  const message = error?.message ? `: ${error.message}` : '.'
  return `${table}: ${kind} ${action}${code}${message}`
}

const setTableError = (table, error, action = 'read') => {
  state.errors[table] = describeError(table, error, action)
  renderAlerts()
}

const clearTableError = (table) => {
  delete state.errors[table]
  renderAlerts()
}

const renderAlerts = () => {
  const alerts = singleNodes.alerts
  clearNode(alerts)
  if (!alerts) return

  Object.values(state.errors).forEach((message) => {
    const alert = createNode('p', 'admin-alert', message)
    alerts.append(alert)
  })
}

const setStat = (name, value) => {
  const node = $(`[data-stat="${name}"]`)
  if (node) node.textContent = value
}

const setStatsLoading = () => {
  ;['users', 'books', 'feedbacks', 'newFeedbacks', 'accessGrants'].forEach((name) => setStat(name, '-'))
}

const setFormStatus = (node, message = '', type = '') => {
  if (!node) return
  node.textContent = message
  node.dataset.status = type
}

const setSelectOptions = (select, values, defaultLabel) => {
  if (!select) return

  const current = select.value
  clearNode(select)
  const defaultOption = document.createElement('option')
  defaultOption.value = ''
  defaultOption.textContent = defaultLabel
  select.append(defaultOption)

  values.forEach((value) => {
    const option = document.createElement('option')
    option.value = value
    option.textContent = value
    select.append(option)
  })

  if (values.includes(current)) select.value = current
}

const uniqueValues = (items, getter) => {
  return [...new Set(items.map(getter).map((value) => getText(value, '')).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b))
}

const setItemOptions = (select, items, defaultLabel, getValue, getLabel) => {
  if (!select) return

  const current = select.value
  clearNode(select)
  const defaultOption = document.createElement('option')
  defaultOption.value = ''
  defaultOption.textContent = defaultLabel
  select.append(defaultOption)

  items.forEach((item) => {
    const option = document.createElement('option')
    option.value = getValue(item)
    option.textContent = getLabel(item)
    select.append(option)
  })

  if (items.some((item) => getValue(item) === current)) select.value = current
}

const profileLabel = (profile) => {
  const displayName = getText(profile.display_name, 'Unnamed reader')
  const id = getText(profile.id)
  return `${displayName} - ${id}`
}

const bookLabel = (book) => {
  const parts = [book.title, book.series, book.book_number].map((part) => getText(part, '')).filter(Boolean)
  return parts.join(' - ') || getText(book.id)
}

const showPanel = (name) => {
  $$(selectors.navButtons).forEach((button) => {
    const isActive = button.dataset.adminTab === name
    button.setAttribute('aria-selected', String(isActive))
  })

  $$(selectors.panels).forEach((panel) => {
    panel.classList.toggle('is-active', panel.dataset.adminPanel === name)
  })

  document.body.classList.remove('is-admin-nav-open')
  singleNodes.menu?.setAttribute('aria-expanded', 'false')
}

const bindControls = () => {
  $$(selectors.navButtons).forEach((button) => {
    button.addEventListener('click', () => showPanel(button.dataset.adminTab))
  })

  $$(selectors.tabLinks).forEach((button) => {
    button.addEventListener('click', () => showPanel(button.dataset.adminTabLink))
  })

  singleNodes.menu?.addEventListener('click', () => {
    const open = document.body.classList.toggle('is-admin-nav-open')
    singleNodes.menu.setAttribute('aria-expanded', String(open))
  })

  singleNodes.refresh?.addEventListener('click', () => loadAdminData())
  singleNodes.logout?.addEventListener('click', handleLogout)
  singleNodes.collectionForm?.addEventListener('submit', handleCreateCollection)
  singleNodes.volumeForm?.addEventListener('submit', handleCreateVolume)
  singleNodes.seriesForm?.addEventListener('submit', handleCreateSeries)
  singleNodes.seriesCollectionSelect?.addEventListener('change', renderSeriesVolumeOptions)
  singleNodes.accessForm?.addEventListener('submit', handleGrantAccess)
  singleNodes.accessUserSearch?.addEventListener('input', renderAccessUserOptions)

  ;[
    singleNodes.userSearch,
    singleNodes.userRole,
    singleNodes.feedbackSearch,
    singleNodes.feedbackStatus,
    singleNodes.feedbackRating,
    singleNodes.feedbackSeries,
    singleNodes.feedbackBook,
  ].forEach((control) => {
    control?.addEventListener('input', renderFilteredSections)
    control?.addEventListener('change', renderFilteredSections)
  })
}

const handleLogout = async () => {
  if (singleNodes.logout) {
    singleNodes.logout.disabled = true
    singleNodes.logout.textContent = 'Logging out...'
  }

  try {
    await signOut()
    window.location.assign(LOGIN_PATH)
  } catch (error) {
    setTableError('auth', error, 'sign out')
    if (singleNodes.logout) {
      singleNodes.logout.disabled = false
      singleNodes.logout.textContent = 'Logout'
    }
  }
}

const showLocked = (message) => {
  if (singleNodes.loading) singleNodes.loading.hidden = true
  if (singleNodes.app) singleNodes.app.hidden = true
  if (singleNodes.locked) singleNodes.locked.hidden = false
  if (singleNodes.lockedMessage) singleNodes.lockedMessage.textContent = message
}

const revealDashboard = () => {
  if (singleNodes.loading) singleNodes.loading.hidden = true
  if (singleNodes.locked) singleNodes.locked.hidden = true
  if (singleNodes.app) singleNodes.app.hidden = false
}

const guardAdminRoute = async () => {
  const user = await getCurrentUser()
  if (!user) {
    window.location.replace(LOGIN_PATH)
    return null
  }

  const { data: profile, error } = await supabase
    .from('profiles')
    .select('id, display_name, role, created_at')
    .eq('id', user.id)
    .maybeSingle()

  if (error) {
    showLocked(describeError('profiles', error, 'admin role check'))
    return null
  }

  if (!ADMIN_ROLES.has(profile?.role)) {
    window.location.replace(ACCOUNT_PATH)
    return null
  }

  state.user = user
  state.profile = profile
  return { user, profile }
}

const renderIdentity = () => {
  if (singleNodes.name) singleNodes.name.textContent = displayNameFor(state.user, state.profile)
  if (singleNodes.role) singleNodes.role.textContent = formatRole(state.profile?.role)
}

const fetchProfiles = async () => {
  const { data, error, count } = await supabase
    .from('profiles')
    .select('id, display_name, role, created_at', { count: 'exact' })
    .order('created_at', { ascending: false })

  if (error) {
    state.users = []
    state.counts.users = null
    setTableError('profiles', error)
    return
  }

  state.users = data || []
  state.counts.users = count ?? state.users.length
  clearTableError('profiles')
}

const fetchCollections = async () => {
  const { data, error, count } = await supabase
    .from('collections')
    .select('id, slug, title, description, visibility, is_active, sort_order, created_at, updated_at', { count: 'exact' })
    .order('sort_order', { ascending: true })
    .order('title', { ascending: true })

  if (error) {
    state.collections = []
    setTableError('collections', error)
    return
  }

  state.collections = data || []
  clearTableError('collections')
  if (singleNodes.collectionsCount) {
    const total = count ?? state.collections.length
    singleNodes.collectionsCount.textContent = `${total} ${total === 1 ? 'collection' : 'collections'}`
  }
}

const fetchVolumes = async () => {
  const { data, error, count } = await supabase
    .from('volumes')
    .select('id, collection_id, slug, title, description, visibility, is_active, sort_order, created_at, updated_at', { count: 'exact' })
    .order('sort_order', { ascending: true })
    .order('title', { ascending: true })

  if (error) {
    state.volumes = []
    setTableError('volumes', error)
    return
  }

  state.volumes = data || []
  clearTableError('volumes')
  if (singleNodes.volumesCount) {
    const total = count ?? state.volumes.length
    singleNodes.volumesCount.textContent = `${total} ${total === 1 ? 'volume' : 'volumes'}`
  }
}

const fetchSeries = async () => {
  const { data, error, count } = await supabase
    .from('series')
    .select('id, collection_id, volume_id, slug, title, description, visibility, is_active, sort_order, created_at, updated_at', { count: 'exact' })
    .order('sort_order', { ascending: true })
    .order('title', { ascending: true })

  if (error) {
    state.seriesItems = []
    setTableError('series', error)
    return
  }

  state.seriesItems = data || []
  clearTableError('series')
  if (singleNodes.seriesCount) {
    const total = count ?? state.seriesItems.length
    singleNodes.seriesCount.textContent = `${total} ${total === 1 ? 'series' : 'series'}`
  }
}

const fetchBooks = async () => {
  const { data, error, count } = await supabase
    .from('books')
    .select('id, title, series, book_number, slug, visibility, series_id, is_public, is_active', { count: 'exact' })
    .order('series', { ascending: true })
    .order('book_number', { ascending: true })

  if (error) {
    if (isSchemaError(error)) {
      const fallback = await supabase
        .from('books')
        .select('id, title, series, book_number, slug, is_public, is_active', { count: 'exact' })
        .order('series', { ascending: true })
        .order('book_number', { ascending: true })

      if (!fallback.error) {
        state.books = fallback.data || []
        state.counts.books = fallback.count ?? state.books.length
        setTableError('books_visibility_schema', error, 'visibility/series_id migration check')
        return
      }
    }

    state.books = []
    state.counts.books = null
    setTableError('books', error)
    return
  }

  state.books = data || []
  state.counts.books = count ?? state.books.length
  clearTableError('books')
  clearTableError('books_visibility_schema')
}

const fetchFeedbacks = async () => {
  const { data, error, count } = await supabase
    .from('feedbacks')
    .select('id, "Date & time", Name, Email, "Reviews ", Collection, Series, Book, "Occupation ", Rate, status, user_id', { count: 'exact' })

  if (error) {
    state.feedbacks = []
    state.counts.feedbacks = null
    setTableError('feedbacks', error)
    return
  }

  state.feedbacks = sortFeedbackNewestFirst(data || [])
  state.counts.feedbacks = count ?? state.feedbacks.length
  clearTableError('feedbacks')
}

const fetchAccessGrants = async () => {
  const { data, error } = await supabase
    .from('book_access')
    .select('user_id, book_id, granted_by, access_type, granted_at, expires_at, is_visible, can_read')
    .order('granted_at', { ascending: false })

  if (error) {
    state.accessGrants = []
    state.counts.accessGrants = null
    setTableError('book_access', error)
    if (singleNodes.accessStatus) {
      singleNodes.accessStatus.textContent = 'The active access count could not be read with the current Supabase policies.'
    }
    return
  }

  state.accessGrants = data || []
  state.counts.accessGrants = activeAccessGrantCount()
  clearTableError('book_access')
  if (singleNodes.accessStatus) {
    singleNodes.accessStatus.textContent = `${state.counts.accessGrants} effective active grants are visible to this admin role.`
  }
}

const loadAdminData = async () => {
  setStatsLoading()

  await Promise.all([
    fetchProfiles(),
    fetchCollections(),
    fetchVolumes(),
    fetchSeries(),
    fetchBooks(),
    fetchFeedbacks(),
    fetchAccessGrants(),
  ])

  populateFilters()
  renderDashboard()
  renderFilteredSections()
}

const populateFilters = () => {
  setSelectOptions(
    singleNodes.userRole,
    uniqueValues(state.users, (user) => user.role),
    'All roles'
  )

  setSelectOptions(
    singleNodes.feedbackStatus,
    [...new Set([...STATUS_OPTIONS, ...uniqueValues(state.feedbacks, (feedback) => feedback.status)])],
    'All statuses'
  )

  setSelectOptions(
    singleNodes.feedbackRating,
    uniqueValues(state.feedbacks, (feedback) => feedback.Rate).sort((a, b) => Number(b) - Number(a)),
    'All ratings'
  )

  setSelectOptions(
    singleNodes.feedbackSeries,
    uniqueValues(state.feedbacks, (feedback) => feedback.Series),
    'All series'
  )

  setSelectOptions(
    singleNodes.feedbackBook,
    uniqueValues(state.feedbacks, (feedback) => feedback.Book),
    'All books'
  )

  renderVolumeCollectionOptions()
  renderSeriesCollectionOptions()
  renderSeriesVolumeOptions()
  renderAccessUserOptions()
  renderAccessBookOptions()
}

const renderVolumeCollectionOptions = () => {
  setItemOptions(
    singleNodes.volumeCollectionSelect,
    state.collections,
    'Select collection',
    (collection) => collection.id,
    (collection) => getText(collection.title)
  )
}

const renderSeriesCollectionOptions = () => {
  setItemOptions(
    singleNodes.seriesCollectionSelect,
    state.collections,
    'Select collection',
    (collection) => collection.id,
    (collection) => getText(collection.title)
  )
}

const renderSeriesVolumeOptions = () => {
  const selectedCollectionId = singleNodes.seriesCollectionSelect?.value || ''
  const volumes = state.volumes.filter((volume) => !selectedCollectionId || volume.collection_id === selectedCollectionId)

  setItemOptions(
    singleNodes.seriesVolumeSelect,
    volumes,
    'Select volume',
    (volume) => volume.id,
    (volume) => getText(volume.title)
  )
}

const renderAccessUserOptions = () => {
  const query = normalize(singleNodes.accessUserSearch?.value)
  const users = state.users
    .filter((profile) => !query || normalize(profile.display_name).includes(query))
    .sort((a, b) => getText(a.display_name).localeCompare(getText(b.display_name)))

  setItemOptions(
    singleNodes.accessUser,
    users,
    'Select user',
    (profile) => profile.id,
    profileLabel
  )
}

const renderAccessBookOptions = () => {
  const books = [...state.books].sort((a, b) => bookLabel(a).localeCompare(bookLabel(b)))

  setItemOptions(
    singleNodes.accessBook,
    books,
    'Select book',
    (book) => book.id,
    bookLabel
  )
}

const renderDashboard = () => {
  const newFeedbacks = state.feedbacks.filter((feedback) => normalize(feedback.status || 'new') === 'new').length
  if (state.counts.accessGrants != null) state.counts.accessGrants = activeAccessGrantCount()

  setStat('users', state.counts.users == null ? 'Blocked' : state.counts.users)
  setStat('books', state.counts.books == null ? 'Blocked' : state.counts.books)
  setStat('feedbacks', state.counts.feedbacks == null ? 'Blocked' : state.counts.feedbacks)
  setStat('newFeedbacks', state.counts.feedbacks == null ? 'Blocked' : newFeedbacks)
  setStat('accessGrants', state.counts.accessGrants == null ? 'Blocked' : state.counts.accessGrants)
  if (singleNodes.accessStatus && state.counts.accessGrants != null) {
    singleNodes.accessStatus.textContent = `${state.counts.accessGrants} effective active grants are visible to this admin role.`
  }

  renderRecentUsers()
  renderRecentFeedback()
}

const renderRecentUsers = () => {
  const list = singleNodes.recentUsers
  clearNode(list)
  if (!list) return

  if (!state.users.length) {
    list.append(createNode('p', 'admin-empty', state.errors.profiles ? 'Profiles are blocked by Supabase policy.' : 'No users found.'))
    return
  }

  state.users.slice(0, 5).forEach((profile) => {
    const item = createNode('article', 'admin-list-item')
    item.append(
      createNode('strong', '', getText(profile.display_name, 'Unnamed reader')),
      createNode('span', '', `${formatRole(profile.role)} - ${formatDate(profile.created_at)}`)
    )
    list.append(item)
  })
}

const renderRecentFeedback = () => {
  const list = singleNodes.recentFeedback
  clearNode(list)
  if (!list) return

  if (!state.feedbacks.length) {
    list.append(createNode('p', 'admin-empty', state.errors.feedbacks ? 'Feedback is blocked by Supabase policy.' : 'No feedback found.'))
    return
  }

  state.feedbacks.slice(0, 5).forEach((feedback) => {
    const item = createNode('article', 'admin-list-item')
    item.append(
      createNode('strong', '', `${getText(feedback.Name, 'Anonymous')} - ${getText(feedback.Book, 'General feedback')}`),
      createNode('span', '', `${getText(feedback.status, 'new')} - ${formatDate(feedback['Date & time'])}`)
    )
    list.append(item)
  })
}

const renderFilteredSections = () => {
  renderUsers()
  renderCollections()
  renderVolumes()
  renderSeries()
  renderHierarchy()
  renderBooks()
  renderAccessGrants()
  renderFeedback()
}

const renderUsers = () => {
  const table = singleNodes.usersTable
  clearNode(table)
  if (!table) return

  const query = normalize(singleNodes.userSearch?.value)
  const role = singleNodes.userRole?.value || ''
  const users = state.users.filter((profile) => {
    const matchesSearch = !query || normalize(profile.display_name).includes(query)
    const matchesRole = !role || profile.role === role
    return matchesSearch && matchesRole
  })

  users.forEach((profile) => {
    const row = document.createElement('tr')
    row.append(
      tableCell(getText(profile.display_name, 'Unnamed reader'), true),
      badgeCell(formatRole(profile.role)),
      tableCell(formatDate(profile.created_at)),
      detailsCell('User ID', profile.id)
    )
    table.append(row)
  })

  if (singleNodes.usersEmpty) {
    singleNodes.usersEmpty.hidden = Boolean(users.length) || Boolean(state.errors.profiles)
  }
}

const compactInput = (type, value) => {
  const input = document.createElement('input')
  input.className = 'admin-compact-control'
  input.type = type
  input.value = value ?? ''
  return input
}

const controlCell = (...nodes) => {
  const cell = document.createElement('td')
  nodes.forEach((node) => cell.append(node))
  return cell
}

const collectionOptionsSelect = (selectedId = '') => {
  const select = document.createElement('select')
  select.className = 'admin-compact-control'

  state.collections.forEach((collection) => {
    const option = document.createElement('option')
    option.value = collection.id
    option.textContent = getText(collection.title)
    select.append(option)
  })

  select.value = selectedId
  return select
}

const volumeOptionsSelect = (selectedId = '', collectionId = '') => {
  const select = document.createElement('select')
  select.className = 'admin-compact-control'
  populateVolumeOptions(select, selectedId, collectionId)
  return select
}

const populateVolumeOptions = (select, selectedId = '', collectionId = '') => {
  clearNode(select)
  const volumes = state.volumes.filter((volume) => !collectionId || volume.collection_id === collectionId)
  volumes.forEach((volume) => {
    const option = document.createElement('option')
    option.value = volume.id
    option.textContent = getText(volume.title)
    select.append(option)
  })

  select.value = selectedId
}

const contentSaveButton = (label = 'Save') => {
  const button = createNode('button', 'admin-inline-action', label)
  button.type = 'button'
  return button
}

const confirmContentChange = (name, previous, next, kind) => {
  const riskyVisibility = previous.visibility !== next.visibility && next.visibility === 'private'
  const riskyActive = previous.is_active !== next.is_active && next.is_active === false

  if (!riskyVisibility && !riskyActive) return true

  const messages = []
  if (riskyVisibility) messages.push('private items are hidden from guests and customers')
  if (riskyActive) messages.push('inactive items are disabled for customers')

  return window.confirm(`Update ${kind} "${name}"? ${messages.join(' and ')}.`)
}

const contentPayloadFromForm = (form, { includeCollection = false, includeVolume = false } = {}) => {
  const formData = new FormData(form)
  const payload = {
    title: formValue(formData, 'title'),
    slug: formValue(formData, 'slug'),
    description: formValue(formData, 'description') || null,
    visibility: normalizeVisibility(formValue(formData, 'visibility')),
    is_active: boolFromSelect(formValue(formData, 'is_active') || 'true'),
    sort_order: toSortOrder(formValue(formData, 'sort_order')),
  }

  if (includeCollection) payload.collection_id = formValue(formData, 'collection_id')
  if (includeVolume) payload.volume_id = formValue(formData, 'volume_id')
  return payload
}

const handleCreateCollection = async (event) => {
  event.preventDefault()
  const form = event.currentTarget
  if (!ADMIN_ROLES.has(state.profile?.role)) return

  if (!form.checkValidity()) {
    setFormStatus(singleNodes.collectionStatus, 'Please complete the collection fields.', 'error')
    form.reportValidity()
    return
  }

  const submitButton = form.querySelector('button[type="submit"]')
  const previousLabel = submitButton?.textContent
  if (submitButton) {
    submitButton.disabled = true
    submitButton.textContent = 'Creating...'
  }

  const payload = contentPayloadFromForm(form)
  const { data, error } = await supabase
    .from('collections')
    .insert(payload)
    .select('id, slug, title, description, visibility, is_active, sort_order, created_at, updated_at')
    .maybeSingle()

  if (submitButton) {
    submitButton.disabled = false
    submitButton.textContent = previousLabel
  }

  if (error) {
    setFormStatus(singleNodes.collectionStatus, 'Collection could not be created. Check the dashboard alert for details.', 'error')
    setTableError('collections', error, 'INSERT')
    return
  }

  state.collections.push(data || payload)
  state.collections.sort((a, b) => toSortOrder(a.sort_order) - toSortOrder(b.sort_order) || getText(a.title).localeCompare(getText(b.title)))
  clearTableError('collections')
  setFormStatus(singleNodes.collectionStatus, 'Collection created.', 'success')
  form.reset()
  populateFilters()
  renderFilteredSections()
}

const handleCreateVolume = async (event) => {
  event.preventDefault()
  const form = event.currentTarget
  if (!ADMIN_ROLES.has(state.profile?.role)) return

  if (!form.checkValidity()) {
    setFormStatus(singleNodes.volumeStatus, 'Please complete the volume fields.', 'error')
    form.reportValidity()
    return
  }

  const submitButton = form.querySelector('button[type="submit"]')
  const previousLabel = submitButton?.textContent
  if (submitButton) {
    submitButton.disabled = true
    submitButton.textContent = 'Creating...'
  }

  const payload = contentPayloadFromForm(form, { includeCollection: true })
  const { data, error } = await supabase
    .from('volumes')
    .insert(payload)
    .select('id, collection_id, slug, title, description, visibility, is_active, sort_order, created_at, updated_at')
    .maybeSingle()

  if (submitButton) {
    submitButton.disabled = false
    submitButton.textContent = previousLabel
  }

  if (error) {
    setFormStatus(singleNodes.volumeStatus, 'Volume could not be created. Check the dashboard alert for details.', 'error')
    setTableError('volumes', error, 'INSERT')
    return
  }

  state.volumes.push(data || payload)
  state.volumes.sort((a, b) => toSortOrder(a.sort_order) - toSortOrder(b.sort_order) || getText(a.title).localeCompare(getText(b.title)))
  clearTableError('volumes')
  setFormStatus(singleNodes.volumeStatus, 'Volume created.', 'success')
  form.reset()
  populateFilters()
  renderFilteredSections()
}

const handleCreateSeries = async (event) => {
  event.preventDefault()
  const form = event.currentTarget
  if (!ADMIN_ROLES.has(state.profile?.role)) return

  if (!form.checkValidity()) {
    setFormStatus(singleNodes.seriesStatus, 'Please complete the series fields.', 'error')
    form.reportValidity()
    return
  }

  const payload = contentPayloadFromForm(form, { includeCollection: true, includeVolume: true })
  const selectedVolume = state.volumes.find((volume) => volume.id === payload.volume_id)
  if (selectedVolume?.collection_id !== payload.collection_id) {
    setFormStatus(singleNodes.seriesStatus, 'The selected volume must belong to the selected collection.', 'error')
    return
  }

  const submitButton = form.querySelector('button[type="submit"]')
  const previousLabel = submitButton?.textContent
  if (submitButton) {
    submitButton.disabled = true
    submitButton.textContent = 'Creating...'
  }

  const { data, error } = await supabase
    .from('series')
    .insert(payload)
    .select('id, collection_id, volume_id, slug, title, description, visibility, is_active, sort_order, created_at, updated_at')
    .maybeSingle()

  if (submitButton) {
    submitButton.disabled = false
    submitButton.textContent = previousLabel
  }

  if (error) {
    setFormStatus(singleNodes.seriesStatus, 'Series could not be created. Check the dashboard alert for details.', 'error')
    setTableError('series', error, 'INSERT')
    return
  }

  state.seriesItems.push(data || payload)
  state.seriesItems.sort((a, b) => toSortOrder(a.sort_order) - toSortOrder(b.sort_order) || getText(a.title).localeCompare(getText(b.title)))
  clearTableError('series')
  setFormStatus(singleNodes.seriesStatus, 'Series created.', 'success')
  form.reset()
  populateFilters()
  renderFilteredSections()
}

const renderCollections = () => {
  const table = singleNodes.collectionsTable
  clearNode(table)
  if (!table) return

  state.collections.forEach((collection) => {
    const titleInput = compactInput('text', collection.title)
    const slugInput = compactInput('text', collection.slug)
    const visibility = visibilitySelect(collection.visibility)
    const active = activeSelect(collection.is_active)
    const sortOrder = compactInput('number', toSortOrder(collection.sort_order))
    const save = contentSaveButton()

    save.addEventListener('click', () => updateCollection(collection, {
      titleInput,
      slugInput,
      visibility,
      active,
      sortOrder,
      save,
    }))

    const row = document.createElement('tr')
    row.append(
      controlCell(titleInput),
      controlCell(slugInput),
      controlCell(visibility),
      controlCell(active),
      controlCell(sortOrder),
      controlCell(save)
    )
    table.append(row)
  })

  if (singleNodes.collectionsCount) {
    const total = state.collections.length
    singleNodes.collectionsCount.textContent = `${total} ${total === 1 ? 'collection' : 'collections'}`
  }

  if (singleNodes.collectionsEmpty) {
    singleNodes.collectionsEmpty.hidden = Boolean(state.collections.length) || Boolean(state.errors.collections)
  }
}

const renderVolumes = () => {
  const table = singleNodes.volumesTable
  clearNode(table)
  if (!table) return

  const collectionsById = new Map(state.collections.map((collection) => [collection.id, collection]))

  state.volumes.forEach((volume) => {
    const visibility = visibilitySelect(volume.visibility)
    const active = activeSelect(volume.is_active)
    const sortOrder = compactInput('number', toSortOrder(volume.sort_order))
    const save = contentSaveButton()

    save.addEventListener('click', () => updateVolume(volume, {
      visibility,
      active,
      sortOrder,
      save,
    }))

    const row = document.createElement('tr')
    row.append(
      tableCell(getText(volume.title)),
      tableCell(getText(collectionsById.get(volume.collection_id)?.title, 'Unassigned collection')),
      tableCell(getText(volume.slug)),
      controlCell(visibility),
      controlCell(active),
      controlCell(sortOrder),
      controlCell(save)
    )
    table.append(row)
  })

  if (singleNodes.volumesCount) {
    const total = state.volumes.length
    singleNodes.volumesCount.textContent = `${total} ${total === 1 ? 'volume' : 'volumes'}`
  }

  if (singleNodes.volumesEmpty) {
    singleNodes.volumesEmpty.hidden = Boolean(state.volumes.length) || Boolean(state.errors.volumes)
  }
}

const renderSeries = () => {
  const table = singleNodes.seriesTable
  clearNode(table)
  if (!table) return

  state.seriesItems.forEach((series) => {
    const titleInput = compactInput('text', series.title)
    const collectionSelect = collectionOptionsSelect(series.collection_id)
    const volumeSelect = volumeOptionsSelect(series.volume_id, series.collection_id)
    const slugInput = compactInput('text', series.slug)
    const visibility = visibilitySelect(series.visibility)
    const active = activeSelect(series.is_active)
    const sortOrder = compactInput('number', toSortOrder(series.sort_order))
    const save = contentSaveButton()

    collectionSelect.addEventListener('change', () => populateVolumeOptions(volumeSelect, '', collectionSelect.value))

    save.addEventListener('click', () => updateSeries(series, {
      titleInput,
      collectionSelect,
      volumeSelect,
      slugInput,
      visibility,
      active,
      sortOrder,
      save,
    }))

    const row = document.createElement('tr')
    row.append(
      controlCell(titleInput),
      controlCell(collectionSelect),
      controlCell(volumeSelect),
      controlCell(slugInput),
      controlCell(visibility),
      controlCell(active),
      controlCell(sortOrder),
      controlCell(save)
    )
    table.append(row)
  })

  if (singleNodes.seriesCount) {
    const total = state.seriesItems.length
    singleNodes.seriesCount.textContent = `${total} ${total === 1 ? 'series' : 'series'}`
  }

  if (singleNodes.seriesEmpty) {
    singleNodes.seriesEmpty.hidden = Boolean(state.seriesItems.length) || Boolean(state.errors.series)
  }
}

const hierarchyBadge = (text, className = '') => createNode('span', `admin-badge ${className}`.trim(), text)

const contentMetaBadges = (hierarchy) => {
  const wrap = createNode('div', 'admin-hierarchy__badges')
  const available = hierarchyIsActive(hierarchy)
  const visibility = effectiveVisibility(hierarchy)

  wrap.append(
    hierarchyBadge(available ? 'Active' : 'Inactive', available ? 'admin-badge--active' : 'admin-badge--disabled'),
    hierarchyBadge(visibilityLabel(visibility))
  )

  return wrap
}

const booksForSeries = (series) => {
  return state.books
    .filter((book) => book.series_id === series.id)
    .sort((a, b) => toSortOrder(a.book_number) - toSortOrder(b.book_number) || getText(a.title).localeCompare(getText(b.title)))
}

const renderBookList = (series) => {
  const books = booksForSeries(series)
  const list = createNode('ul', 'admin-hierarchy__books')

  books.forEach((book) => {
    const item = createNode('li')
    item.append(
      createNode('span', '', getText(book.title)),
      hierarchyBadge(visibilityLabel(bookVisibility(book))),
      hierarchyBadge(boolValueLabel(book.is_active), book.is_active === false ? 'admin-badge--disabled' : 'admin-badge--active')
    )
    list.append(item)
  })

  if (!books.length) {
    list.append(createNode('li', 'admin-hierarchy__empty', 'No books linked yet.'))
  }

  return list
}

const renderSeriesBranch = (series, collection, volume) => {
  const branch = createNode('details', 'admin-hierarchy__series')
  branch.open = true

  const summary = createNode('summary')
  const title = createNode('strong', '', getText(series.title, 'Untitled series'))
  const count = booksForSeries(series).length
  summary.append(
    title,
    createNode('span', 'admin-hierarchy__count', `${count} ${count === 1 ? 'Book' : 'Books'}`),
    contentMetaBadges({ collection, volume, series })
  )

  branch.append(summary, renderBookList(series))
  return branch
}

const renderVolumeBranch = (volume, collection) => {
  const branch = createNode('article', 'admin-hierarchy__volume')
  const heading = createNode('div', 'admin-hierarchy__heading')
  heading.append(
    createNode('h4', '', getText(volume.title, 'Untitled volume')),
    contentMetaBadges({ collection, volume })
  )
  branch.append(heading)

  const seriesItems = state.seriesItems
    .filter((series) => series.volume_id === volume.id)
    .sort((a, b) => toSortOrder(a.sort_order) - toSortOrder(b.sort_order) || getText(a.title).localeCompare(getText(b.title)))

  if (!seriesItems.length) {
    branch.append(createNode('p', 'admin-hierarchy__empty', 'No series linked yet.'))
    return branch
  }

  seriesItems.forEach((series) => branch.append(renderSeriesBranch(series, collection, volume)))
  return branch
}

const renderUnassignedSeries = (collection) => {
  const assignedVolumeIds = new Set(state.volumes.map((volume) => volume.id))
  const seriesItems = state.seriesItems.filter((series) => {
    return series.collection_id === collection.id && (!series.volume_id || !assignedVolumeIds.has(series.volume_id))
  })

  if (!seriesItems.length) return null

  const branch = createNode('article', 'admin-hierarchy__volume admin-hierarchy__volume--unassigned')
  const heading = createNode('div', 'admin-hierarchy__heading')
  heading.append(createNode('h4', '', 'Series without Volume'), hierarchyBadge('Needs parent volume', 'admin-badge--restricted'))
  branch.append(heading)
  seriesItems.forEach((series) => branch.append(renderSeriesBranch(series, collection, null)))
  return branch
}

const renderHierarchy = () => {
  const tree = singleNodes.hierarchyTree
  clearNode(tree)
  if (!tree) return

  const hasHierarchy = Boolean(state.collections.length || state.volumes.length || state.seriesItems.length || state.books.length)
  if (singleNodes.hierarchyEmpty) singleNodes.hierarchyEmpty.hidden = hasHierarchy
  if (!hasHierarchy) return

  state.collections.forEach((collection) => {
    const collectionBranch = createNode('article', 'admin-hierarchy__collection')
    const heading = createNode('div', 'admin-hierarchy__heading')
    heading.append(
      createNode('h3', '', getText(collection.title, 'Untitled collection')),
      contentMetaBadges({ collection })
    )
    collectionBranch.append(heading)

    const volumes = state.volumes
      .filter((volume) => volume.collection_id === collection.id)
      .sort((a, b) => toSortOrder(a.sort_order) - toSortOrder(b.sort_order) || getText(a.title).localeCompare(getText(b.title)))

    if (!volumes.length) {
      collectionBranch.append(createNode('p', 'admin-hierarchy__empty', 'No volumes linked yet.'))
    } else {
      volumes.forEach((volume) => collectionBranch.append(renderVolumeBranch(volume, collection)))
    }

    const unassigned = renderUnassignedSeries(collection)
    if (unassigned) collectionBranch.append(unassigned)

    tree.append(collectionBranch)
  })

  const collectionIds = new Set(state.collections.map((collection) => collection.id))
  const orphanVolumes = state.volumes.filter((volume) => !volume.collection_id || !collectionIds.has(volume.collection_id))
  if (orphanVolumes.length) {
    const orphanBranch = createNode('article', 'admin-hierarchy__collection admin-hierarchy__collection--orphan')
    const heading = createNode('div', 'admin-hierarchy__heading')
    heading.append(createNode('h3', '', 'Volumes without Collection'), hierarchyBadge('Needs collection', 'admin-badge--restricted'))
    orphanBranch.append(heading)
    orphanVolumes.forEach((volume) => orphanBranch.append(renderVolumeBranch(volume, null)))
    tree.append(orphanBranch)
  }

  const seriesIds = new Set(state.seriesItems.map((series) => series.id))
  const orphanBooks = state.books.filter((book) => !book.series_id || !seriesIds.has(book.series_id))
  if (orphanBooks.length) {
    const orphanBranch = createNode('article', 'admin-hierarchy__collection admin-hierarchy__collection--orphan')
    const heading = createNode('div', 'admin-hierarchy__heading')
    heading.append(
      createNode('h3', '', 'Books without Series'),
      hierarchyBadge(`${orphanBooks.length} ${orphanBooks.length === 1 ? 'Book' : 'Books'}`, 'admin-badge--restricted')
    )
    const list = createNode('ul', 'admin-hierarchy__books')
    orphanBooks.forEach((book) => {
      const item = createNode('li')
      item.append(createNode('span', '', getText(book.title)), hierarchyBadge(visibilityLabel(bookVisibility(book))))
      list.append(item)
    })
    orphanBranch.append(heading, list)
    tree.append(orphanBranch)
  }
}

const updateCollection = async (collection, controls) => {
  if (!ADMIN_ROLES.has(state.profile?.role)) return

  const updates = {
    title: controls.titleInput.value.trim(),
    slug: controls.slugInput.value.trim(),
    visibility: normalizeVisibility(controls.visibility.value),
    is_active: boolFromSelect(controls.active.value),
    sort_order: toSortOrder(controls.sortOrder.value),
  }

  if (!updates.title || !updates.slug) {
    setTableError('collections', new Error('Collection title and slug are required.'), 'UPDATE')
    return
  }

  if (!confirmContentChange(getText(collection.title, 'collection'), collection, updates, 'collection')) return

  const previousLabel = controls.save.textContent
  controls.save.disabled = true
  controls.save.textContent = 'Saving...'

  const { data, error } = await supabase
    .from('collections')
    .update(updates)
    .eq('id', collection.id)
    .select('id, slug, title, description, visibility, is_active, sort_order, created_at, updated_at')
    .maybeSingle()

  controls.save.disabled = false
  controls.save.textContent = previousLabel

  if (error) {
    setTableError('collections', error, 'UPDATE')
    return
  }

  Object.assign(collection, data || updates)
  clearTableError('collections')
  populateFilters()
  renderFilteredSections()
}

const updateVolume = async (volume, controls) => {
  if (!ADMIN_ROLES.has(state.profile?.role)) return

  const updates = {
    visibility: normalizeVisibility(controls.visibility.value),
    is_active: boolFromSelect(controls.active.value),
    sort_order: toSortOrder(controls.sortOrder.value),
  }

  if (!confirmContentChange(getText(volume.title, 'volume'), volume, updates, 'volume')) return

  const previousLabel = controls.save.textContent
  controls.save.disabled = true
  controls.save.textContent = 'Saving...'

  const { data, error } = await supabase
    .from('volumes')
    .update(updates)
    .eq('id', volume.id)
    .select('id, collection_id, slug, title, description, visibility, is_active, sort_order, created_at, updated_at')
    .maybeSingle()

  controls.save.disabled = false
  controls.save.textContent = previousLabel

  if (error) {
    setTableError('volumes', error, 'UPDATE')
    return
  }

  Object.assign(volume, data || updates)
  clearTableError('volumes')
  populateFilters()
  renderFilteredSections()
}

const updateSeries = async (series, controls) => {
  if (!ADMIN_ROLES.has(state.profile?.role)) return

  const updates = {
    collection_id: controls.collectionSelect.value,
    volume_id: controls.volumeSelect.value,
    title: controls.titleInput.value.trim(),
    slug: controls.slugInput.value.trim(),
    visibility: normalizeVisibility(controls.visibility.value),
    is_active: boolFromSelect(controls.active.value),
    sort_order: toSortOrder(controls.sortOrder.value),
  }

  if (!updates.collection_id || !updates.volume_id || !updates.title || !updates.slug) {
    setTableError('series', new Error('Series collection, volume, title, and slug are required.'), 'UPDATE')
    return
  }

  const selectedVolume = state.volumes.find((volume) => volume.id === updates.volume_id)
  if (selectedVolume?.collection_id !== updates.collection_id) {
    setTableError('series', new Error('The selected volume must belong to the selected collection.'), 'UPDATE')
    return
  }

  if (!confirmContentChange(getText(series.title, 'series'), series, updates, 'series')) return

  const previousLabel = controls.save.textContent
  controls.save.disabled = true
  controls.save.textContent = 'Saving...'

  const { data, error } = await supabase
    .from('series')
    .update(updates)
    .eq('id', series.id)
    .select('id, collection_id, volume_id, slug, title, description, visibility, is_active, sort_order, created_at, updated_at')
    .maybeSingle()

  controls.save.disabled = false
  controls.save.textContent = previousLabel

  if (error) {
    setTableError('series', error, 'UPDATE')
    return
  }

  Object.assign(series, data || updates)
  clearTableError('series')
  populateFilters()
  renderFilteredSections()
}

const renderBooks = () => {
  const table = singleNodes.booksTable
  clearNode(table)
  if (!table) return

  state.books.forEach((book) => {
    const row = document.createElement('tr')
    row.append(
      tableCell(getText(book.title)),
      tableCell(getText(book.series)),
      tableCell(getText(book.book_number)),
      tableCell(getText(book.slug)),
      badgeCell(visibilityLabel(bookVisibility(book))),
      badgeCell(boolValueLabel(book.is_active)),
      bookControlsCell(book)
    )
    table.append(row)
  })

  if (singleNodes.booksCount) {
    const count = state.counts.books ?? 0
    singleNodes.booksCount.textContent = `${count} ${count === 1 ? 'book' : 'books'}`
  }

  if (singleNodes.booksEmpty) {
    singleNodes.booksEmpty.hidden = Boolean(state.books.length) || Boolean(state.errors.books)
  }
}

const bookControlsCell = (book) => {
  const cell = document.createElement('td')
  const actions = createNode('div', 'admin-inline-actions')
  const visibility = visibilitySelect(bookVisibility(book))
  const active = activeSelect(book.is_active)
  const saveButton = createNode('button', 'admin-inline-action', 'Save')

  saveButton.type = 'button'
  saveButton.addEventListener('click', () => updateBookContentControls(book, {
    visibility,
    active,
    saveButton,
  }))

  actions.append(
    createNode('span', 'admin-field-hint', 'Visibility'),
    visibility,
    createNode('span', 'admin-field-hint', 'Global Active'),
    active,
    saveButton
  )
  cell.append(actions)
  return cell
}

const updateBookContentControls = async (book, controls) => {
  if (!ADMIN_ROLES.has(state.profile?.role)) return
  if (!book?.id) return

  const label = getText(book.title, 'this book')
  const updates = {
    visibility: normalizeVisibility(controls.visibility.value),
    is_active: boolFromSelect(controls.active.value),
  }
  const previous = {
    visibility: bookVisibility(book),
    is_active: book.is_active !== false,
  }

  if (!confirmContentChange(label, previous, updates, 'book')) return

  const previousLabel = controls.saveButton?.textContent
  if (controls.saveButton) {
    controls.saveButton.disabled = true
    controls.saveButton.textContent = 'Saving...'
  }

  const { data, error } = await supabase
    .from('books')
    .update(updates)
    .eq('id', book.id)
    .select('id, title, series, book_number, slug, visibility, series_id, is_public, is_active')
    .maybeSingle()

  if (error) {
    if (controls.saveButton) {
      controls.saveButton.disabled = false
      controls.saveButton.textContent = previousLabel
    }
    setTableError('books', error, 'UPDATE')
    return
  }

  Object.assign(book, data || updates)
  clearTableError('books')
  renderDashboard()
  renderHierarchy()
  renderAccessGrants()
  renderBooks()
}

const profileMap = () => new Map(state.users.map((profile) => [profile.id, profile]))

const bookMap = () => new Map(state.books.map((book) => [book.id, book]))

const renderAccessGrants = () => {
  const table = singleNodes.accessTable
  clearNode(table)
  if (!table) return

  const usersById = profileMap()
  const booksById = bookMap()

  state.accessGrants.forEach((grant) => {
    const row = document.createElement('tr')
    const profile = usersById.get(grant.user_id)
    const book = booksById.get(grant.book_id)

    row.append(
      accessUserCell(profile, grant.user_id),
      tableCell(getText(book?.title, getText(grant.book_id))),
      tableCell(getText(book?.series)),
      accessFlagCell(grant, 'is_visible', 'accessVisibleControl'),
      accessFlagCell(grant, 'can_read', 'accessCanReadControl'),
      accessTypeCell(grant),
      tableCell(formatDate(grant.granted_at)),
      accessExpirationCell(grant),
      accessStatusCell(grant),
      accessActionsCell(grant)
    )
    table.append(row)
  })

  if (singleNodes.accessEmpty) {
    singleNodes.accessEmpty.hidden = Boolean(state.accessGrants.length) || Boolean(state.errors.book_access)
  }
}

const accessUserCell = (profile, userId) => {
  const cell = document.createElement('td')
  const name = createNode('strong', '', getText(profile?.display_name, 'Unnamed reader'))
  const id = createNode('code', 'admin-id', getText(userId))
  cell.append(name, id)
  return cell
}

const accessFlagCell = (grant, field, datasetKey) => {
  const cell = document.createElement('td')
  const select = document.createElement('select')
  select.className = 'admin-compact-control'
  select.dataset[datasetKey] = accessKey(grant)

  ;[
    ['true', 'ON'],
    ['false', 'OFF'],
  ].forEach(([value, label]) => {
    const option = document.createElement('option')
    option.value = value
    option.textContent = label
    select.append(option)
  })

  select.value = grant[field] === false ? 'false' : 'true'
  cell.append(select)
  return cell
}

const accessTypeCell = (grant) => {
  const cell = document.createElement('td')
  const select = document.createElement('select')
  select.className = 'admin-compact-control'
  select.dataset.accessTypeControl = accessKey(grant)

  ACCESS_TYPES.forEach((type) => {
    const option = document.createElement('option')
    option.value = type
    option.textContent = type
    select.append(option)
  })

  select.value = ACCESS_TYPES.includes(grant.access_type) ? grant.access_type : 'manual'
  cell.append(select)
  return cell
}

const accessExpirationCell = (grant) => {
  const cell = document.createElement('td')
  const wrap = createNode('div', 'admin-expiration-control')
  const input = document.createElement('input')
  input.className = 'admin-compact-control'
  input.type = 'datetime-local'
  input.value = toDateTimeLocal(grant.expires_at)
  input.dataset.accessExpiresControl = accessKey(grant)
  const hint = createNode('span', 'admin-field-hint', 'Blank means no expiration')
  wrap.append(input, hint)
  cell.append(wrap)
  return cell
}

const accessStatusCell = (grant) => {
  const cell = document.createElement('td')
  const status = accessGrantStatus(grant)
  cell.append(createNode('span', `admin-badge ${status.className}`, status.label))
  return cell
}

const accessActionsCell = (grant) => {
  const cell = document.createElement('td')
  const actions = createNode('div', 'admin-inline-actions')
  const saveButton = createNode('button', 'admin-inline-action', 'Save')
  const revokeButton = createNode('button', 'admin-inline-action admin-inline-action--danger', 'Revoke')

  saveButton.type = 'button'
  revokeButton.type = 'button'
  saveButton.addEventListener('click', () => updateAccessGrant(grant, saveButton))
  revokeButton.addEventListener('click', () => revokeAccessGrant(grant, revokeButton))

  actions.append(saveButton, revokeButton)
  cell.append(actions)
  return cell
}

const handleGrantAccess = async (event) => {
  event.preventDefault()

  const form = event.currentTarget
  if (!ADMIN_ROLES.has(state.profile?.role)) return

  if (!form.checkValidity()) {
    setFormStatus(singleNodes.accessFormStatus, 'Please select a user and a book.', 'error')
    form.reportValidity()
    return
  }

  const userId = singleNodes.accessUser?.value || ''
  const bookId = singleNodes.accessBook?.value || ''
  const accessType = singleNodes.accessType?.value || 'manual'
  const isVisible = boolFromSelect(singleNodes.accessVisible?.value || 'true')
  const canRead = boolFromSelect(singleNodes.accessCanRead?.value || 'true')

  if (state.accessGrants.some((grant) => grant.user_id === userId && grant.book_id === bookId)) {
    setFormStatus(singleNodes.accessFormStatus, 'This user already has access to this book.', 'error')
    return
  }

  const submitButton = form.querySelector('button[type="submit"]')
  const previousLabel = submitButton?.textContent
  if (submitButton) {
    submitButton.disabled = true
    submitButton.textContent = 'Granting...'
  }

  const payload = {
    user_id: userId,
    book_id: bookId,
    granted_by: state.user.id,
    access_type: accessType,
    granted_at: new Date().toISOString(),
    expires_at: fromDateTimeLocal(singleNodes.accessExpires?.value),
    is_visible: isVisible,
    can_read: canRead,
  }

  const { data, error } = await supabase
    .from('book_access')
    .insert(payload)
    .select('user_id, book_id, granted_by, access_type, granted_at, expires_at, is_visible, can_read')
    .maybeSingle()

  if (submitButton) {
    submitButton.disabled = false
    submitButton.textContent = previousLabel
  }

  if (error) {
    if (error.code === '23505') {
      setFormStatus(singleNodes.accessFormStatus, 'This user already has access to this book.', 'error')
      return
    }

    setFormStatus(singleNodes.accessFormStatus, 'Access could not be granted. Check the dashboard alert for details.', 'error')
    setTableError('book_access', error, 'INSERT')
    return
  }

  state.accessGrants.unshift(data || payload)
  state.counts.accessGrants = activeAccessGrantCount()
  clearTableError('book_access')
  setFormStatus(singleNodes.accessFormStatus, 'Access granted.', 'success')
  if (singleNodes.accessExpires) singleNodes.accessExpires.value = ''
  if (singleNodes.accessVisible) singleNodes.accessVisible.value = 'true'
  if (singleNodes.accessCanRead) singleNodes.accessCanRead.value = 'true'
  renderDashboard()
  renderAccessGrants()
}

const updateAccessGrant = async (grant, button) => {
  if (!ADMIN_ROLES.has(state.profile?.role)) return
  const key = accessKey(grant)
  const typeControl = $(`[data-access-type-control="${key}"]`)
  const visibleControl = $(`[data-access-visible-control="${key}"]`)
  const canReadControl = $(`[data-access-can-read-control="${key}"]`)
  const expiresControl = $(`[data-access-expires-control="${key}"]`)
  const previousLabel = button?.textContent

  if (button) {
    button.disabled = true
    button.textContent = 'Saving...'
  }

  const updates = {
    access_type: typeControl?.value || 'manual',
    is_visible: boolFromSelect(visibleControl?.value || 'true'),
    can_read: boolFromSelect(canReadControl?.value || 'true'),
    expires_at: fromDateTimeLocal(expiresControl?.value),
  }

  const { data, error } = await supabase
    .from('book_access')
    .update(updates)
    .eq('user_id', grant.user_id)
    .eq('book_id', grant.book_id)
    .select('user_id, book_id, granted_by, access_type, granted_at, expires_at, is_visible, can_read')
    .maybeSingle()

  if (error) {
    if (button) {
      button.disabled = false
      button.textContent = previousLabel
    }
    setTableError('book_access', error, 'UPDATE')
    return
  }

  Object.assign(grant, data || updates)
  state.counts.accessGrants = activeAccessGrantCount()
  clearTableError('book_access')
  renderDashboard()
  renderAccessGrants()
}

const revokeAccessGrant = async (grant, button) => {
  if (!ADMIN_ROLES.has(state.profile?.role)) return
  const usersById = profileMap()
  const booksById = bookMap()
  const userLabel = getText(usersById.get(grant.user_id)?.display_name, 'this user')
  const bookTitle = getText(booksById.get(grant.book_id)?.title, 'this book')

  if (!window.confirm(`Revoke access for ${userLabel} to "${bookTitle}"?`)) return

  const previousLabel = button?.textContent
  if (button) {
    button.disabled = true
    button.textContent = 'Revoking...'
  }

  const { error } = await supabase
    .from('book_access')
    .delete()
    .eq('user_id', grant.user_id)
    .eq('book_id', grant.book_id)

  if (error) {
    if (button) {
      button.disabled = false
      button.textContent = previousLabel
    }
    setTableError('book_access', error, 'DELETE')
    return
  }

  state.accessGrants = state.accessGrants.filter((item) => accessKey(item) !== accessKey(grant))
  state.counts.accessGrants = activeAccessGrantCount()
  clearTableError('book_access')
  renderDashboard()
  renderAccessGrants()
}

const renderFeedback = () => {
  const list = singleNodes.feedbackList
  clearNode(list)
  if (!list) return

  const feedbacks = filteredFeedbacks()
  feedbacks.forEach((feedback) => list.append(feedbackCard(feedback)))

  if (singleNodes.feedbackEmpty) {
    singleNodes.feedbackEmpty.hidden = Boolean(feedbacks.length) || Boolean(state.errors.feedbacks)
  }
}

const filteredFeedbacks = () => {
  const query = normalize(singleNodes.feedbackSearch?.value)
  const status = singleNodes.feedbackStatus?.value || ''
  const rating = singleNodes.feedbackRating?.value || ''
  const series = singleNodes.feedbackSeries?.value || ''
  const book = singleNodes.feedbackBook?.value || ''

  return state.feedbacks
    .filter((feedback) => {
      const haystack = [
        feedback.Name,
        feedback.Email,
        feedback['Reviews '],
        feedback.Collection,
        feedback.Series,
        feedback.Book,
        feedback['Occupation '],
      ].map(normalize).join(' ')

      return (!query || haystack.includes(query))
        && (!status || getText(feedback.status, 'new') === status)
        && (!rating || String(feedback.Rate) === rating)
        && (!series || feedback.Series === series)
        && (!book || feedback.Book === book)
    })
    .sort((a, b) => parseFeedbackDate(b['Date & time']) - parseFeedbackDate(a['Date & time']))
}

const tableCell = (text, strong = false) => {
  const cell = document.createElement('td')
  const child = createNode(strong ? 'strong' : 'span', '', text)
  cell.append(child)
  return cell
}

const badgeCell = (text) => {
  const cell = document.createElement('td')
  cell.append(createNode('span', 'admin-badge', text))
  return cell
}

const detailsCell = (summaryText, detailText) => {
  const cell = document.createElement('td')
  const details = document.createElement('details')
  const summary = createNode('summary', '', 'View')
  const id = createNode('code', 'admin-id', `${summaryText}: ${getText(detailText)}`)
  details.append(summary, id)
  cell.append(details)
  return cell
}

const statusBadge = (status) => {
  const value = getText(status, 'new')
  const badge = createNode('span', `admin-badge admin-badge--${normalize(value)}`, value)
  return badge
}

const formatRating = (value) => {
  const rating = Number(value)
  if (!Number.isFinite(rating)) return getText(value, 'Unrated')
  return Number.isInteger(rating) ? String(rating) : rating.toFixed(1)
}

const feedbackMetaField = (label, value, className = '') => {
  const field = createNode('div', `feedback-meta-field ${className}`.trim())
  field.append(
    createNode('span', '', label),
    createNode('strong', '', getText(value))
  )
  return field
}

const feedbackCard = (feedback) => {
  const card = createNode('article', 'feedback-card')
  const rating = createNode('div', 'feedback-card__rating')
  const ratingValue = createNode('strong', '', formatRating(feedback.Rate))
  const ratingLabel = createNode('span', '', '/ 5 rating')
  const review = createNode('blockquote', 'feedback-card__review', getText(feedback['Reviews '], 'No review text provided.'))
  const reviewer = createNode('p', 'feedback-card__reviewer', `- ${getText(feedback.Name, 'Anonymous')}`)
  const meta = createNode('div', 'feedback-card__meta-grid')

  rating.append(ratingValue, ratingLabel)
  meta.append(
    feedbackMetaField('Book', feedback.Book),
    feedbackMetaField('Series', feedback.Series),
    feedbackMetaField('Collection', feedback.Collection),
    feedbackMetaField('Occupation', feedback['Occupation ']),
    feedbackMetaField('Date', formatDate(feedback['Date & time'])),
    feedbackMetaField('Email', feedback.Email, 'feedback-meta-field--secondary')
  )

  const statusLabel = createNode('label')
  const labelText = createNode('span', '', 'Status')
  const statusSelect = document.createElement('select')
  statusSelect.className = 'feedback-status-select'
  statusSelect.disabled = !feedback.id

  STATUS_OPTIONS.forEach((status) => {
    const option = document.createElement('option')
    option.value = status
    option.textContent = status
    statusSelect.append(option)
  })

  statusSelect.value = STATUS_OPTIONS.includes(feedback.status) ? feedback.status : 'new'
  statusSelect.addEventListener('change', () => updateFeedbackStatus(feedback, statusSelect))
  statusLabel.append(labelText, statusSelect)

  const actions = createNode('div', 'feedback-card__actions')
  const storyButton = createNode('button', 'admin-action feedback-story-button', 'Download Story PNG')
  storyButton.type = 'button'
  storyButton.addEventListener('click', () => downloadFeedbackStory(feedback, storyButton))

  if (!feedback.id) {
    const warning = createNode('p', 'admin-empty', 'Status update needs a feedback row id.')
    actions.append(statusBadge(feedback.status), statusLabel, storyButton, warning)
  } else {
    actions.append(statusBadge(feedback.status), statusLabel, storyButton)
  }

  card.append(rating, review, reviewer, meta, actions)
  return card
}

const slugify = (value) => {
  return getText(value, 'greyveil')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'greyveil'
}

const roundedRect = (context, x, y, width, height, radius) => {
  const safeRadius = Math.min(radius, width / 2, height / 2)
  context.beginPath()
  context.moveTo(x + safeRadius, y)
  context.lineTo(x + width - safeRadius, y)
  context.quadraticCurveTo(x + width, y, x + width, y + safeRadius)
  context.lineTo(x + width, y + height - safeRadius)
  context.quadraticCurveTo(x + width, y + height, x + width - safeRadius, y + height)
  context.lineTo(x + safeRadius, y + height)
  context.quadraticCurveTo(x, y + height, x, y + height - safeRadius)
  context.lineTo(x, y + safeRadius)
  context.quadraticCurveTo(x, y, x + safeRadius, y)
  context.closePath()
}

const fitCanvasLine = (context, text, maxWidth) => {
  if (context.measureText(text).width <= maxWidth) return text

  let fitted = text
  while (fitted.length > 0 && context.measureText(`${fitted}...`).width > maxWidth) {
    fitted = fitted.slice(0, -1).trim()
  }

  return `${fitted || text.slice(0, 1)}...`
}

const wrapCanvasText = (context, text, maxWidth, maxLines) => {
  const words = getText(text, '').split(/\s+/).filter(Boolean)
  const lines = []
  let currentLine = ''
  let truncated = false

  words.forEach((word) => {
    if (truncated) return
    const candidate = currentLine ? `${currentLine} ${word}` : word

    if (context.measureText(candidate).width <= maxWidth) {
      currentLine = candidate
      return
    }

    if (currentLine) lines.push(currentLine)
    currentLine = word

    if (lines.length >= maxLines) {
      truncated = true
    }
  })

  if (!truncated && currentLine) lines.push(currentLine)
  if (lines.length > maxLines) {
    lines.length = maxLines
    truncated = true
  }

  if (truncated && lines.length) {
    let lastLine = lines[lines.length - 1]
    while (lastLine.length > 0 && context.measureText(`${lastLine}...`).width > maxWidth) {
      lastLine = lastLine.slice(0, -1).trim()
    }
    lines[lines.length - 1] = `${lastLine || '...'}...`
  }

  return lines.map((line) => fitCanvasLine(context, line, maxWidth))
}

const drawWrappedText = (context, lines, x, y, lineHeight) => {
  lines.forEach((line, index) => {
    context.fillText(line, x, y + index * lineHeight)
  })
}

const drawStoryMeta = (context, label, value, x, y) => {
  context.font = '700 24px Inter, Arial, sans-serif'
  context.fillStyle = '#8c6a4a'
  context.fillText(label.toUpperCase(), x, y)
  context.font = '600 34px Inter, Arial, sans-serif'
  context.fillStyle = '#2a3440'
  drawWrappedText(context, wrapCanvasText(context, getText(value), 820, 2), x, y + 42, 40)
}

const downloadFeedbackStory = async (feedback, button) => {
  const previousLabel = button?.textContent
  if (button) {
    button.disabled = true
    button.textContent = 'Preparing PNG...'
  }

  try {
    const canvas = document.createElement('canvas')
    canvas.width = 1080
    canvas.height = 1920
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Canvas export is not available in this browser.')
    drawFeedbackStory(context, feedback)

    const link = document.createElement('a')
    link.download = `greyveil-feedback-${slugify(feedback.Book)}-${slugify(feedback.Name)}.png`
    link.href = canvas.toDataURL('image/png')
    link.click()
  } catch (error) {
    setTableError('feedback_story_export', error, 'PNG export')
  } finally {
    if (button) {
      button.disabled = false
      button.textContent = previousLabel
    }
  }
}

const drawFeedbackStory = (context, feedback) => {
  context.fillStyle = '#f8f7f4'
  context.fillRect(0, 0, 1080, 1920)

  const gradient = context.createLinearGradient(0, 0, 1080, 1920)
  gradient.addColorStop(0, 'rgba(140, 106, 74, 0.18)')
  gradient.addColorStop(0.52, 'rgba(248, 247, 244, 0)')
  gradient.addColorStop(1, 'rgba(108, 154, 139, 0.18)')
  context.fillStyle = gradient
  context.fillRect(0, 0, 1080, 1920)

  context.fillStyle = '#2a3440'
  context.font = '800 34px Inter, Arial, sans-serif'
  context.letterSpacing = '4px'
  context.fillText('GREYVEIL EDITIONS', 96, 132)
  context.letterSpacing = '0px'

  context.fillStyle = '#8c6a4a'
  context.font = '700 26px Inter, Arial, sans-serif'
  context.fillText('READER FEEDBACK', 96, 178)

  roundedRect(context, 78, 260, 924, 1110, 52)
  context.fillStyle = 'rgba(255, 255, 255, 0.76)'
  context.fill()
  context.strokeStyle = 'rgba(42, 52, 64, 0.14)'
  context.lineWidth = 3
  context.stroke()

  context.fillStyle = '#8c6a4a'
  context.font = '800 92px Cormorant Garamond, Georgia, serif'
  context.fillText(`${formatRating(feedback.Rate)} / 5`, 132, 402)
  context.font = '700 24px Inter, Arial, sans-serif'
  context.fillText('RATING', 136, 452)

  const review = getText(feedback['Reviews '], 'No review text provided.')
  let reviewFontSize = 58
  let reviewLines = []
  do {
    context.font = `600 ${reviewFontSize}px Cormorant Garamond, Georgia, serif`
    reviewLines = wrapCanvasText(context, `"${review}"`, 800, 10)
    reviewFontSize -= 4
  } while (reviewLines.length >= 10 && reviewFontSize >= 42)

  context.fillStyle = '#2a3440'
  context.font = `600 ${reviewFontSize + 4}px Cormorant Garamond, Georgia, serif`
  drawWrappedText(context, reviewLines, 132, 558, reviewFontSize + 20)

  const reviewerY = Math.min(1320, 578 + reviewLines.length * (reviewFontSize + 20) + 20)
  context.font = '700 42px Inter, Arial, sans-serif'
  context.fillStyle = '#3a3a3a'
  context.fillText(`- ${getText(feedback.Name, 'Anonymous')}`, 132, reviewerY)

  drawStoryMeta(context, 'Book', feedback.Book, 132, 1450)
  drawStoryMeta(context, 'Series', feedback.Series, 132, 1548)

  context.font = '600 26px Inter, Arial, sans-serif'
  context.fillStyle = 'rgba(42, 52, 64, 0.64)'
  context.fillText('Shared from Greyveil Editions reader feedback.', 96, 1764)
  context.font = '800 30px Inter, Arial, sans-serif'
  context.fillStyle = '#2a3440'
  context.fillText('greyveileditions.vercel.app', 96, 1812)
}

const updateFeedbackStatus = async (feedback, select) => {
  const nextStatus = select.value
  const previousStatus = STATUS_OPTIONS.includes(feedback.status) ? feedback.status : 'new'

  if (!feedback.id) {
    select.value = previousStatus
    return
  }

  select.disabled = true

  const { error } = await supabase
    .from('feedbacks')
    .update({ status: nextStatus })
    .eq('id', feedback.id)

  if (error) {
    select.value = previousStatus
    select.disabled = false
    setTableError('feedbacks', error, 'status update')
    return
  }

  feedback.status = nextStatus
  clearTableError('feedbacks')
  populateFilters()
  renderDashboard()
  renderFeedback()
}

const init = async () => {
  bindControls()

  const allowed = await guardAdminRoute()
  if (!allowed) return

  renderIdentity()
  revealDashboard()
  await loadAdminData()
}

init()
