import { supabase } from './supabase-client.js'
import { getCurrentUser, signOut } from './auth.js'

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

  if (book?.is_active === false) {
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

const fetchBooks = async () => {
  const { data, error, count } = await supabase
    .from('books')
    .select('id, title, series, book_number, slug, is_public, is_active', { count: 'exact' })
    .order('series', { ascending: true })
    .order('book_number', { ascending: true })

  if (error) {
    state.books = []
    state.counts.books = null
    setTableError('books', error)
    return
  }

  state.books = data || []
  state.counts.books = count ?? state.books.length
  clearTableError('books')
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

  renderAccessUserOptions()
  renderAccessBookOptions()
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
      tableCell(boolLabel(book.is_public)),
      tableCell(boolLabel(book.is_active)),
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
  const publicButton = createNode('button', 'admin-inline-action', book.is_public ? 'Public Visibility: Off' : 'Public Visibility: On')
  const activeButton = createNode('button', 'admin-inline-action', book.is_active ? 'Global Active: Off' : 'Global Active: On')

  publicButton.type = 'button'
  activeButton.type = 'button'
  publicButton.addEventListener('click', () => updateBookFlag(book, 'is_public', !book.is_public, publicButton))
  activeButton.addEventListener('click', () => updateBookFlag(book, 'is_active', !book.is_active, activeButton))

  actions.append(publicButton, activeButton)
  cell.append(actions)
  return cell
}

const updateBookFlag = async (book, field, nextValue, button) => {
  if (!ADMIN_ROLES.has(state.profile?.role)) return
  if (!book?.id) return

  const label = getText(book.title, 'this book')
  const messages = {
    is_public: nextValue
      ? `Turn Public Visibility ON for "${label}"? This is a global catalogue setting.`
      : `Turn Public Visibility OFF for "${label}"? This is a global catalogue setting.`,
    is_active: nextValue
      ? `Turn Global Active ON for "${label}"?`
      : `Turn Global Active OFF for "${label}"? This disables the book for everyone, including users with access.`,
  }

  if (!window.confirm(messages[field])) return

  const previousLabel = button?.textContent
  if (button) {
    button.disabled = true
    button.textContent = 'Saving...'
  }

  const { data, error } = await supabase
    .from('books')
    .update({ [field]: nextValue })
    .eq('id', book.id)
    .select('id, title, series, book_number, slug, is_public, is_active')
    .maybeSingle()

  if (error) {
    if (button) {
      button.disabled = false
      button.textContent = previousLabel
    }
    setTableError('books', error, 'UPDATE')
    return
  }

  Object.assign(book, data || { [field]: nextValue })
  clearTableError('books')
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
