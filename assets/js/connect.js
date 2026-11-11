import { supabase } from './supabase-client.js'

const form = document.querySelector('#connect-form')
const authState = document.querySelector('#auth-state')
const signInPrompt = document.querySelector('#sign-in-prompt')
const statusNode = document.querySelector('#form-status')
const submitButton = document.querySelector('#connect-submit')
const historySection = document.querySelector('#request-history')
const requestList = document.querySelector('#request-list')
const refreshButton = document.querySelector('#refresh-requests')

const labels = {
  belonging: 'Connection, friendship or community',
  wellbeing: 'Wellbeing resources or a support referral',
  growth: 'Learning, skills or mentorship',
  practical_help: 'Help finding a practical solution',
  volunteer: 'I want to volunteer or contribute',
  partnership: 'Partnership or collaboration',
}
const statuses = {
  received: 'Received',
  reviewing: 'Reviewing',
  referred: 'Referred',
  resolved: 'Resolved',
  closed: 'Closed',
}
let currentUser = null

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[char]))

const showStatus = (message, error = false) => {
  statusNode.textContent = message
  statusNode.dataset.error = error ? 'true' : 'false'
}

const loadRequests = async () => {
  if (!currentUser) return
  requestList.textContent = 'Loading your requests…'
  const { data, error } = await supabase
    .from('community_requests')
    .select('id,request_type,summary,status,created_at')
    .eq('member_id', currentUser.id)
    .order('created_at', { ascending: false })
    .limit(30)

  if (error) {
    requestList.textContent = 'Your requests could not be loaded. Please try again.'
    console.error('Greyveil Connect request history failed:', error)
    return
  }

  if (!data?.length) {
    requestList.textContent = 'You have not sent a request yet.'
    return
  }

  requestList.innerHTML = data.map((item) => {
    const date = new Date(item.created_at).toLocaleDateString()
    const canDelete = item.status === 'received'
    return `<article class="request-card">
      <div><h3>${escapeHtml(labels[item.request_type] || 'Greyveil request')}</h3>
      <p>${escapeHtml(item.summary)}</p>
      <div class="request-meta">${escapeHtml(date)} · Request ${escapeHtml(item.id.slice(0, 8))}</div>
      ${canDelete ? `<button type="button" data-delete-request="${escapeHtml(item.id)}">Delete this request</button>` : ''}
      </div><span class="request-status">${escapeHtml(statuses[item.status] || item.status)}</span>
    </article>`
  }).join('')
}

const boot = async () => {
  const { data: { user }, error } = await supabase.auth.getUser()
  if (error) {
    authState.textContent = 'We could not verify your session. Refresh the page or sign in again.'
    return
  }
  currentUser = user
  if (!user) {
    authState.hidden = true
    signInPrompt.hidden = false
    return
  }
  authState.textContent = `Signed in as ${user.email || 'your Greyveil account'}.`
  form.hidden = false
  historySection.hidden = false
  await loadRequests()
}

form.addEventListener('submit', async (event) => {
  event.preventDefault()
  if (!currentUser) return
  const requestType = document.querySelector('#request-type').value
  const summary = document.querySelector('#request-summary').value.trim()
  const consent = document.querySelector('#request-consent').checked
  if (!labels[requestType] || summary.length < 10 || summary.length > 1200 || !consent) {
    showStatus('Choose a request type, add a short note and confirm consent.', true)
    return
  }

  submitButton.disabled = true
  submitButton.textContent = 'Sending…'
  showStatus('')
  const { error } = await supabase.from('community_requests').insert({
    member_id: currentUser.id,
    request_type: requestType,
    summary,
    status: 'received',
    consent_to_review: true,
  })

  submitButton.disabled = false
  submitButton.textContent = 'Send request'
  if (error) {
    console.error('Greyveil Connect request submission failed:', error)
    showStatus('Your request was not sent. Please try again. If the issue continues, contact Greyveil directly.', true)
    return
  }

  form.reset()
  showStatus('Your request has been received. Greyveil will review it manually; this is not an immediate-response service.')
  await loadRequests()
})

refreshButton?.addEventListener('click', loadRequests)

requestList.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-delete-request]')
  if (!button || !currentUser) return
  if (!window.confirm('Delete this unreviewed request? This cannot be undone.')) return
  button.disabled = true
  const { error } = await supabase.from('community_requests').delete()
    .eq('id', button.dataset.deleteRequest)
    .eq('member_id', currentUser.id)
    .eq('status', 'received')
  if (error) {
    console.error('Greyveil Connect request deletion failed:', error)
    button.disabled = false
    return
  }
  await loadRequests()
})

boot()
