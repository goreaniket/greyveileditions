import { supabase } from './supabase-client.js'
import { getCurrentUser, signOut } from './auth.js'
import { effectiveVisibility, hierarchyForBook, hierarchyIsActive, hierarchyIsComplete, normalizeVisibility, VISIBILITY_STATES } from './content-access.js'

const ADMIN_ROLES = new Set(['admin', 'super_admin'])
const STATUS_OPTIONS = ['new', 'reviewed', 'archived']
const ACCESS_TYPES = ['manual', 'promotion', 'complimentary', 'purchase']
const LOGIN_PATH = '/auth/login/'
const ACCOUNT_PATH = '/account/'
const BOOK_FILE_BUCKET = 'book-files'
const BOOK_COVER_BUCKET = 'book-covers'
const BOOK_FILE_SELECT = 'id, book_id, file_type, storage_path, file_name, mime_type, file_size, created_at, updated_at'
const BOOK_COVER_SELECT = 'id, book_id, cover_type, storage_path, file_name, mime_type, file_size, created_at, updated_at'
const SIGNED_URL_TTL_SECONDS = 60
const SIGNED_PREVIEW_CLEAR_DELAY = 55000
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const NUMERIC_ID_PATTERN = /^\d+$/
const COVER_CONFIGS = {
  front_cover: {
    label: 'Front Cover',
    storageName: 'front-cover',
    accept: 'image/png,image/jpeg,image/webp',
    allowedMimeTypes: ['image/png', 'image/jpeg', 'image/webp'],
    maxBytes: 12 * 1024 * 1024,
  },
}
const BOOK_FILE_CONFIGS = {
  pdf: {
    label: 'PDF',
    storageName: 'book.pdf',
    accept: 'application/pdf,.pdf',
    allowedMimeTypes: ['application/pdf'],
    allowedExtensions: ['pdf'],
    maxBytes: 120 * 1024 * 1024,
    superAdminOnly: false,
  },
  epub: {
    label: 'EPUB',
    storageName: 'book.epub',
    accept: 'application/epub+zip,.epub',
    allowedMimeTypes: ['application/epub+zip', 'application/octet-stream'],
    allowedExtensions: ['epub'],
    maxBytes: 120 * 1024 * 1024,
    superAdminOnly: true,
  },
  docx: {
    label: 'DOCX',
    storageName: 'book.docx',
    accept: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document,.docx',
    allowedMimeTypes: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/octet-stream'],
    allowedExtensions: ['docx'],
    maxBytes: 80 * 1024 * 1024,
    superAdminOnly: true,
  },
}
const signedPreviewTimers = new WeakMap()

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
  contentNavigator: '[data-content-navigator]',
  contentDetail: '[data-content-detail]',
  hierarchyTree: '[data-content-hierarchy]',
  hierarchyEmpty: '[data-hierarchy-empty]',
  booksTable: '[data-books-table]',
  booksEmpty: '[data-books-empty]',
  booksCount: '[data-books-count]',
  booksGroupList: '[data-books-group-list]',
  bookFilterCollection: '[data-book-filter-collection]',
  bookFilterVolume: '[data-book-filter-volume]',
  bookFilterSeries: '[data-book-filter-series]',
  bookFiltersReset: '[data-book-filters-reset]',
  filesCollection: '[data-files-collection]',
  filesVolume: '[data-files-volume]',
  filesSeries: '[data-files-series]',
  filesBook: '[data-files-book]',
  filesStatus: '[data-files-status]',
  filesDetail: '[data-files-detail]',
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
  accessModeButtons: '[data-access-mode-tab]',
  accessModePanels: '[data-access-mode-panel]',
  seriesAccessForm: '[data-series-access-form]',
  seriesAccessCollection: '[data-series-access-collection]',
  seriesAccessVolume: '[data-series-access-volume]',
  seriesAccessSeries: '[data-series-access-series]',
  seriesAccessType: '[data-series-access-type]',
  seriesAccessExpires: '[data-series-access-expires]',
  seriesAccessStatus: '[data-series-access-status]',
  seriesAccessSummary: '[data-series-access-summary]',
  seriesAccessRevoke: '[data-series-access-revoke]',
  paymentsTable: '[data-payments-table]',
  paymentsEmpty: '[data-payments-empty]',
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
  bookFiles: [],
  bookCovers: [],
  feedbacks: [],
  accessGrants: [],
  orders: [],
  payments: [],
  paymentCustomers: [],
  contentSelection: {
    kind: '',
    id: '',
  },
  filesSelection: {
    collectionId: '',
    volumeId: '',
    seriesId: '',
    bookId: '',
  },
  counts: {
    users: null,
    books: null,
    feedbacks: null,
    accessGrants: null,
  },
  errors: {},
  feedbackDrawer: {
    feedback: null,
    returnFocus: null,
  },
  paymentDrawer: {
    order: null,
    returnFocus: null,
  },
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
  contentNavigator: $(selectors.contentNavigator),
  contentDetail: $(selectors.contentDetail),
  hierarchyTree: $(selectors.hierarchyTree),
  hierarchyEmpty: $(selectors.hierarchyEmpty),
  booksTable: $(selectors.booksTable),
  booksEmpty: $(selectors.booksEmpty),
  booksCount: $(selectors.booksCount),
  booksGroupList: $(selectors.booksGroupList),
  bookFilterCollection: $(selectors.bookFilterCollection),
  bookFilterVolume: $(selectors.bookFilterVolume),
  bookFilterSeries: $(selectors.bookFilterSeries),
  bookFiltersReset: $(selectors.bookFiltersReset),
  filesCollection: $(selectors.filesCollection),
  filesVolume: $(selectors.filesVolume),
  filesSeries: $(selectors.filesSeries),
  filesBook: $(selectors.filesBook),
  filesStatus: $(selectors.filesStatus),
  filesDetail: $(selectors.filesDetail),
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
  seriesAccessForm: $(selectors.seriesAccessForm),
  seriesAccessCollection: $(selectors.seriesAccessCollection),
  seriesAccessVolume: $(selectors.seriesAccessVolume),
  seriesAccessSeries: $(selectors.seriesAccessSeries),
  seriesAccessType: $(selectors.seriesAccessType),
  seriesAccessExpires: $(selectors.seriesAccessExpires),
  seriesAccessStatus: $(selectors.seriesAccessStatus),
  seriesAccessSummary: $(selectors.seriesAccessSummary),
  seriesAccessRevoke: $(selectors.seriesAccessRevoke),
  paymentsTable: $(selectors.paymentsTable),
  paymentsEmpty: $(selectors.paymentsEmpty),
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

const applyResponsiveTableLabels = (tableBody) => {
  const table = tableBody?.closest('table')
  if (!table) return

  const labels = Array.from(table.querySelectorAll('thead th')).map((heading) => heading.textContent.trim())
  Array.from(tableBody.querySelectorAll('tr')).forEach((row) => {
    Array.from(row.children).forEach((cell, index) => {
      cell.dataset.label = labels[index] || ''
    })
  })
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

const formatBytes = (bytes) => {
  const value = Number(bytes)
  if (!Number.isFinite(value) || value <= 0) return '-'

  const units = ['B', 'KB', 'MB', 'GB']
  let size = value
  let unitIndex = 0

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024
    unitIndex += 1
  }

  const precision = size >= 10 || unitIndex === 0 ? 0 : 1
  return `${size.toFixed(precision)} ${units[unitIndex]}`
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

const isSuperAdmin = () => state.profile?.role === 'super_admin'

const roleCanManageBookFileType = (role, fileType) => {
  const config = BOOK_FILE_CONFIGS[fileType]
  if (!config) return false
  if (role === 'super_admin') return true
  return role === 'admin' && !config.superAdminOnly
}

const canManageBookFileType = (fileType) => {
  return roleCanManageBookFileType(state.profile?.role, fileType)
}

const isValidBookId = (bookId) => {
  const value = getText(bookId, '')
  return UUID_PATTERN.test(value) || NUMERIC_ID_PATTERN.test(value)
}

const safeStorageSegment = (value, fallback = 'book') => {
  return getText(value, fallback)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96) || fallback
}

const fileExtension = (file) => {
  const name = getText(file?.name, '').toLowerCase()
  const match = name.match(/\.([a-z0-9]+)$/)
  return match ? match[1] : ''
}

const coverExtensionForFile = (file) => {
  const extension = fileExtension(file)
  if (['jpg', 'jpeg', 'png', 'webp'].includes(extension)) return extension === 'jpeg' ? 'jpg' : extension
  if (file?.type === 'image/png') return 'png'
  if (file?.type === 'image/webp') return 'webp'
  return 'jpg'
}

const bookStorageFolder = (book) => safeStorageSegment(book?.slug, safeStorageSegment(book?.id, 'book'))

const validateManagedFile = (file, config, kind) => {
  if (!file) return `${kind} file is required.`
  if (file.size > config.maxBytes) return `${kind} file is too large. Limit is ${formatBytes(config.maxBytes)}.`

  const extension = fileExtension(file)
  if (config.allowedExtensions?.length && config.allowedExtensions.includes(extension)) return ''
  if (config.allowedMimeTypes?.includes(file.type)) return ''

  return `${kind} file type is not supported.`
}

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
  ;['revenue', 'success', 'pending', 'failed', 'refunded'].forEach((name) => setPaymentStat(name, '-'))
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
  return `${displayName} (${formatRole(profile.role)})`
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
  if (name === 'files') renderFilesManager()
}

const showAccessMode = (mode = 'book') => {
  const activeMode = mode === 'series' ? 'series' : 'book'

  $$(selectors.accessModeButtons).forEach((button) => {
    button.setAttribute('aria-selected', String(button.dataset.accessModeTab === activeMode))
  })

  $$(selectors.accessModePanels).forEach((panel) => {
    panel.hidden = panel.dataset.accessModePanel !== activeMode
  })

  if (activeMode === 'series') renderSeriesAccessStatus()
}

