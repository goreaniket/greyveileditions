import { supabase } from './supabase-client.js'

const ADMIN_ROLES = new Set(['admin', 'super_admin'])
const LOGIN_PATH = '/auth/login/'
const ACCOUNT_PATH = '/account/'
const ADMIN_PATH = '/admin/'

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

const friendlyAuthMessage = (error, fallback) => {
  const message = error?.message?.toLowerCase() || ''

  if (message.includes('invalid login credentials')) {
    return 'The email or password is not correct.'
  }

  if (message.includes('email not confirmed')) {
    return 'Please confirm your email before signing in.'
  }

  if (message.includes('already registered') || message.includes('already exists')) {
    return 'An account already exists for this email. Try signing in instead.'
  }

  if (message.includes('password')) {
    return 'Please use a stronger password and try again.'
  }

  if (message.includes('network') || message.includes('fetch')) {
    return 'We could not reach the account service. Please try again.'
  }

  return fallback
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

const clearNode = (node) => {
  if (!node) return
  while (node.firstChild) node.firstChild.remove()
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

const libraryCard = (item, role) => {
  const { book, collection, volume, series } = item
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

  const readLink = document.createElement('a')
  readLink.className = 'button primary'
  readLink.href = bookReaderPath(book, series)
  readLink.textContent = 'Read Book'

  body.append(title, meta, accessNode, readLink)
  card.append(cover, body)
  return card
}

const buildCustomerLibraryItems = (hierarchy, grants, access) => {
  const grantsByBook = currentGrantMap(grants, access)

  return hierarchy.books
    .map((book) => {
      const itemHierarchy = access.hierarchyForBook(book, hierarchy.seriesItems, hierarchy.collections, hierarchy.volumes)
      const grant = grantsByBook.get(book.id)
      return { ...itemHierarchy, grant }
    })
    .filter((item) => {
      if (!item.grant) return false
      if (!libraryHierarchyReady(item, access)) return false
      if (access.effectiveVisibilityForBookHierarchy(item) === 'private') return false
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

const renderAccountLibrary = async (user, profile, role) => {
  const nodes = libraryNodes()
  if (!nodes.section || !nodes.grid) return

  const runId = ++accountLibraryRun
  nodes.section.hidden = false
  clearNode(nodes.grid)
  if (nodes.empty) nodes.empty.hidden = true
  configureLibraryCopy(nodes, role)
  setBusy(nodes.refresh, true, 'Refreshing...')
  setStatus(nodes.status, 'Checking your library...', 'info')

  try {
    const access = await import('./content-access.js')
    let hierarchy = null
    let grants = []

    if (isAdminRole(role)) {
      hierarchy = await access.fetchContentHierarchy()
    } else {
      const grantsResult = await access.fetchViewerBookGrants(user.id)
      if (grantsResult.error) {
        const libraryError = new Error(grantsResult.error.message || 'Book access could not be read.')
        libraryError.table = 'book_access'
        libraryError.code = grantsResult.error.code
        throw libraryError
      }

      grants = (grantsResult.data || []).filter((grant) => access.isGrantCurrent(grant))
      hierarchy = await access.fetchHierarchyForBooks(grants.map((grant) => grant.book_id))
    }

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
      : buildCustomerLibraryItems(hierarchy, grants, access)

    if (!isAdminRole(role)) logCustomerLibraryDiagnostics(hierarchy, grants, items, access)

    if (runId !== accountLibraryRun) return

    const sortedItems = sortLibraryItems(items)
    sortedItems.forEach((item) => nodes.grid.append(libraryCard(item, role)))

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

export async function redirectByRole() {
  window.location.assign(ACCOUNT_PATH)
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

    setBusy(submitButton, true, 'Creating account...')
    setStatus(status, 'Creating your account...', 'info')

    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: {
          display_name: displayName,
        },
      },
    })

    form.elements.password.value = ''
    form.elements.confirm_password.value = ''
    setBusy(submitButton, false)

    if (error) {
      setStatus(status, friendlyAuthMessage(error, 'We could not create the account. Please try again.'), 'error')
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

    const { error } = await supabase.auth.signInWithPassword({
      email,
      password,
    })

    form.elements.password.value = ''

    if (error) {
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
  let activeUser = null
  let activeProfile = null
  let activeRole = 'customer'

  const refreshCurrentLibrary = () => {
    if (!activeUser) return

    window.clearTimeout(accountLibraryRefreshTimer)
    accountLibraryRefreshTimer = window.setTimeout(() => {
      renderAccountLibrary(activeUser, activeProfile, activeRole)
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

    if (roleRow && roleNode) {
      roleNode.textContent = formatRole(role)
      roleRow.hidden = !isAdminRole(role)
    }

    renderAccountAdminAction(accountActions, logoutButton, role)

    showAuthView(view)
    await renderAccountLibrary(currentUser, profile, role)
  }

  await renderCurrentAccount(user)

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

  libraryRefreshButton?.addEventListener('click', refreshCurrentLibrary)
  window.addEventListener('focus', refreshCurrentLibrary)
  window.addEventListener('pageshow', refreshCurrentLibrary)
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

if (page === 'signup') initSignupPage()
if (page === 'login') initLoginPage()
if (page === 'account') initAccountPage()
