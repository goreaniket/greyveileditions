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

export async function redirectByRole(user = null) {
  const role = await getUserRole(user)
  window.location.assign(isAdminRole(role) ? ADMIN_PATH : ACCOUNT_PATH)
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

  const user = await getCurrentUser()
  if (!user) {
    window.location.replace(LOGIN_PATH)
    return
  }

  const profile = await getCurrentProfile(user)
  const role = profile?.role || 'customer'

  if (nameNode) nameNode.textContent = displayNameFor(user, profile)
  if (emailNode) emailNode.textContent = user.email || ''

  if (roleRow && roleNode && isAdminRole(role)) {
    roleNode.textContent = formatRole(role)
    roleRow.hidden = false
  }

  showAuthView(view)

  logoutButton?.addEventListener('click', async () => {
    setBusy(logoutButton, true, 'Signing out...')
    setStatus(status, 'Signing out...', 'info')

    try {
      await signOut()
      window.location.assign(LOGIN_PATH)
    } catch (error) {
      setBusy(logoutButton, false)
      setStatus(status, friendlyAuthMessage(error, 'We could not sign you out. Please try again.'), 'error')
    }
  })
}

const page = document.body.dataset.authPage

if (page === 'signup') initSignupPage()
if (page === 'login') initLoginPage()
if (page === 'account') initAccountPage()