const bindControls = () => {
  $$(selectors.navButtons).forEach((button) => {
    button.addEventListener('click', () => showPanel(button.dataset.adminTab))
  })

  $$(selectors.tabLinks).forEach((button) => {
    button.addEventListener('click', () => showPanel(button.dataset.adminTabLink))
  })

  singleNodes.contentNavigator?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-content-select-kind]')
    if (!button) return
    selectContentItem(button.dataset.contentSelectKind, button.dataset.contentSelectId)
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
  singleNodes.accessUserSearch?.addEventListener('input', () => {
    renderAccessUserOptions()
    renderSeriesAccessStatus()
  })
  singleNodes.accessUser?.addEventListener('change', renderSeriesAccessStatus)
  singleNodes.seriesAccessForm?.addEventListener('submit', handleGrantSeriesAccess)
  singleNodes.seriesAccessRevoke?.addEventListener('click', handleRevokeSeriesAccess)
  singleNodes.seriesAccessCollection?.addEventListener('change', () => {
    renderSeriesAccessVolumeOptions()
    renderSeriesAccessSeriesOptions()
    renderSeriesAccessStatus()
  })
  singleNodes.seriesAccessVolume?.addEventListener('change', () => {
    renderSeriesAccessSeriesOptions()
    renderSeriesAccessStatus()
  })
  singleNodes.seriesAccessSeries?.addEventListener('change', renderSeriesAccessStatus)
  singleNodes.bookFilterCollection?.addEventListener('change', () => {
    renderBookVolumeFilterOptions()
    renderBookSeriesFilterOptions()
    renderBooks()
  })
  singleNodes.bookFilterVolume?.addEventListener('change', () => {
    renderBookSeriesFilterOptions()
    renderBooks()
  })
  singleNodes.bookFilterSeries?.addEventListener('change', renderBooks)
  singleNodes.bookFiltersReset?.addEventListener('click', () => {
    if (singleNodes.bookFilterCollection) singleNodes.bookFilterCollection.value = ''
    if (singleNodes.bookFilterVolume) singleNodes.bookFilterVolume.value = ''
    if (singleNodes.bookFilterSeries) singleNodes.bookFilterSeries.value = ''
    renderBookVolumeFilterOptions()
    renderBookSeriesFilterOptions()
    renderBooks()
  })
  singleNodes.filesCollection?.addEventListener('change', () => {
    state.filesSelection.collectionId = singleNodes.filesCollection.value || ''
    state.filesSelection.volumeId = ''
    state.filesSelection.seriesId = ''
    state.filesSelection.bookId = ''
    if (singleNodes.filesVolume) singleNodes.filesVolume.value = ''
    if (singleNodes.filesSeries) singleNodes.filesSeries.value = ''
    if (singleNodes.filesBook) singleNodes.filesBook.value = ''
    renderFilesVolumeOptions()
    renderFilesSeriesOptions()
    renderFilesBookOptions()
    renderFilesManager()
  })
  singleNodes.filesVolume?.addEventListener('change', () => {
    state.filesSelection.volumeId = singleNodes.filesVolume.value || ''
    state.filesSelection.seriesId = ''
    state.filesSelection.bookId = ''
    if (singleNodes.filesSeries) singleNodes.filesSeries.value = ''
    if (singleNodes.filesBook) singleNodes.filesBook.value = ''
    renderFilesSeriesOptions()
    renderFilesBookOptions()
    renderFilesManager()
  })
  singleNodes.filesSeries?.addEventListener('change', () => {
    state.filesSelection.seriesId = singleNodes.filesSeries.value || ''
    state.filesSelection.bookId = ''
    if (singleNodes.filesBook) singleNodes.filesBook.value = ''
    renderFilesBookOptions()
    renderFilesManager()
  })
  singleNodes.filesBook?.addEventListener('change', () => {
    state.filesSelection.bookId = singleNodes.filesBook.value || ''
    handleFilesBookSelection()
  })

  $$(selectors.accessModeButtons).forEach((button) => {
    button.addEventListener('click', () => showAccessMode(button.dataset.accessModeTab))
  })

  ;[
    singleNodes.userSearch,
    singleNodes.userRole,
  ].forEach((control) => {
    control?.addEventListener('input', renderUsers)
    control?.addEventListener('change', renderUsers)
  })

  ;[
    singleNodes.feedbackSearch,
    singleNodes.feedbackStatus,
    singleNodes.feedbackRating,
    singleNodes.feedbackSeries,
    singleNodes.feedbackBook,
  ].forEach((control) => {
    control?.addEventListener('input', renderFeedback)
    control?.addEventListener('change', renderFeedback)
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

const fetchOrders = async () => {
  const { data, error } = await supabase
    .from('orders')
    .select('id, user_id, purchase_type, book_id, series_id, collection_id, item_name, original_amount, amount, coupon_code, discount_amount, currency, status, razorpay_order_id, created_at, updated_at, paid_at, verified_at')
    .order('created_at', { ascending: false })

  if (error) {
    state.orders = []
    const key = isSchemaError(error) ? 'orders_schema' : 'orders'
    setTableError(key, error, isSchemaError(error) ? 'payment migration check' : 'read')
    return
  }

  state.orders = data || []
  clearTableError('orders')
  clearTableError('orders_schema')
}

const fetchPayments = async () => {
  const { data, error } = await supabase
    .from('payments')
    .select('id, order_id, user_id, razorpay_payment_id, razorpay_order_id, original_amount, amount, coupon_code, discount_amount, currency, status, method, captured, created_at, updated_at, verified_at, razorpay_created_at')
    .order('created_at', { ascending: false })

  if (error) {
    state.payments = []
    const key = isSchemaError(error) ? 'payments_schema' : 'payments'
    setTableError(key, error, isSchemaError(error) ? 'payment migration check' : 'read')
    return
  }

  state.payments = data || []
  clearTableError('payments')
  clearTableError('payments_schema')
}

const fetchPaymentCustomers = async () => {
  const { data, error } = await supabase.rpc('greyveil_admin_payment_customers')
  if (error) {
    state.paymentCustomers = []
    setTableError('payment_customers', error, 'admin payment customer lookup')
    return
  }

  state.paymentCustomers = data || []
  clearTableError('payment_customers')
}

const fetchBookFiles = async () => {
  const { data, error } = await supabase
    .from('book_files')
    .select(BOOK_FILE_SELECT)
    .order('updated_at', { ascending: false })

  if (error) {
    state.bookFiles = []
    const key = isSchemaError(error) ? 'book_files_schema' : 'book_files'
    setTableError(key, error, isSchemaError(error) ? 'schema migration check' : 'read')
    return
  }

  state.bookFiles = data || []
  clearTableError('book_files')
  clearTableError('book_files_schema')
}

const fetchBookCovers = async () => {
  const { data, error } = await supabase
    .from('book_covers')
    .select(BOOK_COVER_SELECT)
    .order('updated_at', { ascending: false })

  if (error) {
    state.bookCovers = []
    const key = isSchemaError(error) ? 'book_covers_schema' : 'book_covers'
    setTableError(key, error, isSchemaError(error) ? 'schema migration check' : 'read')
    return
  }

  state.bookCovers = data || []
  clearTableError('book_covers')
  clearTableError('book_covers_schema')
}

const refreshBookPublishingMetadata = async (book) => {
  if (!isValidBookId(book?.id)) return

  const [filesResult, coversResult] = await Promise.all([
    supabase
      .from('book_files')
      .select(BOOK_FILE_SELECT)
      .eq('book_id', book.id),
    supabase
      .from('book_covers')
      .select(BOOK_COVER_SELECT)
      .eq('book_id', book.id),
  ])

  if (filesResult.error) {
    setTableError('book_files', filesResult.error, 'selected book refresh')
  } else {
    state.bookFiles = [
      ...(filesResult.data || []),
      ...state.bookFiles.filter((record) => String(record.book_id) !== String(book.id)),
    ]
    clearTableError('book_files')
  }

  if (coversResult.error) {
    setTableError('book_covers', coversResult.error, 'selected book refresh')
  } else {
    state.bookCovers = [
      ...(coversResult.data || []),
      ...state.bookCovers.filter((record) => String(record.book_id) !== String(book.id)),
    ]
    clearTableError('book_covers')
  }
}

const handleFilesBookSelection = async () => {
  const book = bookMap().get(singleNodes.filesBook?.value || '') || null
  renderFilesManager()
  if (!book) return

  await refreshBookPublishingMetadata(book)
  renderFilesManager()
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
    fetchOrders(),
    fetchPayments(),
    fetchPaymentCustomers(),
    fetchBookFiles(),
    fetchBookCovers(),
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
  renderSeriesAccessCollectionOptions()
  renderSeriesAccessVolumeOptions()
  renderSeriesAccessSeriesOptions()
  renderBookCollectionFilterOptions()
  renderBookVolumeFilterOptions()
  renderBookSeriesFilterOptions()
  renderFilesCollectionOptions()
  renderFilesVolumeOptions()
  renderFilesSeriesOptions()
  renderFilesBookOptions()
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
    .filter((profile) => profile.role === 'customer')
    .filter((profile) => !query || normalize(profile.display_name).includes(query))
    .sort((a, b) => getText(a.display_name).localeCompare(getText(b.display_name)))

  setItemOptions(
    singleNodes.accessUser,
    users,
    'Select customer',
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

const renderSeriesAccessCollectionOptions = () => {
  setItemOptions(
    singleNodes.seriesAccessCollection,
    state.collections,
    'Select collection',
    (collection) => collection.id,
    (collection) => getText(collection.title)
  )
}

const renderSeriesAccessVolumeOptions = () => {
  const selectedCollectionId = singleNodes.seriesAccessCollection?.value || ''
  const volumes = state.volumes
    .filter((volume) => !selectedCollectionId || volume.collection_id === selectedCollectionId)
    .sort((a, b) => toSortOrder(a.sort_order) - toSortOrder(b.sort_order) || getText(a.title).localeCompare(getText(b.title)))

  setItemOptions(
    singleNodes.seriesAccessVolume,
    volumes,
    'Select volume',
    (volume) => volume.id,
    (volume) => getText(volume.title)
  )
}

const renderSeriesAccessSeriesOptions = () => {
  const selectedCollectionId = singleNodes.seriesAccessCollection?.value || ''
  const selectedVolumeId = singleNodes.seriesAccessVolume?.value || ''
  const seriesItems = state.seriesItems
    .filter((series) => !selectedCollectionId || series.collection_id === selectedCollectionId)
    .filter((series) => !selectedVolumeId || series.volume_id === selectedVolumeId)
    .sort((a, b) => toSortOrder(a.sort_order) - toSortOrder(b.sort_order) || getText(a.title).localeCompare(getText(b.title)))

  setItemOptions(
    singleNodes.seriesAccessSeries,
    seriesItems,
    'Select series',
    (series) => series.id,
    (series) => getText(series.title)
  )
}

const renderBookCollectionFilterOptions = () => {
  setItemOptions(
    singleNodes.bookFilterCollection,
    sortByOrderTitle(state.collections),
    'All collections',
    (collection) => collection.id,
    (collection) => getText(collection.title)
  )
}

const renderBookVolumeFilterOptions = () => {
  const selectedCollectionId = singleNodes.bookFilterCollection?.value || ''
  const volumes = sortByOrderTitle(
    state.volumes.filter((volume) => !selectedCollectionId || volume.collection_id === selectedCollectionId)
  )

  setItemOptions(
    singleNodes.bookFilterVolume,
    volumes,
    'All volumes',
    (volume) => volume.id,
    (volume) => getText(volume.title)
  )
}

const renderBookSeriesFilterOptions = () => {
  const selectedCollectionId = singleNodes.bookFilterCollection?.value || ''
  const selectedVolumeId = singleNodes.bookFilterVolume?.value || ''
  const lookups = buildHierarchyLookups()
  const seriesItems = sortByOrderTitle(
    state.seriesItems
      .filter((series) => {
        const parentVolume = lookups.volumesById.get(series.volume_id)
        return !selectedCollectionId
          || series.collection_id === selectedCollectionId
          || parentVolume?.collection_id === selectedCollectionId
      })
      .filter((series) => !selectedVolumeId || series.volume_id === selectedVolumeId)
  )

  setItemOptions(
    singleNodes.bookFilterSeries,
    seriesItems,
    'All series',
    (series) => series.id,
    (series) => getText(series.title)
  )
}

const syncFilesSelectionFromControls = () => {
  state.filesSelection = {
    collectionId: singleNodes.filesCollection?.value || '',
    volumeId: singleNodes.filesVolume?.value || '',
    seriesId: singleNodes.filesSeries?.value || '',
    bookId: singleNodes.filesBook?.value || '',
  }
  return state.filesSelection
}

const renderFilesCollectionOptions = () => {
  setItemOptions(
    singleNodes.filesCollection,
    sortByOrderTitle(state.collections),
    'Select collection',
    (collection) => collection.id,
    (collection) => getText(collection.title)
  )
  syncFilesSelectionFromControls()
}

const renderFilesVolumeOptions = () => {
  const selectedCollectionId = singleNodes.filesCollection?.value || ''
  const volumes = sortByOrderTitle(
    state.volumes.filter((volume) => !selectedCollectionId || volume.collection_id === selectedCollectionId)
  )

  setItemOptions(
    singleNodes.filesVolume,
    volumes,
    'Select volume',
    (volume) => volume.id,
    (volume) => getText(volume.title)
  )
  syncFilesSelectionFromControls()
}

const renderFilesSeriesOptions = () => {
  const selectedCollectionId = singleNodes.filesCollection?.value || ''
  const selectedVolumeId = singleNodes.filesVolume?.value || ''
  const lookups = buildHierarchyLookups()
  const seriesItems = sortByOrderTitle(
    state.seriesItems
      .filter((series) => {
        const parentVolume = lookups.volumesById.get(series.volume_id)
        return !selectedCollectionId
          || series.collection_id === selectedCollectionId
          || parentVolume?.collection_id === selectedCollectionId
      })
      .filter((series) => !selectedVolumeId || series.volume_id === selectedVolumeId)
  )

  setItemOptions(
    singleNodes.filesSeries,
    seriesItems,
    'Select series',
    (series) => series.id,
    (series) => getText(series.title)
  )
  syncFilesSelectionFromControls()
}

const renderFilesBookOptions = () => {
  const selectedCollectionId = singleNodes.filesCollection?.value || ''
  const selectedVolumeId = singleNodes.filesVolume?.value || ''
  const selectedSeriesId = singleNodes.filesSeries?.value || ''
  const lookups = buildHierarchyLookups()
  const books = sortBooksByNumberTitle(
    state.books.filter((book) => {
      const hierarchy = hierarchyFromLookups(book, lookups)
      return (!selectedCollectionId || hierarchy.collection?.id === selectedCollectionId)
        && (!selectedVolumeId || hierarchy.volume?.id === selectedVolumeId)
        && (!selectedSeriesId || hierarchy.series?.id === selectedSeriesId)
    })
  )

  setItemOptions(
    singleNodes.filesBook,
    books,
    'Select book',
    (book) => book.id,
    (book) => bookLabel(book)
  )
  syncFilesSelectionFromControls()
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
  renderContentManagement()
  renderBooks()
  renderFilesCollectionOptions()
  renderFilesVolumeOptions()
  renderFilesSeriesOptions()
  renderFilesBookOptions()
  renderFilesManager()
  renderAccessGrants()
  renderSeriesAccessStatus()
  renderPayments()
  renderFeedback()
}

const renderHierarchyDependentSections = () => {
  renderDashboard()
  renderContentManagement()
  renderBooks()
  renderFilesCollectionOptions()
  renderFilesVolumeOptions()
  renderFilesSeriesOptions()
  renderFilesBookOptions()
  renderFilesManager()
  renderAccessGrants()
  renderSeriesAccessStatus()
}

const formatPaymentAmount = (amount, currency = 'INR') => {
  const paise = Number(amount)
  if (!Number.isFinite(paise)) return '-'

  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: getText(currency, 'INR').toUpperCase(),
    maximumFractionDigits: 2,
  }).format(paise / 100)
}

const formatPaymentLabel = (value, fallback = '-') => {
  const text = getText(value, fallback).replace(/[_-]+/g, ' ').toLowerCase()
  return text.replace(/\b\w/g, (letter) => letter.toUpperCase())
}

const paymentPricing = (order, payment = paymentForOrder(order)) => {
  const originalAmount = Number(order?.original_amount ?? payment?.original_amount ?? order?.amount)
  const paidAmount = Number(order?.amount ?? payment?.amount)
  const couponCode = getText(order?.coupon_code || payment?.coupon_code)
  const discountAmount = Number(order?.discount_amount ?? payment?.discount_amount ?? 0)

  return {
    originalAmount,
    paidAmount,
    couponCode,
    discountAmount,
    discounted: Boolean(couponCode && Number.isFinite(originalAmount) && originalAmount > paidAmount),
  }
}

const paymentAmountCell = (order, payment) => {
  const pricing = paymentPricing(order, payment)
  const cell = document.createElement('td')
  const summary = createNode('div', 'admin-payment-amount')

  if (pricing.discounted) {
    const original = createNode('span', '', 'Original: ')
    const originalPrice = createNode('del', '', formatPaymentAmount(pricing.originalAmount, order.currency))
    original.append(originalPrice)
    summary.append(
      original,
      createNode('strong', '', `Paid: ${formatPaymentAmount(pricing.paidAmount, order.currency)}`),
      createNode('span', '', `Coupon: ${pricing.couponCode}`)
    )
  } else {
    summary.append(createNode('strong', '', formatPaymentAmount(pricing.paidAmount, order.currency)))
  }

  cell.append(summary)
  return cell
}

const paymentForOrder = (order) => {
  const orderId = String(order?.id || '')
  return state.payments.find((payment) => String(payment.order_id || '') === orderId) || null
}

const paymentStatusValue = (order, payment = paymentForOrder(order)) => {
  const paymentStatus = normalize(payment?.status)
  const orderStatus = normalize(order?.status)

  if (paymentStatus.includes('refund') || orderStatus.includes('refund')) return 'refunded'
  if (['failed', 'cancelled'].includes(paymentStatus) || ['failed', 'cancelled'].includes(orderStatus)) return 'failed'
  if (payment?.captured === true || paymentStatus === 'captured' || ['paid', 'success', 'completed'].includes(orderStatus)) return 'paid'
  return orderStatus || paymentStatus || 'pending'
}

const setPaymentStat = (name, value) => {
  const node = document.querySelector(`[data-payment-stat="${name}"]`)
  if (node) node.textContent = value
}

const renderPaymentStats = () => {
  if (state.errors.orders || state.errors.orders_schema) {
    ;['revenue', 'success', 'pending', 'failed', 'refunded'].forEach((name) => setPaymentStat(name, 'Blocked'))
    return
  }

  const statuses = state.orders.map((order) => ({
    order,
    status: paymentStatusValue(order),
  }))
  const successful = statuses.filter((item) => item.status === 'paid')
  const revenue = successful.reduce((total, item) => total + (Number(item.order.amount) || 0), 0)

  setPaymentStat('revenue', formatPaymentAmount(revenue, 'INR'))
  setPaymentStat('success', successful.length)
  setPaymentStat('pending', statuses.filter((item) => ['pending', 'created', 'authorized'].includes(item.status)).length)
  setPaymentStat('failed', statuses.filter((item) => item.status === 'failed').length)
  setPaymentStat('refunded', statuses.filter((item) => item.status === 'refunded').length)
}

const closePaymentDrawer = () => {
  document.removeEventListener('keydown', handlePaymentDrawerKeydown)
  document.querySelector('.payment-detail-modal')?.remove()

  const returnTarget = state.paymentDrawer.returnFocus?.isConnected
    ? state.paymentDrawer.returnFocus
    : singleNodes.paymentsTable?.querySelector('.admin-clickable-row')
  state.paymentDrawer.order = null
  state.paymentDrawer.returnFocus = null
  returnTarget?.focus({ preventScroll: true })
}

const handlePaymentDrawerKeydown = (event) => {
  if (event.key === 'Escape') closePaymentDrawer()
}

const openPaymentDrawer = (order, trigger, options = {}) => {
  state.paymentDrawer.order = order
  state.paymentDrawer.returnFocus = trigger || state.paymentDrawer.returnFocus || document.activeElement

  document.removeEventListener('keydown', handlePaymentDrawerKeydown)
  document.querySelector('.payment-detail-modal')?.remove()

  const payment = paymentForOrder(order)
  const profile = paymentCustomerMap().get(order.user_id) || profileMap().get(order.user_id)
  const customer = getText(profile?.display_name, getText(order.user_id, 'Unknown customer'))
  const status = paymentStatusValue(order, payment)
  const pricing = paymentPricing(order, payment)
  const overlay = createNode('div', 'feedback-detail-modal payment-detail-modal')
  overlay.setAttribute('role', 'presentation')

  const drawer = createNode('aside', 'feedback-detail-drawer payment-detail-drawer')
  drawer.setAttribute('role', 'dialog')
  drawer.setAttribute('aria-modal', 'true')
  drawer.setAttribute('aria-labelledby', 'payment-detail-title')

  const header = createNode('div', 'feedback-detail-drawer__header')
  const title = createNode('div')
  title.append(
    createNode('p', 'admin-eyebrow', 'Payment Detail'),
    createNode('h3', '', getText(order.item_name, 'Greyveil purchase'))
  )
  title.querySelector('h3').id = 'payment-detail-title'

  const closeButton = createNode('button', 'admin-action', 'Close')
  closeButton.type = 'button'
  closeButton.addEventListener('click', closePaymentDrawer)
  header.append(title, closeButton)

  const statusRow = createNode('div', 'feedback-detail-drawer__status')
  statusRow.append(statusBadge(status), createNode('span', '', `Current order state: ${formatPaymentLabel(status)}`))

  const fields = createNode('div', 'feedback-detail-grid')
  fields.append(
    feedbackDetailField('Customer', customer),
    feedbackDetailField('Email', profile?.email || '-', { secondary: true }),
    feedbackDetailField('Customer ID', order.user_id, { secondary: true }),
    feedbackDetailField('Order', order.id),
    feedbackDetailField('Payment ID', payment?.razorpay_payment_id, { secondary: true }),
    feedbackDetailField('Razorpay Order ID', order.razorpay_order_id || payment?.razorpay_order_id, { secondary: true }),
    feedbackDetailField('Item', order.item_name),
    feedbackDetailField('Purchase Type', formatPaymentLabel(order.purchase_type)),
    feedbackDetailField('Original Amount', formatPaymentAmount(pricing.originalAmount, order.currency)),
    feedbackDetailField('Paid Amount', formatPaymentAmount(pricing.paidAmount, order.currency)),
    feedbackDetailField('Coupon', pricing.couponCode || '-'),
    feedbackDetailField('Discount', formatPaymentAmount(pricing.discountAmount, order.currency)),
    feedbackDetailField('Method', formatPaymentLabel(payment?.method)),
    feedbackDetailField('Status', formatPaymentLabel(status)),
    feedbackDetailField('Order Created', formatDate(order.created_at)),
    feedbackDetailField('Order Updated', formatDate(order.updated_at)),
    feedbackDetailField('Paid', formatDate(order.paid_at)),
    feedbackDetailField('Order Verified', formatDate(order.verified_at)),
    feedbackDetailField('Payment Recorded', formatDate(payment?.created_at)),
    feedbackDetailField('Payment Verified', formatDate(payment?.verified_at || payment?.razorpay_created_at))
  )

  drawer.append(header, statusRow, fields)
  overlay.append(drawer)
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) closePaymentDrawer()
  })
  document.body.append(overlay)
  document.addEventListener('keydown', handlePaymentDrawerKeydown)

  if (!options.preserveFocus) closeButton.focus({ preventScroll: true })
}

