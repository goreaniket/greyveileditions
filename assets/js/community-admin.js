import { supabase } from './supabase-client.js'

const state = document.querySelector('#community-admin-state')
const app = document.querySelector('#community-admin-app')
const list = document.querySelector('#community-admin-list')
const count = document.querySelector('#community-admin-count')
const refresh = document.querySelector('#community-admin-refresh')

const categories = {
  belonging: 'Connection, friendship or community',
  wellbeing: 'Wellbeing resources or a support referral',
  growth: 'Learning, skills or mentorship',
  practical_help: 'Help finding a practical solution',
  volunteer: 'Volunteer or contribute',
  partnership: 'Partnership or collaboration',
}
const statuses = ['received','reviewing','referred','resolved','closed']
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[char]))

const load = async () => {
  list.textContent = 'Loading requests…'
  const { data: requests, error } = await supabase
    .from('community_requests')
    .select('id,member_id,request_type,summary,status,created_at')
    .order('created_at', { ascending: false })
    .limit(100)

  if (error) {
    console.error('Greyveil Connect admin load failed:', error)
    list.textContent = 'Requests could not be loaded. Check database permissions and try again.'
    count.textContent = 'Unable to load requests'
    return
  }

  const memberIds = [...new Set((requests || []).map((item) => item.member_id))]
  let profiles = []
  if (memberIds.length) {
    const profileResult = await supabase.from('profiles').select('id,display_name').in('id', memberIds)
    if (profileResult.error) console.error('Greyveil member names could not be loaded:', profileResult.error)
    profiles = profileResult.data || []
  }
  const names = new Map(profiles.map((profile) => [profile.id, profile.display_name || 'Greyveil member']))

  count.textContent = `${requests.length} request${requests.length === 1 ? '' : 's'}`
  if (!requests.length) {
    list.textContent = 'No community requests have been submitted yet.'
    return
  }

  list.innerHTML = requests.map((item) => {
    const date = new Date(item.created_at).toLocaleString()
    const options = statuses.map((status) => `<option value="${status}" ${item.status === status ? 'selected' : ''}>${status[0].toUpperCase() + status.slice(1)}</option>`).join('')
    return `<article class="community-request" data-request-card="${escapeHtml(item.id)}">
      <div class="community-request-head">
        <div><h2>${escapeHtml(categories[item.request_type] || item.request_type)}</h2>
          <div class="community-request-meta">${escapeHtml(names.get(item.member_id) || 'Member')} · ${escapeHtml(date)} · ${escapeHtml(item.member_id)}</div>
        </div>
        <span class="community-request-status">${escapeHtml(item.status)}</span>
      </div>
      <p class="community-request-summary">${escapeHtml(item.summary)}</p>
      <div class="community-request-controls">
        <label for="status-${escapeHtml(item.id)}">Update status</label>
        <select id="status-${escapeHtml(item.id)}" data-status-select>${options}</select>
        <button type="button" class="admin-action admin-action--primary" data-save-status>Save status</button>
      </div>
      <p class="community-request-message" role="status" aria-live="polite"></p>
    </article>`
  }).join('')
}

const boot = async () => {
  const { data: { user }, error: authError } = await supabase.auth.getUser()
  if (authError || !user) {
    state.textContent = 'Administrator sign-in required.'
    const link = document.createElement('a')
    link.href = '/auth/login/'
    link.textContent = 'Sign in'
    state.append(' ', link)
    return
  }

  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single()

  if (profileError || !['admin','super_admin'].includes(profile?.role)) {
    state.textContent = 'Access denied. This page is restricted to Greyveil administrators.'
    return
  }

  state.textContent = `Signed in as ${user.email || 'Greyveil administrator'}.`
  app.hidden = false
  await load()
}

refresh.addEventListener('click', load)

list.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-save-status]')
  if (!button) return
  const card = button.closest('[data-request-card]')
  const select = card.querySelector('[data-status-select]')
  const message = card.querySelector('.community-request-message')
  const status = select.value
  if (!statuses.includes(status)) return

  button.disabled = true
  message.textContent = 'Saving…'
  const { error } = await supabase.from('community_requests')
    .update({ status, updated_at: new Date().toISOString() })
    .eq('id', card.dataset.requestCard)
  button.disabled = false

  if (error) {
    console.error('Greyveil request status update failed:', error)
    message.textContent = 'Status could not be updated. Check permissions and try again.'
    return
  }
  message.textContent = 'Status updated.'
  card.querySelector('.community-request-status').textContent = status
})

boot()
