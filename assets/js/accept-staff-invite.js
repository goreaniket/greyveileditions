import { supabase } from './supabase-client.js'

const form = document.querySelector('[data-invite-password-form]')
const status = document.querySelector('[data-invite-status]')
let invitationVerified = false

const showFailure = (message) => {
  status.textContent = message
  form.hidden = true
}

const verifyInvitation = async () => {
  const url = new URL(window.location.href)
  const type = url.searchParams.get('type')
  const tokenHash = url.searchParams.get('token_hash')
  const code = url.searchParams.get('code')

  if (url.searchParams.has('error') || (type && type !== 'invite')) {
    showFailure('This staff invitation is invalid or has expired. Ask the Greyveil Owner to send a new one.')
    return
  }
  if (type === 'invite' && tokenHash) {
    const { error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type: 'invite' })
    if (error) throw error
  } else if (type === 'invite' && code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code)
    if (error) throw error
  }

  const { data, error } = await supabase.auth.getSession()
  if (error) throw error
  if (!type || type !== 'invite' || !data.session?.user) {
    showFailure('Open the secure invitation link from your email to continue.')
    return
  }

  invitationVerified = true
  window.history.replaceState({}, document.title, window.location.pathname)
  form.hidden = false
  status.textContent = `Invitation verified for ${data.session.user.email || 'your Greyveil account'}. Create a password to continue.`
}

form.addEventListener('submit', async (event) => {
  event.preventDefault()
  if (!invitationVerified) return
  const password = form.elements.password.value
  if (password !== form.elements.confirm_password.value) {
    status.textContent = 'The passwords do not match.'
    return
  }
  const button = form.querySelector('button[type="submit"]')
  button.disabled = true
  try {
    const { error } = await supabase.auth.updateUser({ password })
    if (error) throw error
    status.textContent = 'Password created. Opening your secure Greyveil command centre…'
    window.location.replace('/admin/command-center/')
  } catch (error) {
    console.error('Greyveil staff invitation acceptance failed.', error)
    status.textContent = error.message || 'The password could not be saved. Try again or request a new invitation.'
    button.disabled = false
  }
})

verifyInvitation().catch((error) => {
  console.error('Greyveil staff invitation could not be verified.', error)
  showFailure(error.message || 'This staff invitation is invalid or has expired.')
})