const paymentRow = (order) => {
  const payment = paymentForOrder(order)
  const profile = paymentCustomerMap().get(order.user_id) || profileMap().get(order.user_id)
  const customer = getText(profile?.display_name, getText(order.user_id, 'Unknown customer'))
  const status = paymentStatusValue(order, payment)
  const row = document.createElement('tr')
  row.className = 'admin-clickable-row'
  row.tabIndex = 0
  row.setAttribute('aria-label', `Open payment for ${customer}, ${getText(order.item_name, 'Greyveil purchase')}`)

  const statusCell = document.createElement('td')
  statusCell.append(statusBadge(status))
  row.append(
    tableCell(customer, true),
    tableCell(getText(order.item_name, 'Greyveil purchase')),
    tableCell(formatPaymentLabel(order.purchase_type)),
    paymentAmountCell(order, payment),
    statusCell,
    tableCell(formatDate(order.paid_at || order.created_at))
  )

  row.addEventListener('click', () => openPaymentDrawer(order, row))
  row.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    openPaymentDrawer(order, row)
  })
  return row
}

const renderPayments = () => {
  const table = singleNodes.paymentsTable
  clearNode(table)
  renderPaymentStats()
  if (!table) return

  state.orders.forEach((order) => table.append(paymentRow(order)))
  applyResponsiveTableLabels(table)

  if (singleNodes.paymentsEmpty) {
    singleNodes.paymentsEmpty.hidden = Boolean(state.orders.length) || Boolean(state.errors.orders || state.errors.orders_schema)
  }
}

const renderUsers = () => {
  if (document.body.dataset.platformUsersManaged === 'true') return
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

  applyResponsiveTableLabels(table)

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

  sortByOrderTitle(state.collections).forEach((collection) => {
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
  if (data?.id) state.contentSelection = { kind: 'collection', id: data.id }
  state.collections.sort((a, b) => toSortOrder(a.sort_order) - toSortOrder(b.sort_order) || getText(a.title).localeCompare(getText(b.title)))
  clearTableError('collections')
  setFormStatus(singleNodes.collectionStatus, 'Collection created.', 'success')
  form.reset()
  populateFilters()
  renderHierarchyDependentSections()
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
  if (data?.id) state.contentSelection = { kind: 'volume', id: data.id }
  state.volumes.sort((a, b) => toSortOrder(a.sort_order) - toSortOrder(b.sort_order) || getText(a.title).localeCompare(getText(b.title)))
  clearTableError('volumes')
  setFormStatus(singleNodes.volumeStatus, 'Volume created.', 'success')
  form.reset()
  populateFilters()
  renderHierarchyDependentSections()
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
  if (data?.id) state.contentSelection = { kind: 'series', id: data.id }
  state.seriesItems.sort((a, b) => toSortOrder(a.sort_order) - toSortOrder(b.sort_order) || getText(a.title).localeCompare(getText(b.title)))
  clearTableError('series')
  setFormStatus(singleNodes.seriesStatus, 'Series created.', 'success')
  form.reset()
  populateFilters()
  renderHierarchyDependentSections()
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

  applyResponsiveTableLabels(table)

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

  applyResponsiveTableLabels(table)

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

  applyResponsiveTableLabels(table)

  if (singleNodes.seriesCount) {
    const total = state.seriesItems.length
    singleNodes.seriesCount.textContent = `${total} ${total === 1 ? 'series' : 'series'}`
  }

  if (singleNodes.seriesEmpty) {
    singleNodes.seriesEmpty.hidden = Boolean(state.seriesItems.length) || Boolean(state.errors.series)
  }
}

const collectionMap = () => new Map(state.collections.map((collection) => [collection.id, collection]))

const volumeMap = () => new Map(state.volumes.map((volume) => [volume.id, volume]))

const seriesMap = () => new Map(state.seriesItems.map((series) => [series.id, series]))

const sortByOrderTitle = (items = []) => [...items].sort((a, b) => {
  return toSortOrder(a.sort_order) - toSortOrder(b.sort_order) || getText(a.title).localeCompare(getText(b.title))
})

const sortBooksByNumberTitle = (books = []) => [...books].sort((a, b) => {
  return toSortOrder(a.book_number) - toSortOrder(b.book_number) || getText(a.title).localeCompare(getText(b.title))
})

const groupBy = (items = [], getKey) => {
  const groups = new Map()
  items.forEach((item) => {
    const key = getKey(item) || ''
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(item)
  })
  return groups
}

const buildHierarchyLookups = () => {
  const collectionsById = collectionMap()
  const volumesById = volumeMap()
  const seriesById = seriesMap()
  const booksById = bookMap()
  const volumesByCollection = groupBy(state.volumes, (volume) => volume.collection_id)
  const seriesByVolume = groupBy(state.seriesItems, (series) => series.volume_id)
  const booksBySeries = groupBy(state.books, (book) => book.series_id)

  return {
    collectionsById,
    volumesById,
    seriesById,
    booksById,
    volumesByCollection,
    seriesByVolume,
    booksBySeries,
  }
}

const hierarchyFromLookups = (book, lookups = buildHierarchyLookups()) => {
  const series = lookups.seriesById.get(book?.series_id) || null
  const volume = series ? lookups.volumesById.get(series.volume_id) || null : null
  const collection = series
    ? lookups.collectionsById.get(series.collection_id) || lookups.collectionsById.get(volume?.collection_id) || null
    : null

  return { collection, volume, series, book }
}

const collectionContentCounts = (collection, lookups = buildHierarchyLookups()) => {
  if (!collection?.id) return { volumes: 0, series: 0, books: 0 }

  const volumes = lookups.volumesByCollection.get(collection.id) || []
  const volumeIds = new Set(volumes.map((volume) => volume.id))
  const seriesItems = state.seriesItems.filter((series) => {
    return series.collection_id === collection.id || volumeIds.has(series.volume_id)
  })
  const seriesIds = new Set(seriesItems.map((series) => series.id))
  const books = state.books.filter((book) => seriesIds.has(book.series_id))

  return {
    volumes: volumes.length,
    series: seriesItems.length,
    books: books.length,
  }
}

const volumeContentCounts = (volume, lookups = buildHierarchyLookups()) => {
  if (!volume?.id) return { series: 0, books: 0 }

  const seriesItems = lookups.seriesByVolume.get(volume.id) || []
  const seriesIds = new Set(seriesItems.map((series) => series.id))
  const books = state.books.filter((book) => seriesIds.has(book.series_id))

  return {
    series: seriesItems.length,
    books: books.length,
  }
}

const contentItemExists = (kind, id) => {
  if (kind === 'collection') return collectionMap().has(id)
  if (kind === 'volume') return volumeMap().has(id)
  if (kind === 'series') return seriesMap().has(id)
  if (kind === 'book') return bookMap().has(id)
  return false
}

const ensureContentSelection = () => {
  if (contentItemExists(state.contentSelection.kind, state.contentSelection.id)) return

  const firstCollection = state.collections[0]
  const firstVolume = state.volumes[0]
  const firstSeries = state.seriesItems[0]
  const firstBook = state.books[0]

  if (firstCollection) {
    state.contentSelection = { kind: 'collection', id: firstCollection.id }
  } else if (firstVolume) {
    state.contentSelection = { kind: 'volume', id: firstVolume.id }
  } else if (firstSeries) {
    state.contentSelection = { kind: 'series', id: firstSeries.id }
  } else if (firstBook) {
    state.contentSelection = { kind: 'book', id: firstBook.id }
  } else {
    state.contentSelection = { kind: '', id: '' }
  }
}

const selectContentItem = (kind, id) => {
  if (!contentItemExists(kind, id)) return
  state.contentSelection = { kind, id }
  renderContentManagement()
}

const selectedContentClass = (kind, id) => {
  return state.contentSelection.kind === kind && state.contentSelection.id === id ? ' is-selected' : ''
}

const contentSelectButton = (kind, id, title, meta = '', level = 0) => {
  const button = createNode('button', `admin-tree-button admin-tree-button--level-${level}${selectedContentClass(kind, id)}`)
  button.type = 'button'
  button.dataset.contentSelectKind = kind
  button.dataset.contentSelectId = id

  const label = createNode('span', 'admin-tree-button__label')
  label.append(
    createNode('strong', '', getText(title, `Untitled ${kind}`)),
    createNode('small', '', meta)
  )
  button.append(label)
  return button
}

const renderContentNavigator = () => {
  const root = singleNodes.contentNavigator
  clearNode(root)
  if (!root) return

  const lookups = buildHierarchyLookups()
  const collectionIds = new Set(lookups.collectionsById.keys())
  const volumeIds = new Set(lookups.volumesById.keys())
  const seriesIds = new Set(lookups.seriesById.keys())

  sortByOrderTitle(state.collections).forEach((collection) => {
    const collectionBranch = createNode('section', 'admin-tree-branch')
    const counts = collectionContentCounts(collection, lookups)
    collectionBranch.append(
      contentSelectButton(
        'collection',
        collection.id,
        collection.title,
        `${counts.volumes} volumes / ${counts.series} series / ${counts.books} books`,
        0
      )
    )

    sortByOrderTitle(lookups.volumesByCollection.get(collection.id) || []).forEach((volume) => {
      const volumeCounts = volumeContentCounts(volume, lookups)
      collectionBranch.append(
        contentSelectButton(
          'volume',
          volume.id,
          volume.title,
          `${volumeCounts.series} series / ${volumeCounts.books} books`,
          1
        )
      )

      sortByOrderTitle(lookups.seriesByVolume.get(volume.id) || []).forEach((series) => {
        const books = sortBooksByNumberTitle(lookups.booksBySeries.get(series.id) || [])
        collectionBranch.append(contentSelectButton('series', series.id, series.title, `${books.length} ${books.length === 1 ? 'book' : 'books'}`, 2))
        books.forEach((book) => {
          collectionBranch.append(contentSelectButton('book', book.id, book.title, `${visibilityLabel(bookVisibility(book))} / ${boolValueLabel(book.is_active)}`, 3))
        })
      })
    })

    root.append(collectionBranch)
  })

  const orphanVolumes = sortByOrderTitle(state.volumes.filter((volume) => !collectionIds.has(volume.collection_id)))
  if (orphanVolumes.length) {
    const orphanBranch = createNode('section', 'admin-tree-branch admin-tree-branch--orphan')
    orphanBranch.append(createNode('p', 'admin-tree-group-label', 'Unassigned Volumes'))
    orphanVolumes.forEach((volume) => {
      orphanBranch.append(contentSelectButton('volume', volume.id, volume.title, visibilityLabel(volume.visibility), 1))
      sortByOrderTitle(lookups.seriesByVolume.get(volume.id) || []).forEach((series) => {
        const books = sortBooksByNumberTitle(lookups.booksBySeries.get(series.id) || [])
        orphanBranch.append(contentSelectButton('series', series.id, series.title, `${books.length} ${books.length === 1 ? 'book' : 'books'}`, 2))
        books.forEach((book) => {
          orphanBranch.append(contentSelectButton('book', book.id, book.title, `${visibilityLabel(bookVisibility(book))} / ${boolValueLabel(book.is_active)}`, 3))
        })
      })
    })
    root.append(orphanBranch)
  }

  const orphanSeries = sortByOrderTitle(state.seriesItems.filter((series) => !volumeIds.has(series.volume_id)))
  if (orphanSeries.length) {
    const orphanBranch = createNode('section', 'admin-tree-branch admin-tree-branch--orphan')
    orphanBranch.append(createNode('p', 'admin-tree-group-label', 'Series Without Volume'))
    orphanSeries.forEach((series) => {
      const books = sortBooksByNumberTitle(lookups.booksBySeries.get(series.id) || [])
      orphanBranch.append(contentSelectButton('series', series.id, series.title, `${books.length} ${books.length === 1 ? 'book' : 'books'}`, 2))
      books.forEach((book) => {
        orphanBranch.append(contentSelectButton('book', book.id, book.title, `${visibilityLabel(bookVisibility(book))} / ${boolValueLabel(book.is_active)}`, 3))
      })
    })
    root.append(orphanBranch)
  }

  const orphanBooks = state.books
    .filter((book) => !seriesIds.has(book.series_id))
    .sort((a, b) => toSortOrder(a.book_number) - toSortOrder(b.book_number) || getText(a.title).localeCompare(getText(b.title)))
  if (orphanBooks.length) {
    const orphanBranch = createNode('section', 'admin-tree-branch admin-tree-branch--orphan')
    orphanBranch.append(createNode('p', 'admin-tree-group-label', 'Books Without Series'))
    orphanBooks.forEach((book) => {
      orphanBranch.append(contentSelectButton('book', book.id, book.title, `${visibilityLabel(bookVisibility(book))} / ${boolValueLabel(book.is_active)}`, 3))
    })
    root.append(orphanBranch)
  }

  const hasContent = Boolean(state.collections.length || state.volumes.length || state.seriesItems.length || state.books.length)
  if (singleNodes.hierarchyEmpty) singleNodes.hierarchyEmpty.hidden = hasContent
}

const labeledControl = (label, control) => {
  const wrapper = createNode('label')
  wrapper.append(createNode('span', '', label), control)
  return wrapper
}

const detailHeader = (kind, title, meta = '') => {
  const header = createNode('div', 'admin-content-detail__header')
  header.append(
    createNode('p', 'admin-eyebrow', kind),
    createNode('h3', '', getText(title, `Untitled ${kind}`))
  )
  if (meta) header.append(createNode('p', 'admin-panel-note', meta))
  return header
}

const detailGrid = (...nodes) => {
  const grid = createNode('div', 'admin-access-grid admin-detail-grid')
  nodes.forEach((node) => grid.append(node))
  return grid
}

const detailActions = (save, extra = null) => {
  const actions = createNode('div', 'admin-form-actions')
  actions.append(save)
  if (extra) actions.append(extra)
  return actions
}

const renderCollectionDetail = (collection, lookups = buildHierarchyLookups()) => {
  if (!collection?.id) return []

  const titleInput = compactInput('text', collection.title)
  const slugInput = compactInput('text', collection.slug)
  const visibility = visibilitySelect(collection.visibility)
  const active = activeSelect(collection.is_active)
  const sortOrder = compactInput('number', toSortOrder(collection.sort_order))
  const save = contentSaveButton('Save Collection')

  save.addEventListener('click', () => updateCollection(collection, {
    titleInput,
    slugInput,
    visibility,
    active,
    sortOrder,
    save,
  }))

  const counts = collectionContentCounts(collection, lookups)
  const childVolumes = sortByOrderTitle(lookups.volumesByCollection.get(collection.id) || [])
  const children = contentChildrenList(
    'Volumes',
    childVolumes,
    (volume) => selectContentItem('volume', volume.id)
  )

  return [
    detailHeader('Collection', collection.title, `${counts.volumes} volumes / ${counts.series} series / ${counts.books} books`),
    detailGrid(
      labeledControl('Title', titleInput),
      labeledControl('Slug', slugInput),
      labeledControl('Visibility', visibility),
      labeledControl('Global Active', active),
      labeledControl('Sort Order', sortOrder),
      contentReadOnlyField('Volume Count', counts.volumes),
      contentReadOnlyField('Series Count', counts.series),
      contentReadOnlyField('Book Count', counts.books)
    ),
    detailActions(save),
    children,
    renderDangerZone('collection', collection, counts),
  ]
}

const renderVolumeDetail = (volume, lookups = buildHierarchyLookups()) => {
  if (!volume?.id) return []

  const collectionsById = lookups.collectionsById
  const titleInput = compactInput('text', volume.title)
  const slugInput = compactInput('text', volume.slug)
  const collectionSelect = collectionOptionsSelect(volume.collection_id)
  const visibility = visibilitySelect(volume.visibility)
  const active = activeSelect(volume.is_active)
  const sortOrder = compactInput('number', toSortOrder(volume.sort_order))
  const save = contentSaveButton('Save Volume')

  save.addEventListener('click', () => updateVolume(volume, {
    titleInput,
    slugInput,
    collectionSelect,
    visibility,
    active,
    sortOrder,
    save,
  }))

  const counts = volumeContentCounts(volume, lookups)
  const childSeries = sortByOrderTitle(lookups.seriesByVolume.get(volume.id) || [])
  const children = contentChildrenList(
    'Series',
    childSeries,
    (series) => selectContentItem('series', series.id)
  )

  return [
    detailHeader('Volume', volume.title, `Parent: ${getText(collectionsById.get(volume.collection_id)?.title, 'Unassigned collection')}`),
    detailGrid(
      labeledControl('Title', titleInput),
      labeledControl('Slug', slugInput),
      labeledControl('Parent Collection', collectionSelect),
      labeledControl('Visibility', visibility),
      labeledControl('Global Active', active),
      labeledControl('Sort Order', sortOrder),
      contentReadOnlyField('Series Count', counts.series),
      contentReadOnlyField('Book Count', counts.books)
    ),
    detailActions(save),
    children,
    renderDangerZone('volume', volume, counts),
  ]
}

const renderSeriesDetail = (series, lookups = buildHierarchyLookups()) => {
  if (!series?.id) return []

  const collectionsById = lookups.collectionsById
  const volumesById = lookups.volumesById
  const titleInput = compactInput('text', series.title)
  const collectionSelect = collectionOptionsSelect(series.collection_id)
  const volumeSelect = volumeOptionsSelect(series.volume_id, series.collection_id)
  const slugInput = compactInput('text', series.slug)
  const visibility = visibilitySelect(series.visibility)
  const active = activeSelect(series.is_active)
  const sortOrder = compactInput('number', toSortOrder(series.sort_order))
  const save = contentSaveButton('Save Series')

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

  const books = sortBooksByNumberTitle(lookups.booksBySeries.get(series.id) || [])
  const bookList = renderSeriesBooksDetail(series, books)

  return [
    detailHeader(
      'Series',
      series.title,
      `${getText(collectionsById.get(series.collection_id)?.title, 'Unassigned collection')} / ${getText(volumesById.get(series.volume_id)?.title, 'Unassigned volume')} / ${books.length} books`
    ),
    detailGrid(
      labeledControl('Title', titleInput),
      labeledControl('Slug', slugInput),
      labeledControl('Parent Collection', collectionSelect),
      labeledControl('Parent Volume', volumeSelect),
      labeledControl('Visibility', visibility),
      labeledControl('Global Active', active),
      labeledControl('Sort Order', sortOrder),
      contentReadOnlyField('Book Count', books.length)
    ),
    detailActions(save),
    bookList,
    renderDangerZone('series', series, { books: books.length }),
  ]
}

const renderBookDetail = (book, lookups = buildHierarchyLookups()) => {
  if (!book?.id) return []

  const hierarchy = hierarchyFromLookups(book, lookups)
  const { collection, volume, series } = hierarchy
  const visibility = visibilitySelect(bookVisibility(book))
  const active = activeSelect(book.is_active)
  const save = contentSaveButton('Save Book')

  save.addEventListener('click', () => updateBookContentControls(book, {
    visibility,
    active,
    saveButton: save,
  }))

  return [
    detailHeader('Book', book.title, `Series: ${getText(series?.title, book.series)}`),
    detailGrid(
      contentReadOnlyField('Title', getText(book.title)),
      contentReadOnlyField('Collection', getText(collection?.title, 'Unassigned collection')),
      contentReadOnlyField('Volume', getText(volume?.title, 'Unassigned volume')),
      contentReadOnlyField('Series', getText(series?.title, book.series)),
      contentReadOnlyField('Book Number', getText(book.book_number)),
      contentReadOnlyField('Slug', getText(book.slug)),
      contentReadOnlyField('Effective Hierarchy', hierarchyIsComplete(hierarchy) ? 'Complete' : 'Needs parent links'),
      labeledControl('Visibility', visibility),
      labeledControl('Global Active', active)
    ),
    detailActions(save),
    renderCoverManagement(book),
    renderBookFilesManagement(book),
    renderDangerZone('book', book),
  ]
}

const contentReadOnlyField = (label, value) => {
  const field = createNode('div', 'admin-readonly-field')
  field.append(createNode('span', '', label), createNode('strong', '', getText(value)))
  return field
}

const contentChildrenList = (title, items, onSelect) => {
  const wrap = createNode('section', 'admin-content-children')
  wrap.append(createNode('h4', '', `${title} (${items.length})`))

  if (!items.length) {
    wrap.append(createNode('p', 'admin-empty', `No ${title.toLowerCase()} linked yet.`))
    return wrap
  }

  const list = createNode('div', 'admin-content-child-list')
  items.forEach((item) => {
    const button = createNode('button', 'admin-content-child')
    button.type = 'button'
    button.append(
      createNode('strong', '', getText(item.title)),
      createNode('span', '', `${visibilityLabel(item.visibility)} / ${boolValueLabel(item.is_active)}`)
    )
    button.addEventListener('click', () => onSelect(item))
    list.append(button)
  })
  wrap.append(list)
  return wrap
}

const renderSeriesBooksDetail = (series, books) => {
  const wrap = createNode('section', 'admin-content-children')
  wrap.append(createNode('h4', '', `Books (${books.length})`))

  if (!books.length) {
    wrap.append(createNode('p', 'admin-empty', 'No books linked to this series yet.'))
    return wrap
  }

  const list = createNode('div', 'admin-series-book-list')
  books.forEach((book) => {
    const card = createNode('article', 'admin-series-book-card')

    const title = createNode('div', 'admin-series-book-card__title')
    title.append(
      createNode('strong', '', getText(book.title)),
      createNode('span', '', `Book ${getText(book.book_number)} / ${getText(book.slug)}`)
    )

    card.append(title, bookControlsPanel(book, { activeLabel: 'Active' }))
    list.append(card)
  })
  wrap.append(list)
  return wrap
}

const bookFileRecord = (book, fileType) => {
  return state.bookFiles.find((record) => String(record.book_id) === String(book?.id) && record.file_type === fileType) || null
}

const bookCoverRecord = (book, coverType = 'front_cover') => {
  return state.bookCovers.find((record) => String(record.book_id) === String(book?.id) && record.cover_type === coverType) || null
}

const verifyCurrentAdminRole = async () => {
  if (!state.user?.id) return ''

  const { data, error } = await supabase
    .from('profiles')
    .select('id, display_name, role, created_at')
    .eq('id', state.user.id)
    .maybeSingle()

  if (error) {
    setTableError('profiles', error, 'download role check')
    return ''
  }

  if (!ADMIN_ROLES.has(data?.role)) return ''

  state.profile = { ...state.profile, ...data }
  renderIdentity()
  clearTableError('profiles')
  return data.role
}

const triggerSignedDownload = (url, fileName) => {
  const link = document.createElement('a')
  link.href = url
  link.download = getText(fileName, 'greyveil-file')
  link.target = '_blank'
  link.rel = 'noopener'
  document.body.append(link)
  link.click()
  link.remove()
}

const refreshBookFileMetadata = async (book, fileType) => {
  const { data, error } = await supabase
    .from('book_files')
    .select(BOOK_FILE_SELECT)
    .eq('book_id', book.id)
    .eq('file_type', fileType)
    .maybeSingle()

  if (error) {
    setTableError('book_files', error, 'download metadata check')
    return { record: null, error }
  }

  if (data) replaceRecord(state.bookFiles, 'file_type', data)
  return { record: data || null, error: null }
}

const handleBookFileDownload = async (book, fileType, status, button) => {
  const config = BOOK_FILE_CONFIGS[fileType]
  const previousLabel = button?.textContent

  if (!config) return
  if (!isValidBookId(book?.id) || !bookMap().has(book.id)) {
    setFormStatus(status, 'Selected book id is not valid.', 'error')
    return
  }

  if (button) {
    button.disabled = true
    button.textContent = 'Downloading...'
  }

  const restoreButton = () => {
    if (!button) return
    button.disabled = false
    button.textContent = previousLabel
  }

  const role = await verifyCurrentAdminRole()
  if (!roleCanManageBookFileType(role, fileType)) {
    restoreButton()
    setFormStatus(status, `${config.label} download is not allowed for this admin role.`, 'error')
    return
  }

  const { record, error: metadataError } = await refreshBookFileMetadata(book, fileType)
  if (metadataError) {
    restoreButton()
    setFormStatus(status, 'File metadata could not be verified. Check the dashboard alert for details.', 'error')
    return
  }

  if (!record?.storage_path || String(record.book_id) !== String(book.id) || record.file_type !== fileType) {
    restoreButton()
    setFormStatus(status, `${config.label} is missing for this book.`, 'error')
    renderFilesManager()
    return
  }

  const { data, error } = await supabase.storage
    .from(BOOK_FILE_BUCKET)
    .createSignedUrl(record.storage_path, SIGNED_URL_TTL_SECONDS)

  restoreButton()

  if (error || !data?.signedUrl) {
    setFormStatus(status, 'Signed download could not be created. Check the dashboard alert for details.', 'error')
    setTableError('book_files_storage', error || new Error('Signed URL was not returned.'), 'signed download')
    return
  }

  clearTableError('book_files')
  clearTableError('book_files_storage')
  setFormStatus(status, `${config.label} download opened.`, 'success')
  triggerSignedDownload(data.signedUrl, record.file_name || config.storageName)
}

const replaceRecord = (records, keyName, nextRecord) => {
  const index = records.findIndex((record) => String(record.book_id) === String(nextRecord.book_id) && record[keyName] === nextRecord[keyName])
  if (index >= 0) {
    records[index] = nextRecord
  } else {
    records.unshift(nextRecord)
  }
}

const removeReplacedStorageObject = async (bucketName, previousPath, nextPath) => {
  if (!previousPath || previousPath === nextPath) return

  const { error } = await supabase.storage
    .from(bucketName)
    .remove([previousPath])

  if (error) setTableError(`storage_${bucketName}`, error, 'old file cleanup')
}

const renderManagedFileMeta = (record) => {
  const meta = createNode('p', 'admin-managed-file__meta')
  meta.textContent = record
    ? `${getText(record.file_name)} / ${formatBytes(record.file_size)} / ${formatDate(record.updated_at || record.created_at)}`
    : 'No uploaded file is recorded for this book.'
  return meta
}

const refreshCoverPreview = async (record, image, status, button) => {
  if (!record?.storage_path || !image) return

  const existingTimer = signedPreviewTimers.get(image)
  if (existingTimer) window.clearTimeout(existingTimer)
  signedPreviewTimers.delete(image)

  const previousLabel = button?.textContent
  if (button) {
    button.disabled = true
    button.textContent = 'Loading...'
  }

  const { data, error } = await supabase.storage
    .from(BOOK_COVER_BUCKET)
    .createSignedUrl(record.storage_path, SIGNED_URL_TTL_SECONDS)

  if (button) {
    button.disabled = false
    button.textContent = previousLabel
  }

  if (error || !data?.signedUrl) {
    image.removeAttribute('src')
    image.hidden = true
    setFormStatus(status, 'Preview could not be opened with current storage policies.', 'error')
    setTableError('book_covers_storage', error || new Error('Signed URL was not returned.'), 'signed preview')
    return
  }

  image.referrerPolicy = 'no-referrer'
  image.src = data.signedUrl
  image.hidden = false
  signedPreviewTimers.set(image, window.setTimeout(() => {
    if (image.src === data.signedUrl) {
      image.removeAttribute('src')
      image.hidden = true
      setFormStatus(status, 'Preview expired. Select Preview to refresh it.', 'info')
    }
    signedPreviewTimers.delete(image)
  }, SIGNED_PREVIEW_CLEAR_DELAY))
  setFormStatus(status, 'Preview refreshed for this admin session.', 'success')
}

const handleCoverUpload = async (book, coverType, input, status, button) => {
  if (!ADMIN_ROLES.has(state.profile?.role)) return
  if (!isValidBookId(book?.id) || !bookMap().has(book.id)) {
    setFormStatus(status, 'Selected book id is not valid.', 'error')
    return
  }

  const config = COVER_CONFIGS[coverType]
  const file = input?.files?.[0]
  const validationError = validateManagedFile(file, config, config.label)
  if (validationError) {
    setFormStatus(status, validationError, 'error')
    return
  }

  const previousRecord = bookCoverRecord(book, coverType)
  const storagePath = `${bookStorageFolder(book)}/${config.storageName}.${coverExtensionForFile(file)}`
  const previousLabel = button?.textContent
  if (button) {
    button.disabled = true
    button.textContent = 'Uploading...'
  }

  const uploadResult = await supabase.storage
    .from(BOOK_COVER_BUCKET)
    .upload(storagePath, file, {
      cacheControl: '3600',
      contentType: file.type || 'image/jpeg',
      upsert: true,
    })

  if (uploadResult.error) {
    if (button) {
      button.disabled = false
      button.textContent = previousLabel
    }
    setFormStatus(status, 'Cover upload failed. Check the dashboard alert for details.', 'error')
    setTableError('book_covers_storage', uploadResult.error, 'UPLOAD')
    return
  }

  const payload = {
    book_id: book.id,
    cover_type: coverType,
    storage_path: storagePath,
    file_name: file.name,
    mime_type: file.type || 'application/octet-stream',
    file_size: file.size,
  }
  const { data, error } = await supabase
    .from('book_covers')
    .upsert(payload, { onConflict: 'book_id,cover_type' })
    .select(BOOK_COVER_SELECT)
    .maybeSingle()

  if (button) {
    button.disabled = false
    button.textContent = previousLabel
  }

  if (error) {
    setFormStatus(status, 'Cover uploaded, but metadata could not be saved.', 'error')
    setTableError('book_covers', error, 'UPSERT')
    return
  }

  const nextRecord = data || payload
  replaceRecord(state.bookCovers, 'cover_type', nextRecord)
  await removeReplacedStorageObject(BOOK_COVER_BUCKET, previousRecord?.storage_path, storagePath)
  clearTableError('book_covers')
  clearTableError('book_covers_storage')
  setFormStatus(status, 'Front cover saved.', 'success')
  renderContentManagement()
  renderFilesManager()
}

const handleBookFileUpload = async (book, fileType, input, status, button) => {
  if (!canManageBookFileType(fileType)) return
  if (!isValidBookId(book?.id) || !bookMap().has(book.id)) {
    setFormStatus(status, 'Selected book id is not valid.', 'error')
    return
  }

  const config = BOOK_FILE_CONFIGS[fileType]
  const file = input?.files?.[0]
  const validationError = validateManagedFile(file, config, config.label)
  if (validationError) {
    setFormStatus(status, validationError, 'error')
    return
  }

  const previousRecord = bookFileRecord(book, fileType)
  const storagePath = `${bookStorageFolder(book)}/${config.storageName}`
  const previousLabel = button?.textContent
  if (button) {
    button.disabled = true
    button.textContent = 'Uploading...'
  }

  const uploadResult = await supabase.storage
    .from(BOOK_FILE_BUCKET)
    .upload(storagePath, file, {
      cacheControl: '3600',
      contentType: file.type || 'application/octet-stream',
      upsert: true,
    })

  if (uploadResult.error) {
    if (button) {
      button.disabled = false
      button.textContent = previousLabel
    }
    setFormStatus(status, `${config.label} upload failed. Check the dashboard alert for details.`, 'error')
    setTableError('book_files_storage', uploadResult.error, 'UPLOAD')
    return
  }

  const payload = {
    book_id: book.id,
    file_type: fileType,
    storage_path: storagePath,
    file_name: file.name,
    mime_type: file.type || 'application/octet-stream',
    file_size: file.size,
  }
  const { data, error } = await supabase
    .from('book_files')
    .upsert(payload, { onConflict: 'book_id,file_type' })
    .select(BOOK_FILE_SELECT)
    .maybeSingle()

  if (button) {
    button.disabled = false
    button.textContent = previousLabel
  }

  if (error) {
    setFormStatus(status, `${config.label} uploaded, but metadata could not be saved.`, 'error')
    setTableError('book_files', error, 'UPSERT')
    return
  }

  const nextRecord = data || payload
  replaceRecord(state.bookFiles, 'file_type', nextRecord)
  await removeReplacedStorageObject(BOOK_FILE_BUCKET, previousRecord?.storage_path, storagePath)
  clearTableError('book_files')
  clearTableError('book_files_storage')
  setFormStatus(status, `${config.label} saved.`, 'success')
  renderContentManagement()
  renderFilesManager()
}

const renderCoverManagement = (book) => {
  const section = createNode('section', 'admin-managed-section')
  section.append(
    createNode('p', 'admin-eyebrow', 'Cover'),
    createNode('h4', '', 'Front Cover')
  )

  const coverType = 'front_cover'
  const config = COVER_CONFIGS[coverType]
  const record = bookCoverRecord(book, coverType)
  const card = createNode('article', 'admin-managed-file')
  const preview = createNode('figure', 'admin-cover-preview')
  const image = document.createElement('img')
  image.alt = `${getText(book.title, 'Book')} front cover preview`
  image.hidden = !record
  const missing = createNode('span', 'admin-cover-preview__missing', 'Missing')
  missing.hidden = Boolean(record)
  preview.append(image, missing)

  const statusBadgeClass = record ? 'admin-badge--active' : 'admin-badge--restricted'
  const header = createNode('div', 'admin-managed-file__header')
  header.append(
    createNode('strong', '', config.label),
    hierarchyBadge(record ? 'Ready' : 'Missing', statusBadgeClass)
  )

  const input = document.createElement('input')
  input.type = 'file'
  input.accept = config.accept
  const upload = createNode('button', 'admin-inline-action', record ? 'Replace' : 'Upload')
  upload.type = 'button'
  upload.disabled = true
  const previewButton = createNode('button', 'admin-inline-action', 'Preview')
  previewButton.type = 'button'
  previewButton.disabled = !record
  const status = createNode('p', 'admin-form-status')
  status.setAttribute('role', 'status')
  status.setAttribute('aria-live', 'polite')

  input.addEventListener('change', () => {
    upload.disabled = !input.files?.length
    setFormStatus(status)
  })
  upload.addEventListener('click', () => handleCoverUpload(book, coverType, input, status, upload))
  previewButton.addEventListener('click', () => refreshCoverPreview(bookCoverRecord(book, coverType), image, status, previewButton))

  const actions = createNode('div', 'admin-managed-file__actions')
  actions.append(previewButton, input, upload)
  card.append(preview, createNode('div', 'admin-managed-file__body'))
  card.lastChild.append(header, renderManagedFileMeta(record), actions, status)
  section.append(card)

  if (record) refreshCoverPreview(record, image, status, previewButton)
  return section
}

const renderBookFilesManagement = (book) => {
  const section = createNode('section', 'admin-managed-section')
  section.append(
    createNode('p', 'admin-eyebrow', 'Files'),
    createNode('h4', '', 'Manual Uploads')
  )

  const list = createNode('div', 'admin-managed-file-list')
  Object.entries(BOOK_FILE_CONFIGS).forEach(([fileType, config]) => {
    const record = bookFileRecord(book, fileType)
    const canManage = canManageBookFileType(fileType)
    const card = createNode('article', 'admin-managed-file admin-managed-file--compact')
    const header = createNode('div', 'admin-managed-file__header')
    header.append(
      createNode('strong', '', config.label),
      hierarchyBadge(record ? 'Ready' : 'Missing', record ? 'admin-badge--active' : 'admin-badge--restricted')
    )

    const input = document.createElement('input')
    input.type = 'file'
    input.accept = config.accept
    input.disabled = !canManage
    const download = createNode('button', 'admin-inline-action', 'Download')
    download.type = 'button'
    download.disabled = !canManage || !record
    const upload = createNode('button', 'admin-inline-action', record ? 'Replace' : 'Upload')
    upload.type = 'button'
    upload.disabled = true
    const status = createNode('p', 'admin-form-status')
    status.setAttribute('role', 'status')
    status.setAttribute('aria-live', 'polite')

    input.addEventListener('change', () => {
      upload.disabled = !canManage || !input.files?.length
      setFormStatus(status)
    })
    download.addEventListener('click', () => handleBookFileDownload(book, fileType, status, download))
    upload.addEventListener('click', () => handleBookFileUpload(book, fileType, input, status, upload))

    const actions = createNode('div', 'admin-managed-file__actions')
    if (canManage) {
      if (record) actions.append(download)
      actions.append(input, upload)
    }
    const hint = config.superAdminOnly && !isSuperAdmin()
      ? createNode('p', 'admin-field-hint', 'Super Admin only for this format.')
      : null

    card.append(header, renderManagedFileMeta(record), actions)
    if (hint) card.append(hint)
    card.append(status)
    list.append(card)
  })

  section.append(list)
  return section
}

const renderFilesManager = () => {
  const detail = singleNodes.filesDetail
  if (!detail) return

  const selection = syncFilesSelectionFromControls()
  const book = bookMap().get(selection.bookId) || null
  clearNode(detail)
  setFormStatus(singleNodes.filesStatus)

  if (!book) {
    const placeholder = createNode('article', 'admin-card admin-placeholder admin-files-placeholder')
    placeholder.append(
      createNode('h3', '', 'Select a book.'),
      createNode('p', '', 'Choose a Collection, Volume, Series, and Book to manage private publishing files.')
    )
    detail.append(placeholder)
    return
  }

  const hierarchy = hierarchyFromLookups(book)
  const summary = createNode('article', 'admin-card admin-files-book-summary')
  const title = createNode('div', 'admin-files-book-summary__title')
  title.append(
    createNode('p', 'admin-eyebrow', 'Selected Book'),
    createNode('h3', '', getText(book.title)),
    createNode('span', '', `Book ${getText(book.book_number)} / ${getText(book.slug)}`)
  )
  const meta = createNode('div', 'admin-book-card__badges')
  meta.append(
    hierarchyBadge(getText(hierarchy.collection?.title, 'Unassigned collection')),
    hierarchyBadge(getText(hierarchy.volume?.title, 'Unassigned volume')),
    hierarchyBadge(getText(hierarchy.series?.title, book.series)),
    hierarchyBadge(visibilityLabel(bookVisibility(book))),
    hierarchyBadge(boolValueLabel(book.is_active), book.is_active === false ? 'admin-badge--disabled' : 'admin-badge--active')
  )
  summary.append(title, meta)

  const coverSection = renderCoverManagement(book)
  const filesSection = renderBookFilesManagement(book)
  coverSection.classList.add('admin-files-cover-section')
  filesSection.classList.add('admin-files-files-section')

  detail.append(summary, coverSection, filesSection)
  setFormStatus(singleNodes.filesStatus, `Loaded file status for ${getText(book.title)}.`, 'success')
}

const deleteDependencyText = (kind, counts = {}) => {
  if (kind === 'collection') return `${counts.volumes} volumes / ${counts.series} series / ${counts.books} books`
  if (kind === 'volume') return `${counts.series} series / ${counts.books} books`
  if (kind === 'series') return `${counts.books} books`
  return 'Book row only. Existing foreign keys may still block deletion.'
}

const canDeleteContentItem = (kind, counts = {}) => {
  if (kind === 'collection') return !counts.volumes && !counts.series && !counts.books
  if (kind === 'volume') return !counts.series && !counts.books
  if (kind === 'series') return !counts.books
  return kind === 'book'
}

const currentDeleteCounts = (kind, item, lookups = buildHierarchyLookups()) => {
  if (kind === 'collection') return collectionContentCounts(item, lookups)
  if (kind === 'volume') return volumeContentCounts(item, lookups)
  if (kind === 'series') return { books: (lookups.booksBySeries.get(item.id) || []).length }
  return {}
}

const deleteTableForKind = (kind) => {
  return {
    collection: 'collections',
    volume: 'volumes',
    series: 'series',
    book: 'books',
  }[kind] || ''
}

const removeDeletedContentFromState = (kind, id) => {
  if (kind === 'collection') state.collections = state.collections.filter((item) => item.id !== id)
  if (kind === 'volume') state.volumes = state.volumes.filter((item) => item.id !== id)
  if (kind === 'series') state.seriesItems = state.seriesItems.filter((item) => item.id !== id)
  if (kind === 'book') {
    state.books = state.books.filter((item) => item.id !== id)
    state.bookFiles = state.bookFiles.filter((item) => String(item.book_id) !== String(id))
    state.bookCovers = state.bookCovers.filter((item) => String(item.book_id) !== String(id))
  }
}

const handleDeleteContent = async (kind, item, status, button) => {
  if (!ADMIN_ROLES.has(state.profile?.role)) return
  if (!isValidBookId(item?.id)) {
    setFormStatus(status, 'Selected row id is not valid.', 'error')
    return
  }

  const counts = currentDeleteCounts(kind, item)
  if (!canDeleteContentItem(kind, counts)) {
    setFormStatus(status, `Delete blocked: ${deleteDependencyText(kind, counts)} still linked.`, 'error')
    return
  }

  const label = getText(item.title, `this ${kind}`)
  const token = kind === 'book' ? 'DELETE BOOK' : 'DELETE'
  const confirmed = window.prompt(`Type ${token} to permanently delete "${label}".`) === token
  if (!confirmed) return

  const table = deleteTableForKind(kind)
  const previousLabel = button?.textContent
  if (button) {
    button.disabled = true
    button.textContent = 'Deleting...'
  }

  const { error } = await supabase
    .from(table)
    .delete()
    .eq('id', item.id)

  if (button) {
    button.disabled = false
    button.textContent = previousLabel
  }

  if (error) {
    setFormStatus(status, `${label} could not be deleted. Existing related rows or policy rules may be blocking it.`, 'error')
    setTableError(table, error, 'DELETE')
    return
  }

  removeDeletedContentFromState(kind, item.id)
  state.contentSelection = { kind: '', id: '' }
  clearTableError(table)
  setFormStatus(status, `${label} deleted.`, 'success')
  populateFilters()
  renderHierarchyDependentSections()
}

const renderDangerZone = (kind, item, counts = {}) => {
  const section = createNode('section', 'admin-danger-zone')
  const status = createNode('p', 'admin-form-status')
  status.setAttribute('role', 'status')
  status.setAttribute('aria-live', 'polite')
  const canDelete = canDeleteContentItem(kind, counts)
  const button = createNode('button', 'admin-action admin-action--danger', `Delete ${kind.charAt(0).toUpperCase()}${kind.slice(1)}`)
  button.type = 'button'
  button.disabled = !canDelete
  button.addEventListener('click', () => handleDeleteContent(kind, item, status, button))

  section.append(
    createNode('p', 'admin-eyebrow', 'Danger Zone'),
    createNode('h4', '', `Delete ${kind.charAt(0).toUpperCase()}${kind.slice(1)}`),
    createNode(
      'p',
      'admin-panel-note',
      canDelete
        ? 'Deletion is permanent and uses existing foreign keys and RLS policies. No parent hierarchy is deleted automatically.'
        : `Delete blocked until dependencies are removed: ${deleteDependencyText(kind, counts)}.`
    ),
    button,
    status
  )

  return section
}

const renderContentDetail = () => {
  const detail = singleNodes.contentDetail
  if (!detail) return

  const { kind, id } = state.contentSelection
  let nodes = []

  try {
    const lookups = buildHierarchyLookups()
    if (kind === 'collection') nodes = renderCollectionDetail(lookups.collectionsById.get(id), lookups)
    if (kind === 'volume') nodes = renderVolumeDetail(lookups.volumesById.get(id), lookups)
    if (kind === 'series') nodes = renderSeriesDetail(lookups.seriesById.get(id), lookups)
    if (kind === 'book') nodes = renderBookDetail(lookups.booksById.get(id), lookups)
  } catch (error) {
    console.error('Greyveil admin content detail render failed:', error)
    nodes = [
      createNode('h3', '', 'Content detail could not be rendered.'),
      createNode('p', 'admin-panel-note', 'Refresh the dashboard and try selecting the item again. Supabase row-level security and missing parent rows are reported in the alerts above when available.'),
    ]
  }

  if (!nodes.length) {
    nodes = kind && id
      ? [
          createNode('h3', '', 'Selected content is unavailable.'),
          createNode('p', 'admin-panel-note', 'This row may have been removed, blocked by Supabase policy, or missing required hierarchy data. Refresh the dashboard or choose another item.'),
        ]
      : [
          createNode('h3', '', 'Select a content item.'),
          createNode('p', 'admin-panel-note', 'Choose a Collection, Volume, Series, or Book from the navigator to edit its settings.'),
        ]
  }

  clearNode(detail)
  nodes.forEach((node) => detail.append(node))
}

const renderContentManagement = () => {
  ensureContentSelection()
  if (singleNodes.collectionsCount) {
    const total = state.collections.length
    singleNodes.collectionsCount.textContent = `${total} ${total === 1 ? 'collection' : 'collections'}`
  }
  if (singleNodes.volumesCount) {
    const total = state.volumes.length
    singleNodes.volumesCount.textContent = `${total} ${total === 1 ? 'volume' : 'volumes'}`
  }
  if (singleNodes.seriesCount) {
    const total = state.seriesItems.length
    singleNodes.seriesCount.textContent = `${total} ${total === 1 ? 'series' : 'series'}`
  }
  renderContentNavigator()
  renderContentDetail()
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
  renderHierarchyDependentSections()
}

const updateVolume = async (volume, controls) => {
  if (!ADMIN_ROLES.has(state.profile?.role)) return

  const updates = {
    collection_id: controls.collectionSelect?.value || volume.collection_id,
    title: controls.titleInput?.value.trim() || volume.title,
    slug: controls.slugInput?.value.trim() || volume.slug,
    visibility: normalizeVisibility(controls.visibility.value),
    is_active: boolFromSelect(controls.active.value),
    sort_order: toSortOrder(controls.sortOrder.value),
  }

  if (!updates.collection_id || !updates.title || !updates.slug) {
    setTableError('volumes', new Error('Volume collection, title, and slug are required.'), 'UPDATE')
    return
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
  renderHierarchyDependentSections()
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
  renderHierarchyDependentSections()
}

const selectedBookFilters = () => ({
  collectionId: singleNodes.bookFilterCollection?.value || '',
  volumeId: singleNodes.bookFilterVolume?.value || '',
  seriesId: singleNodes.bookFilterSeries?.value || '',
})

const filteredBooksForAdmin = (lookups = buildHierarchyLookups()) => {
  const filters = selectedBookFilters()

  return sortBooksByNumberTitle(state.books.filter((book) => {
    const hierarchy = hierarchyFromLookups(book, lookups)
    return (!filters.collectionId || hierarchy.collection?.id === filters.collectionId)
      && (!filters.volumeId || hierarchy.volume?.id === filters.volumeId)
      && (!filters.seriesId || hierarchy.series?.id === filters.seriesId)
  }))
}

const groupedBooksBySeries = (books, lookups = buildHierarchyLookups()) => {
  const groupsByKey = new Map()

  books.forEach((book) => {
    const hierarchy = hierarchyFromLookups(book, lookups)
    const groupKey = hierarchy.series?.id || `unassigned::${getText(book.series, 'books')}`

    if (!groupsByKey.has(groupKey)) {
      groupsByKey.set(groupKey, {
        key: groupKey,
        collection: hierarchy.collection,
        volume: hierarchy.volume,
        series: hierarchy.series,
        seriesLabel: getText(hierarchy.series?.title, getText(book.series, 'Books Without Series')),
        books: [],
      })
    }

    groupsByKey.get(groupKey).books.push(book)
  })

  return Array.from(groupsByKey.values()).sort((a, b) => {
    return getText(a.collection?.title, '').localeCompare(getText(b.collection?.title, ''))
      || toSortOrder(a.volume?.sort_order) - toSortOrder(b.volume?.sort_order)
      || getText(a.volume?.title, '').localeCompare(getText(b.volume?.title, ''))
      || toSortOrder(a.series?.sort_order) - toSortOrder(b.series?.sort_order)
      || a.seriesLabel.localeCompare(b.seriesLabel)
  })
}

const renderBooksTableFallback = (books) => {
  const table = singleNodes.booksTable
  clearNode(table)
  if (!table) return
  if (table.closest('[hidden]')) return

  books.forEach((book) => {
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

  applyResponsiveTableLabels(table)
}

const renderBookGroups = (books, lookups = buildHierarchyLookups()) => {
  const list = singleNodes.booksGroupList
  clearNode(list)
  if (!list) return

  const groups = groupedBooksBySeries(books, lookups)
  groups.forEach((group) => {
    const section = createNode('section', 'admin-book-group')
    const header = createNode('div', 'admin-book-group__header')
    const title = createNode('div')
    const parentLine = [
      getText(group.collection?.title, 'Unassigned collection'),
      getText(group.volume?.title, 'Unassigned volume'),
    ].join(' / ')

    title.append(
      createNode('h3', '', group.seriesLabel),
      createNode('p', '', parentLine)
    )
    header.append(
      title,
      createNode('span', 'admin-badge', `${group.books.length} ${group.books.length === 1 ? 'book' : 'books'}`)
    )

    const cards = createNode('div', 'admin-book-card-grid')
    sortBooksByNumberTitle(group.books).forEach((book) => {
      const card = createNode('article', 'admin-book-card')
      const details = createNode('div', 'admin-book-card__details')
      details.append(
        createNode('strong', '', getText(book.title)),
        createNode('span', '', `Book ${getText(book.book_number)} / ${getText(book.slug)}`)
      )

      const badges = createNode('div', 'admin-book-card__badges')
      badges.append(
        hierarchyBadge(visibilityLabel(bookVisibility(book))),
        hierarchyBadge(boolValueLabel(book.is_active), book.is_active === false ? 'admin-badge--disabled' : 'admin-badge--active')
      )

      card.append(details, badges, bookControlsPanel(book))
      cards.append(card)
    })

    section.append(header, cards)
    list.append(section)
  })
}

const renderBooks = () => {
  const lookups = buildHierarchyLookups()
  const books = filteredBooksForAdmin(lookups)

  renderBooksTableFallback(books)
  renderBookGroups(books, lookups)

  if (singleNodes.booksCount) {
    const total = state.counts.books ?? state.books.length
    const visible = books.length
    singleNodes.booksCount.textContent = visible === total
      ? `${total} ${total === 1 ? 'book' : 'books'}`
      : `${visible} of ${total} books`
  }

  if (singleNodes.booksEmpty) {
    singleNodes.booksEmpty.hidden = Boolean(books.length) || Boolean(state.errors.books)
  }
}

const bookControlField = (label, control) => {
  const field = createNode('label', 'admin-book-control')
  field.append(createNode('span', '', label), control)
  return field
}

const bookControlsPanel = (book, options = {}) => {
  const actions = createNode('div', 'admin-book-controls')
  const visibility = visibilitySelect(bookVisibility(book))
  const active = activeSelect(book.is_active)
  const saveButton = createNode('button', 'admin-inline-action admin-book-save', 'Save')
  const saveWrap = createNode('div', 'admin-book-control admin-book-control--save')

  saveButton.type = 'button'
  saveButton.addEventListener('click', () => updateBookContentControls(book, {
    visibility,
    active,
    saveButton,
  }))

  saveWrap.append(saveButton)
  actions.append(
    bookControlField('Visibility', visibility),
    bookControlField(options.activeLabel || 'Global Active', active),
    saveWrap
  )
  return actions
}

const bookControlsCell = (book) => {
  const cell = document.createElement('td')
  const actions = bookControlsPanel(book)
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
  renderHierarchyDependentSections()
}

const profileMap = () => new Map(state.users.map((profile) => [profile.id, profile]))
const paymentCustomerMap = () => new Map(state.paymentCustomers.map((profile) => [profile.id, profile]))

const bookMap = () => {
  const map = new Map()
  state.books.forEach((book) => {
    map.set(book.id, book)
    map.set(String(book.id), book)
  })
  return map
}

const effectiveBookHierarchyVisibility = (hierarchy) => {
  return effectiveVisibility({
    collection: hierarchy.collection,
    volume: hierarchy.volume,
    series: hierarchy.series,
    book: hierarchy.book ? { ...hierarchy.book, visibility: bookVisibility(hierarchy.book) } : null,
  })
}

const customerEligibleBooksForSeries = (series) => {
  if (!series?.id) return []

  return booksForSeries(series).filter((book) => {
    const hierarchy = hierarchyForBook(book, state.seriesItems, state.collections, state.volumes)
    return book.is_active === true
      && hierarchyIsComplete(hierarchy)
      && hierarchyIsActive(hierarchy)
      && effectiveBookHierarchyVisibility(hierarchy) !== 'private'
  })
}

const grantIsReadableNow = (grant) => {
  return grant?.is_visible === true
    && grant?.can_read === true
    && isAccessActive(grant)
}

const selectedSeriesAccessContext = () => {
  const userId = singleNodes.accessUser?.value || ''
  const seriesId = singleNodes.seriesAccessSeries?.value || ''
  const profile = profileMap().get(userId)
  const series = seriesMap().get(seriesId)
  const books = series ? booksForSeries(series) : []
  const eligibleBooks = series ? customerEligibleBooksForSeries(series) : []
  const eligibleIds = new Set(eligibleBooks.map((book) => book.id))
  const currentCount = state.accessGrants.filter((grant) => {
    return grant.user_id === userId
      && eligibleIds.has(grant.book_id)
      && grantIsReadableNow(grant)
  }).length

  return {
    userId,
    profile,
    seriesId,
    series,
    books,
    eligibleBooks,
    currentCount,
  }
}

const seriesAccessStateLabel = (current, total) => {
  if (!total || current === 0) return 'No Access'
  if (current >= total) return 'Full Series Access'
  return 'Partial Access'
}

const renderSeriesAccessStatus = () => {
  const summary = singleNodes.seriesAccessSummary
  if (!summary) return

  clearNode(summary)
  const context = selectedSeriesAccessContext()

  if (!context.userId || !context.series) {
    summary.append(
      createNode('strong', '', 'No Access'),
      createNode('span', '', 'Select a customer and series to calculate access.')
    )
    return
  }

  const label = seriesAccessStateLabel(context.currentCount, context.eligibleBooks.length)
  const excluded = Math.max(0, context.books.length - context.eligibleBooks.length)
  const detailParts = [
    `${context.currentCount} / ${context.eligibleBooks.length} eligible books`,
  ]
  if (excluded) detailParts.push(`${excluded} inactive or private book${excluded === 1 ? '' : 's'} excluded`)

  summary.append(
    createNode('strong', '', label),
    createNode('span', '', detailParts.join(' - '))
  )
}

const handleGrantSeriesAccess = async (event) => {
  event.preventDefault()
  if (!ADMIN_ROLES.has(state.profile?.role)) return

  const context = selectedSeriesAccessContext()
  if (!context.userId || !context.series) {
    setFormStatus(singleNodes.seriesAccessStatus, 'Select a customer and series first.', 'error')
    return
  }

  if (!context.eligibleBooks.length) {
    setFormStatus(singleNodes.seriesAccessStatus, 'No eligible active public/paid books are available in this series.', 'error')
    return
  }

  const button = event.submitter || singleNodes.seriesAccessForm?.querySelector('[data-series-access-grant]')
  const previousLabel = button?.textContent
  if (button) {
    button.disabled = true
    button.textContent = 'Granting...'
  }

  const grantedAt = new Date().toISOString()
  const expiresAt = fromDateTimeLocal(singleNodes.seriesAccessExpires?.value)
  const payloads = context.eligibleBooks.map((book) => ({
    user_id: context.userId,
    book_id: book.id,
    granted_by: state.user.id,
    access_type: singleNodes.seriesAccessType?.value || 'manual',
    granted_at: grantedAt,
    expires_at: expiresAt,
    is_visible: true,
    can_read: true,
  }))

  const { data, error } = await supabase
    .from('book_access')
    .upsert(payloads, { onConflict: 'user_id,book_id' })
    .select('user_id, book_id, granted_by, access_type, granted_at, expires_at, is_visible, can_read')

  if (button) {
    button.disabled = false
    button.textContent = previousLabel
  }

  if (error) {
    setFormStatus(singleNodes.seriesAccessStatus, 'Series access could not be granted. Check the dashboard alert for details.', 'error')
    setTableError('book_access', error, 'UPSERT')
    return
  }

  const updatedRows = data?.length ? data : payloads
  const updatedKeys = new Set(payloads.map(accessKey))
  state.accessGrants = [
    ...updatedRows,
    ...state.accessGrants.filter((grant) => !updatedKeys.has(accessKey(grant))),
  ]
  state.counts.accessGrants = activeAccessGrantCount()
  clearTableError('book_access')
  setFormStatus(
    singleNodes.seriesAccessStatus,
    `${getText(context.series.title)} granted to ${getText(context.profile?.display_name, 'selected customer')} - ${payloads.length} books updated.`,
    'success'
  )
  renderDashboard()
  renderAccessGrants()
  renderSeriesAccessStatus()
  window.dispatchEvent(new CustomEvent('greyveil:access-changed', { detail: { userId: context.userId } }))
}

const handleRevokeSeriesAccess = async () => {
  if (!ADMIN_ROLES.has(state.profile?.role)) return

  const context = selectedSeriesAccessContext()
  if (!context.userId || !context.series) {
    setFormStatus(singleNodes.seriesAccessStatus, 'Select a customer and series first.', 'error')
    return
  }

  const bookIds = context.books.map((book) => book.id).filter(Boolean)
  if (!bookIds.length) {
    setFormStatus(singleNodes.seriesAccessStatus, 'This series has no books to revoke.', 'error')
    return
  }

  const profileName = getText(context.profile?.display_name, 'selected customer')
  if (!window.confirm(`Revoke access to all ${bookIds.length} books in ${getText(context.series.title)} for ${profileName}?`)) return

  const button = singleNodes.seriesAccessRevoke
  const previousLabel = button?.textContent
  if (button) {
    button.disabled = true
    button.textContent = 'Revoking...'
  }

  const { error } = await supabase
    .from('book_access')
    .delete()
    .eq('user_id', context.userId)
    .in('book_id', bookIds)

  if (button) {
    button.disabled = false
    button.textContent = previousLabel
  }

  if (error) {
    setFormStatus(singleNodes.seriesAccessStatus, 'Series access could not be revoked. Check the dashboard alert for details.', 'error')
    setTableError('book_access', error, 'DELETE')
    return
  }

  const revokedIds = new Set(bookIds)
  state.accessGrants = state.accessGrants.filter((grant) => {
    return grant.user_id !== context.userId || !revokedIds.has(grant.book_id)
  })
  state.counts.accessGrants = activeAccessGrantCount()
  clearTableError('book_access')
  setFormStatus(
    singleNodes.seriesAccessStatus,
    `${getText(context.series.title)} access revoked for ${profileName}.`,
    'success'
  )
  renderDashboard()
  renderAccessGrants()
  renderSeriesAccessStatus()
  window.dispatchEvent(new CustomEvent('greyveil:access-changed', { detail: { userId: context.userId } }))
}

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

  applyResponsiveTableLabels(table)

  if (singleNodes.accessEmpty) {
    singleNodes.accessEmpty.hidden = Boolean(state.accessGrants.length) || Boolean(state.errors.book_access)
  }
}

const accessUserCell = (profile, userId) => {
  const cell = document.createElement('td')
  const name = createNode('strong', '', getText(profile?.display_name, 'Unnamed reader'))
  const details = document.createElement('details')
  details.className = 'admin-advanced-details'
  details.append(
    createNode('summary', '', 'Details'),
    createNode('code', 'admin-id', `User ID: ${getText(userId)}`)
  )
  cell.append(name, details)
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

  const userId = singleNodes.accessUser?.value || ''
  const bookId = singleNodes.accessBook?.value || ''

  if (!userId || !bookId) {
    setFormStatus(singleNodes.accessFormStatus, 'Please select a customer and a book.', 'error')
    return
  }

  if (!form.checkValidity()) {
    setFormStatus(singleNodes.accessFormStatus, 'Please select a user and a book.', 'error')
    form.reportValidity()
    return
  }

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
  renderSeriesAccessStatus()
  window.dispatchEvent(new CustomEvent('greyveil:access-changed', { detail: { userId } }))
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
  renderSeriesAccessStatus()
  window.dispatchEvent(new CustomEvent('greyveil:access-changed', { detail: { userId: grant.user_id } }))
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
  renderSeriesAccessStatus()
  window.dispatchEvent(new CustomEvent('greyveil:access-changed', { detail: { userId: grant.user_id } }))
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

const feedbackSection = (label, ...children) => {
  const section = createNode('div', 'feedback-card__section')
  section.append(createNode('span', 'feedback-card__section-label', label), ...children)
  return section
}

const feedbackStatusValue = (feedback) => {
  return STATUS_OPTIONS.includes(feedback?.status) ? feedback.status : 'new'
}

const feedbackStatusActionLabel = (status) => {
  if (status === 'new') return 'Mark New'
  if (status === 'reviewed') return 'Mark Reviewed'
  if (status === 'archived') return 'Archive'
  return getText(status)
}

const feedbackDetailField = (label, value, options = {}) => {
  const field = createNode('div', `feedback-detail-field ${options.secondary ? 'feedback-detail-field--secondary' : ''}`.trim())
  field.append(
    createNode('span', '', label),
    createNode(options.multiline ? 'p' : 'strong', '', getText(value))
  )
  return field
}

const feedbackReviewPreview = (feedback) => {
  const review = getText(feedback['Reviews '], 'No review text provided.')
  return review.length > 170 ? `${review.slice(0, 167).trim()}...` : review
}

const closeFeedbackDrawer = () => {
  document.removeEventListener('keydown', handleFeedbackDrawerKeydown)
  const drawer = document.querySelector('.feedback-detail-modal')
  drawer?.remove()

  const returnTarget = state.feedbackDrawer.returnFocus?.isConnected
    ? state.feedbackDrawer.returnFocus
    : singleNodes.feedbackList?.querySelector('.feedback-card__button')
  state.feedbackDrawer.feedback = null
  state.feedbackDrawer.returnFocus = null
  returnTarget?.focus({ preventScroll: true })
}

const handleFeedbackDrawerKeydown = (event) => {
  if (event.key === 'Escape') closeFeedbackDrawer()
}

const refreshFeedbackDrawer = () => {
  const activeFeedback = state.feedbackDrawer.feedback
  if (!activeFeedback || !document.querySelector('.feedback-detail-modal')) return
  openFeedbackDrawer(activeFeedback, state.feedbackDrawer.returnFocus, { preserveFocus: true })
}

const openFeedbackDrawer = (feedback, trigger, options = {}) => {
  state.feedbackDrawer.feedback = feedback
  state.feedbackDrawer.returnFocus = trigger || state.feedbackDrawer.returnFocus || document.activeElement

  document.removeEventListener('keydown', handleFeedbackDrawerKeydown)
  document.querySelector('.feedback-detail-modal')?.remove()

  const currentStatus = feedbackStatusValue(feedback)
  const overlay = createNode('div', 'feedback-detail-modal')
  overlay.setAttribute('role', 'presentation')

  const drawer = createNode('aside', 'feedback-detail-drawer')
  drawer.setAttribute('role', 'dialog')
  drawer.setAttribute('aria-modal', 'true')
  drawer.setAttribute('aria-labelledby', 'feedback-detail-title')

  const header = createNode('div', 'feedback-detail-drawer__header')
  const title = createNode('div')
  title.append(
    createNode('p', 'admin-eyebrow', 'Reader Response'),
    createNode('h3', '', getText(feedback.Book, 'Greyveil Feedback'))
  )
  title.querySelector('h3').id = 'feedback-detail-title'

  const closeButton = createNode('button', 'admin-action', 'Close')
  closeButton.type = 'button'
  closeButton.addEventListener('click', closeFeedbackDrawer)
  header.append(title, closeButton)

  const statusRow = createNode('div', 'feedback-detail-drawer__status')
  statusRow.append(
    statusBadge(currentStatus),
    createNode('span', '', `Updated in list as ${currentStatus}`)
  )

  const fields = createNode('div', 'feedback-detail-grid')
  fields.append(
    feedbackDetailField('Name', feedback.Name),
    feedbackDetailField('Rating', `${formatRating(feedback.Rate)} / 5`),
    feedbackDetailField('Review', feedback['Reviews '], { multiline: true }),
    feedbackDetailField('Book', feedback.Book),
    feedbackDetailField('Series', feedback.Series),
    feedbackDetailField('Collection', feedback.Collection),
    feedbackDetailField('Occupation', feedback['Occupation ']),
    feedbackDetailField('Date', formatDate(feedback['Date & time'])),
    feedbackDetailField('Email', feedback.Email, { secondary: true }),
    feedbackDetailField('Status', currentStatus)
  )

  const actions = createNode('div', 'feedback-detail-actions')
  STATUS_OPTIONS.forEach((status) => {
    const button = createNode('button', `admin-action ${status === 'reviewed' ? 'admin-action--primary' : ''}`.trim(), feedbackStatusActionLabel(status))
    button.type = 'button'
    button.disabled = !feedback.id || currentStatus === status
    button.addEventListener('click', () => updateFeedbackStatus(feedback, status, button))
    actions.append(button)
  })

  const storyActions = createNode('div', 'feedback-detail-actions feedback-detail-actions--story')
  const previewButton = createNode('button', 'admin-action', 'Preview Story')
  const storyButton = createNode('button', 'admin-action admin-action--primary', 'Download Story PNG')
  previewButton.type = 'button'
  storyButton.type = 'button'
  previewButton.addEventListener('click', () => previewFeedbackStory(feedback, previewButton))
  storyButton.addEventListener('click', () => downloadFeedbackStory(feedback, storyButton))
  storyActions.append(previewButton, storyButton)

  if (!feedback.id) {
    actions.append(createNode('p', 'admin-empty', 'Status update needs a feedback row id.'))
  }

  drawer.append(header, statusRow, fields, actions, storyActions)
  overlay.append(drawer)
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) closeFeedbackDrawer()
  })
  document.body.append(overlay)
  document.addEventListener('keydown', handleFeedbackDrawerKeydown)

  if (!options.preserveFocus) closeButton.focus({ preventScroll: true })
}

const feedbackCard = (feedback) => {
  const card = createNode('article', 'feedback-card')
  const button = createNode('button', 'feedback-card__button')
  button.type = 'button'
  button.setAttribute('aria-label', `Open feedback from ${getText(feedback.Name, 'Anonymous')} for ${getText(feedback.Book, 'Greyveil')}`)
  button.addEventListener('click', () => openFeedbackDrawer(feedback, button))

  const heading = createNode('div', 'feedback-card__heading')
  const identity = createNode('div')
  identity.append(
    createNode('strong', '', getText(feedback.Name, 'Anonymous')),
    createNode('span', '', getText(feedback.Book, 'General feedback'))
  )
  const rating = createNode('span', 'feedback-card__compact-rating', `${formatRating(feedback.Rate)} / 5`)
  heading.append(identity, rating)

  const review = createNode('p', 'feedback-card__review', feedbackReviewPreview(feedback))
  const meta = createNode('div', 'feedback-card__compact-meta')
  meta.append(
    createNode('span', '', getText(feedback.Series, 'No series')),
    createNode('span', '', formatDate(feedback['Date & time'])),
    statusBadge(feedbackStatusValue(feedback))
  )

  button.append(heading, review, meta)
  card.append(button)
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

const wrapCanvasTextDetailed = (context, text, maxWidth, maxLines = Number.POSITIVE_INFINITY) => {
  const words = getText(text, '').split(/\s+/).filter(Boolean)
  const lines = []
  let currentLine = ''
  let truncated = false

  for (const word of words) {
    const candidate = currentLine ? `${currentLine} ${word}` : word

    if (context.measureText(candidate).width <= maxWidth) {
      currentLine = candidate
      continue
    }

    if (currentLine) {
      lines.push(currentLine)
      currentLine = word
    } else {
      lines.push(fitCanvasLine(context, word, maxWidth))
      currentLine = ''
    }

    if (lines.length >= maxLines) {
      truncated = true
      currentLine = ''
      break
    }
  }

  if (!truncated && currentLine) {
    if (lines.length < maxLines) {
      lines.push(currentLine)
    } else {
      truncated = true
    }
  }

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

  return {
    lines: lines.map((line) => fitCanvasLine(context, line, maxWidth)),
    truncated,
  }
}

const wrapCanvasText = (context, text, maxWidth, maxLines) => {
  return wrapCanvasTextDetailed(context, text, maxWidth, maxLines).lines
}

const drawWrappedText = (context, lines, x, y, lineHeight) => {
  lines.forEach((line, index) => {
    context.fillText(line, x, y + index * lineHeight)
  })
}

const drawSpacedText = (context, text, x, y, spacing = 4) => {
  let cursor = x
  Array.from(text).forEach((character) => {
    context.fillText(character, cursor, y)
    cursor += context.measureText(character).width + spacing
  })
}

const storyThemeForFeedback = (feedback) => {
  const source = normalize(`${feedback.Series || ''} ${feedback.Book || ''}`)

  if (source.includes('mind') || source.includes('paradox') || source.includes('human')) {
    return {
      paper: '#f6f4ef',
      ink: '#253544',
      muted: 'rgba(37, 53, 68, 0.64)',
      panel: 'rgba(255, 255, 255, 0.78)',
      accent: '#6c9a8b',
      accentDeep: '#2f5f61',
      accentSoft: 'rgba(108, 154, 139, 0.18)',
      warm: '#9d704b',
    }
  }

  if (source.includes('shift') || source.includes('veil') || source.includes('night')) {
    return {
      paper: '#f7f3ed',
      ink: '#26313d',
      muted: 'rgba(38, 49, 61, 0.64)',
      panel: 'rgba(255, 255, 255, 0.76)',
      accent: '#8c6a4a',
      accentDeep: '#6d4b34',
      accentSoft: 'rgba(140, 106, 74, 0.17)',
      warm: '#6c9a8b',
    }
  }

  if (source.includes('fiction') || source.includes('dream') || source.includes('echo')) {
    return {
      paper: '#f8f5f1',
      ink: '#2f3541',
      muted: 'rgba(47, 53, 65, 0.64)',
      panel: 'rgba(255, 255, 255, 0.77)',
      accent: '#a7725f',
      accentDeep: '#774e45',
      accentSoft: 'rgba(167, 114, 95, 0.16)',
      warm: '#6f927e',
    }
  }

  return {
    paper: '#f8f7f4',
    ink: '#2a3440',
    muted: 'rgba(42, 52, 64, 0.64)',
    panel: 'rgba(255, 255, 255, 0.76)',
    accent: '#8c6a4a',
    accentDeep: '#6d4b34',
    accentSoft: 'rgba(140, 106, 74, 0.16)',
    warm: '#6c9a8b',
  }
}

const ratingStars = (value) => {
  const rating = Math.max(0, Math.min(5, Math.round(Number(value) || 0)))
  return `${'\u2605'.repeat(rating)}${'\u2606'.repeat(5 - rating)}`
}

const fitStoryReview = (context, review, maxWidth, maxHeight) => {
  let fallback = {
    fontSize: 38,
    lineHeight: 48,
    lines: [],
  }

  for (let fontSize = 70; fontSize >= 38; fontSize -= 4) {
    const lineHeight = Math.round(fontSize * 1.18)
    const maxLines = Math.max(4, Math.floor(maxHeight / lineHeight))
    context.font = `600 ${fontSize}px Cormorant Garamond, Georgia, serif`
    const result = wrapCanvasTextDetailed(context, review, maxWidth, maxLines)
    fallback = {
      fontSize,
      lineHeight,
      lines: result.lines,
    }
    if (!result.truncated) return fallback
  }

  return fallback
}

const drawStoryTexture = (context, theme) => {
  context.save()
  context.fillStyle = theme.ink
  for (let index = 0; index < 140; index += 1) {
    const x = (index * 79) % 1080
    const y = (index * 149) % 1920
    const alpha = 0.018 + ((index % 5) * 0.004)
    context.globalAlpha = alpha
    context.fillRect(x, y, 2, 2)
  }
  context.restore()
}

const drawStoryMeta = (context, label, value, x, y, maxWidth, theme, size = 48) => {
  context.font = '800 22px Inter, Arial, sans-serif'
  context.fillStyle = theme.accentDeep
  drawSpacedText(context, label.toUpperCase(), x, y, 2.5)
  context.font = `700 ${size}px Cormorant Garamond, Georgia, serif`
  context.fillStyle = theme.ink
  const lines = wrapCanvasText(context, getText(value, 'Untitled'), maxWidth, 2)
  drawWrappedText(context, lines, x, y + 62, Math.round(size * 1.02))
  return y + 62 + lines.length * Math.round(size * 1.02)
}

const createFeedbackStoryCanvas = (feedback) => {
  const canvas = document.createElement('canvas')
  canvas.width = 1080
  canvas.height = 1920
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Canvas export is not available in this browser.')
  drawFeedbackStory(context, feedback)
  return canvas
}

const storyDownloadName = (feedback) => {
  return `greyveil-feedback-${slugify(feedback.Book)}-${slugify(feedback.Name)}.png`
}

const triggerStoryDownload = (canvas, feedback) => {
  const link = document.createElement('a')
  link.download = storyDownloadName(feedback)
  link.href = canvas.toDataURL('image/png')
  link.click()
}

const downloadFeedbackStory = async (feedback, button) => {
  const previousLabel = button?.textContent
  if (button) {
    button.disabled = true
    button.textContent = 'Preparing PNG...'
  }

  try {
    triggerStoryDownload(createFeedbackStoryCanvas(feedback), feedback)
  } catch (error) {
    setTableError('feedback_story_export', error, 'PNG export')
  } finally {
    if (button) {
      button.disabled = false
      button.textContent = previousLabel
    }
  }
}

const previewFeedbackStory = async (feedback, button) => {
  const previousLabel = button?.textContent
  if (button) {
    button.disabled = true
    button.textContent = 'Preparing...'
  }

  try {
    const canvas = createFeedbackStoryCanvas(feedback)
    const overlay = createNode('div', 'story-preview-modal')
    overlay.setAttribute('role', 'dialog')
    overlay.setAttribute('aria-modal', 'true')
    overlay.setAttribute('aria-label', 'Feedback story preview')

    const dialog = createNode('div', 'story-preview-dialog')
    const header = createNode('div', 'story-preview-dialog__header')
    const title = createNode('div')
    title.append(
      createNode('p', 'admin-eyebrow', 'Story Preview'),
      createNode('h3', '', getText(feedback.Book, 'Greyveil Feedback'))
    )

    const closeButton = createNode('button', 'admin-action', 'Close')
    closeButton.type = 'button'
    header.append(title, closeButton)

    const image = document.createElement('img')
    image.className = 'story-preview-image'
    image.alt = 'Instagram Story preview for reader feedback'
    image.src = canvas.toDataURL('image/png')

    const actions = createNode('div', 'story-preview-actions')
    const downloadButton = createNode('button', 'admin-action admin-action--primary', 'Download PNG')
    downloadButton.type = 'button'
    downloadButton.addEventListener('click', () => triggerStoryDownload(canvas, feedback))
    actions.append(downloadButton)

    const closePreview = () => {
      document.removeEventListener('keydown', handlePreviewKeydown)
      overlay.remove()
    }
    const handlePreviewKeydown = (event) => {
      if (event.key === 'Escape') closePreview()
    }

    closeButton.addEventListener('click', closePreview)
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) closePreview()
    })
    document.addEventListener('keydown', handlePreviewKeydown)

    dialog.append(header, image, actions)
    overlay.append(dialog)
    document.body.append(overlay)
    closeButton.focus({ preventScroll: true })
  } catch (error) {
    setTableError('feedback_story_export', error, 'PNG preview')
  } finally {
    if (button) {
      button.disabled = false
      button.textContent = previousLabel
    }
  }
}

const drawFeedbackStory = (context, feedback) => {
  const theme = storyThemeForFeedback(feedback)
  context.fillStyle = theme.paper
  context.fillRect(0, 0, 1080, 1920)

  const gradient = context.createLinearGradient(0, 0, 1080, 1920)
  gradient.addColorStop(0, theme.accentSoft)
  gradient.addColorStop(0.48, 'rgba(255, 255, 255, 0)')
  gradient.addColorStop(1, 'rgba(108, 154, 139, 0.16)')
  context.fillStyle = gradient
  context.fillRect(0, 0, 1080, 1920)
  drawStoryTexture(context, theme)

  roundedRect(context, 62, 62, 956, 1796, 44)
  context.strokeStyle = 'rgba(42, 52, 64, 0.13)'
  context.lineWidth = 3
  context.stroke()

  context.fillStyle = theme.ink
  context.font = '800 30px Inter, Arial, sans-serif'
  drawSpacedText(context, 'GREYVEIL EDITIONS', 94, 132, 4)

  context.font = '800 22px Inter, Arial, sans-serif'
  context.fillStyle = theme.accentDeep
  context.fillText('READER FEEDBACK', 96, 184)

  const contextText = [feedback.Series, feedback.Book].map((value) => getText(value, '')).filter(Boolean).join(' / ')
  context.font = '600 30px Inter, Arial, sans-serif'
  context.fillStyle = theme.muted
  drawWrappedText(context, wrapCanvasText(context, contextText || 'Greyveil Editions', 880, 2), 96, 238, 38)

  roundedRect(context, 84, 324, 912, 994, 56)
  context.fillStyle = theme.panel
  context.fill()
  context.strokeStyle = 'rgba(42, 52, 64, 0.11)'
  context.lineWidth = 3
  context.stroke()

  context.fillStyle = theme.accent
  context.font = '700 52px Inter, Arial, sans-serif'
  context.fillText(ratingStars(feedback.Rate), 136, 446)
  context.font = '800 24px Inter, Arial, sans-serif'
  context.fillStyle = theme.accentDeep
  context.fillText(`${formatRating(feedback.Rate)} / 5`, 140, 494)

  context.strokeStyle = 'rgba(42, 52, 64, 0.11)'
  context.lineWidth = 2
  context.beginPath()
  context.moveTo(136, 538)
  context.lineTo(944, 538)
  context.stroke()

  const review = getText(feedback['Reviews '], 'No review text provided.')
  const reviewLayout = fitStoryReview(context, review, 760, 575)
  context.fillStyle = 'rgba(140, 106, 74, 0.20)'
  context.font = '700 156px Cormorant Garamond, Georgia, serif'
  context.fillText('\u201C', 126, 654)
  context.fillStyle = theme.ink
  context.font = `600 ${reviewLayout.fontSize}px Cormorant Garamond, Georgia, serif`
  drawWrappedText(context, reviewLayout.lines, 158, 642, reviewLayout.lineHeight)

  const reviewerY = Math.min(1240, 672 + reviewLayout.lines.length * reviewLayout.lineHeight + 46)
  context.font = '800 34px Inter, Arial, sans-serif'
  context.fillStyle = theme.ink
  context.fillText(`- ${getText(feedback.Name, 'Anonymous')}`, 158, reviewerY)

  roundedRect(context, 84, 1398, 912, 304, 34)
  context.fillStyle = 'rgba(255, 255, 255, 0.42)'
  context.fill()
  context.strokeStyle = 'rgba(42, 52, 64, 0.09)'
  context.lineWidth = 2
  context.stroke()

  let metaY = drawStoryMeta(context, 'Book Title', feedback.Book, 132, 1480, 816, theme, 52)
  metaY = Math.min(metaY + 34, 1606)
  drawStoryMeta(context, 'Series', feedback.Series, 132, metaY, 816, theme, 40)

  context.font = '700 24px Inter, Arial, sans-serif'
  context.fillStyle = theme.muted
  context.fillText('Shared from Greyveil Editions reader feedback.', 96, 1780)
  context.font = '800 30px Inter, Arial, sans-serif'
  context.fillStyle = theme.ink
  drawSpacedText(context, 'GREYVEIL EDITIONS', 96, 1830, 3)
}

const updateFeedbackStatus = async (feedback, nextStatusOrControl, control = null) => {
  const nextStatus = typeof nextStatusOrControl === 'string' ? nextStatusOrControl : nextStatusOrControl?.value
  const previousStatus = feedbackStatusValue(feedback)

  if (!feedback.id) {
    if (nextStatusOrControl?.value) nextStatusOrControl.value = previousStatus
    return
  }

  if (!STATUS_OPTIONS.includes(nextStatus) || nextStatus === previousStatus) return

  const activeControl = control || nextStatusOrControl
  const previousLabel = activeControl?.textContent
  if (activeControl) {
    activeControl.disabled = true
    if (activeControl.textContent) activeControl.textContent = 'Saving...'
  }

  feedback.status = nextStatus
  renderDashboard()
  renderFeedback()
  refreshFeedbackDrawer()

  const { error } = await supabase
    .from('feedbacks')
    .update({ status: nextStatus })
    .eq('id', feedback.id)

  if (error) {
    feedback.status = previousStatus
    setTableError('feedbacks', error, 'status update')
    renderDashboard()
    renderFeedback()
    refreshFeedbackDrawer()
    if (activeControl) {
      activeControl.disabled = false
      if (previousLabel) activeControl.textContent = previousLabel
    }
    return
  }

  clearTableError('feedbacks')
  renderDashboard()
  renderFeedback()
  refreshFeedbackDrawer()
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
