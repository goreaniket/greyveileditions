import { supabase } from './supabase-client.js'

if (!document.querySelector('script[data-greyveil-sanctuary]')) {
  const sanctuaryScript = document.createElement('script')
  sanctuaryScript.src = '/assets/js/theme-sanctuary.js?v=20261121.2'
  sanctuaryScript.dataset.greyveilSanctuary = 'true'
  sanctuaryScript.defer = true
  document.head.append(sanctuaryScript)
}

const $ = (selector, root = document) => root.querySelector(selector)
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector))
const state = {
  userId: '',
  role: '',
  permissions: new Set(),
  factors: [],
  selectedStory: null,
  stories: [],
  readers: [],
  staff: [],
}

const roleLabels = {
  owner: 'Owner',
  super_admin: 'Super Admin',
  human_support: 'Human Support',
  content_editor: 'Content Editor',
  finance_admin: 'Finance Admin',
  moderator: 'Moderator',
}
const categories = {
  listening: 'Listening',
  understanding: 'Understanding',
  perspective: 'Perspective',
  reflection: 'Reflection',
  reading_guidance: 'Reading Guidance',
  support_resources: 'Support Resources',
}

const announce = (message) => { $('[data-notice]').textContent = message }
const gateMessage = (message) => { $('[data-gate-message]').textContent = message }
const escapeText = (value) => String(value ?? '')
const formatDate = (value) => {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '—' : new Intl.DateTimeFormat('en-IN', {
    dateStyle: 'medium', timeStyle: 'short',
  }).format(date)
}
const can = (permission) => state.permissions.has('*') || state.permissions.has(permission)
const rpc = async (name, args = {}) => {
  const { data, error } = await supabase.rpc(name, args)
  if (error) {
    console.error(`Greyveil command-centre operation ${name} failed.`, error)
    throw new Error(error.message || 'The requested operation was not completed.')
  }
  return data
}
const clear = (node) => node?.replaceChildren()
const cell = (row, value) => {
  const item = document.createElement('td')
  item.textContent = escapeText(value)
  row.append(item)
  return item
}
const make = (tag, className = '', value = '') => {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (value) node.textContent = value
  return node
}
const setButtonBusy = (button, busy) => { if (button) button.disabled = busy }

const showApplication = (session) => {
  state.userId = session.user_id
  state.role = session.role
  state.permissions = new Set(Array.isArray(session.permissions) ? session.permissions : [])
  $('[data-user-name]').textContent = session.display_name || 'Greyveil staff'
  $('[data-user-role]').textContent = roleLabels[session.role] || session.role
  $('[data-gate]').hidden = true
  $('[data-app]').hidden = false
  $$('[data-view]').forEach((button) => {
    const required = button.dataset.permission
    button.hidden = Boolean(required && !can(required))
  })
}

const ensureMfa = async () => {
  const { data: assurance, error: assuranceError } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel()
  if (assuranceError) throw assuranceError
  if (assurance?.currentLevel === 'aal2') return true

  const { data, error } = await supabase.auth.mfa.listFactors()
  if (error) throw error
  state.factors = (data?.totp || []).filter((factor) => factor.status === 'verified')
  if (!state.factors.length) {
    $('[data-mfa-enroll]').hidden = false
    gateMessage('Set up an authenticator before accessing private platform data or staff controls.')
    return false
  }
  $('[data-mfa-form]').hidden = false
  gateMessage('Enter the current code from your verified authenticator to continue.')
  return false
}

const openView = async (name) => {
  $$('[data-panel]').forEach((panel) => {
    const active = panel.dataset.panel === name
    panel.hidden = !active
    panel.classList.toggle('is-active', active)
  })
  $$('[data-view]').forEach((button) => {
    if (button.hidden) return
    if (button.dataset.view === name) button.setAttribute('aria-current', 'page')
    else button.removeAttribute('aria-current')
  })
  const actions = {
    overview: loadOverview,
    inbox: loadInbox,
    readers: loadReaders,
    team: loadTeam,
    moderation: loadReports,
    security: loadAudit,
  }
  try { await actions[name]?.() } catch (error) { announce(error.message) }
}

const loadOverview = async () => {
  if (!can('analytics.read')) return
  announce('Loading current platform counts…')
  const data = await rpc('greyveil_command_center_overview')
  const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 })
  for (const [key, value] of Object.entries(data || {})) {
    const node = $(`[data-metric="${key}"]`)
    if (node) node.textContent = key === 'captured_revenue_paise' ? inr.format(Number(value) / 100) : Number(value).toLocaleString('en-IN')
  }
  const inboxCount = $('[data-inbox-count]')
  if (inboxCount) inboxCount.textContent = String(data?.pending_stories ?? 0)
  $('[data-last-updated]').textContent = `UPDATED ${formatDate(new Date().toISOString())}`
  announce('Overview reflects current database records.')
}

const inboxArgs = () => ({
  p_search: $('[data-inbox-search]').value.trim() || null,
  p_status: $('[data-inbox-status]').value || null,
  p_category: $('[data-inbox-category]').value || null,
  p_assigned_to: null,
  p_limit: 200,
})

const renderInbox = () => {
  const list = $('[data-inbox-list]')
  clear(list)
  if (!state.stories.length) {
    list.append(make('p', 'empty', 'No submissions match these filters.'))
    return
  }
  state.stories.forEach((story) => {
    const item = make('div', 'inbox-entry')
    const button = make('button', 'inbox-item')
    button.type = 'button'
    button.setAttribute('aria-pressed', String(state.selectedStory === story.story_id))
    button.append(
      make('strong', '', story.reader_name),
      make('span', '', `${categories[story.category] || story.category} · ${story.status} · ${formatDate(story.created_at)}`),
      make('small', '', `${story.title} · ${story.assigned_name || 'Unassigned'}${Number(story.unread_responses) ? ` · ${story.unread_responses} unread` : ''}`),
    )
    button.addEventListener('click', () => openStory(story.story_id).catch((error) => announce(error.message)))
    item.append(button)
    if (can('human.assign') && !story.assigned_to) {
      const assign = make('button', 'inbox-assign', 'Assign to me')
      assign.type = 'button'
      assign.addEventListener('click', (event) => {
        event.stopPropagation()
        mutate('greyveil_command_center_assign_story', {
          p_story_id: story.story_id, p_assigned_to: state.userId,
        }, 'Conversation assigned to you.', async () => {
          await loadInbox()
          await openStory(story.story_id)
        })
      })
      item.append(assign)
    }
    list.append(item)
  })
}

const loadInbox = async () => {
  if (!can('human.inbox.read')) return
  const { data, error } = await supabase.rpc('greyveil_command_center_inbox', inboxArgs())
  if (error) {
    console.error('Private Greyveil inbox could not be loaded.', error)
    throw new Error(error.message || 'The private inbox could not be loaded.')
  }
  state.stories = data || []
  renderInbox()
}

const renderConversation = (payload) => {
  const host = $('[data-conversation]')
  clear(host)
  const story = payload.story
  const heading = make('h3', '', story.title)
  host.append(heading)
  host.append(make('p', 'conversation-meta',
    `${story.is_anonymous ? 'Anonymous submission' : `${story.reader_name} · ${story.reader_email}`} · ${categories[story.category] || story.category} · ${story.status} · ${formatDate(story.created_at)}`))
  host.append(make('p', 'private-story', story.story))

  const actions = make('div', 'conversation-actions')
  if (can('human.assign')) {
    const assign = make('button', '', 'Assign to me')
    assign.type = 'button'
    assign.addEventListener('click', () => mutate('greyveil_command_center_assign_story', {
      p_story_id: story.id, p_assigned_to: state.userId,
    }, 'Conversation assigned to you.', loadInbox))
    actions.append(assign)
  }
  if (can('human.moderate')) {
    for (const [status, label] of [['in_review', 'Mark in review'], ['declined', 'Decline'], ...(story.public_consent ? [['published', 'Approve publication']] : [])]) {
      const button = make('button', '', label)
      button.type = 'button'
      button.addEventListener('click', () => mutate('greyveil_command_center_update_story', {
        p_story_id: story.id, p_status: status,
      }, `Story status updated: ${status}.`, loadInbox))
      actions.append(button)
    }
  }
  if (can('human.moderate') && story.public_consent) host.append(make('p', 'conversation-meta', 'Separate public-sharing consent recorded. Publication still requires your approval.'))
  host.append(actions)

  const thread = make('div', 'thread')
  ;(payload.responses || []).forEach((response) => {
    const entry = make('article', 'thread-entry')
    entry.append(make('small', '', `${categories[response.category] || response.category} · ${formatDate(response.created_at)}`))
    entry.append(make('p', '', response.text))
    thread.append(entry)
  })
  ;(payload.notes || []).forEach((note) => {
    const entry = make('article', 'thread-entry')
    entry.append(make('small', '', `PRIVATE EDITOR NOTE · ${formatDate(note.created_at)}`))
    entry.append(make('p', '', note.note))
    thread.append(entry)
  })
  host.append(thread)

  if (can('human.respond')) {
    const form = make('form')
    const categoryLabel = make('label', '', 'Response category')
    const category = document.createElement('select')
    category.required = true
    Object.entries(categories).forEach(([value, label]) => category.add(new Option(label, value, false, value === story.category)))
    categoryLabel.append(category)
    const responseLabel = make('label', '', 'Personal response · delivered privately to the reader')
    const response = document.createElement('textarea')
    response.maxLength = 6000
    response.required = true
    responseLabel.append(response)
    const submit = make('button', 'response-submit', 'Send private response')
    submit.type = 'submit'
    form.append(categoryLabel, responseLabel, submit)
    form.addEventListener('submit', async (event) => {
      event.preventDefault()
      submit.disabled = true
      try {
        await rpc('greyveil_command_center_respond', {
          p_story_id: story.id, p_category: category.value, p_response: response.value,
        })
        announce('Personal response delivered to the reader’s private account.')
        try { await openStory(story.id) } catch (error) {
          announce(`Response delivered, but the conversation could not refresh: ${error.message}`)
        }
      } catch (error) {
        announce(error.message)
      } finally { submit.disabled = false }
    })
    host.append(form)
  }
}

const openStory = async (storyId) => {
  if (!can('human.inbox.read')) return
  state.selectedStory = storyId
  renderInbox()
  $('[data-conversation]').replaceChildren(make('p', 'empty', 'Opening private conversation…'))
  const payload = await rpc('greyveil_command_center_story', { p_story_id: storyId })
  renderConversation(payload)
}

const mutate = async (name, args, success, refresh) => {
  announce('Saving through the protected Greyveil service…')
  try {
    await rpc(name, args)
    announce(success)
  } catch (error) {
    announce(error.message)
    return
  }
  try { await refresh() } catch (error) {
    announce(`${success} Refresh failed: ${error.message}`)
  }
}

const loadReaders = async () => {
  if (!can('users.read')) return
  const rows = await rpc('greyveil_command_center_readers', {
    p_search: $('[data-reader-search]').value.trim() || null, p_limit: 200,
  })
  state.readers = rows || []
  const table = $('[data-readers-table]')
  clear(table)
  state.readers.forEach((reader) => {
    const row = document.createElement('tr')
    cell(row, reader.display_name)
    cell(row, reader.email)
    cell(row, reader.account_role)
    cell(row, formatDate(reader.joined_at))
    const control = cell(row, '')
    if (can('staff.manage') && reader.account_role !== 'owner') {
      const button = make('button', 'text-action', 'Select for staff')
      button.type = 'button'
      button.addEventListener('click', () => {
        $('[data-staff-user-id]').value = reader.user_id
        announce(`${reader.display_name} selected. Assigning a staff role does not change the reader’s account role.`)
      })
      control.append(button)
    }
    table.append(row)
  })
  if (!state.readers.length) table.append(make('tr', '', 'No matching readers.'))
}

const loadTeam = async () => {
  if (!can('staff.read')) return
  const rows = await rpc('greyveil_command_center_staff')
  state.staff = rows || []
  const table = $('[data-team-table]')
  clear(table)
  state.staff.forEach((staff) => {
    const row = document.createElement('tr')
    cell(row, `${staff.display_name || 'Greyveil staff'} · ${staff.email || ''}`)
    cell(row, roleLabels[staff.staff_role] || staff.staff_role)
    cell(row, !staff.active ? 'Revoked' : staff.invitation_pending ? 'Invitation pending' : 'Active')
    cell(row, formatDate(staff.created_at))
    const control = cell(row, '')
    if (can('staff.manage') && staff.active) {
      const button = make('button', 'text-action', 'Revoke access')
      button.type = 'button'
      button.addEventListener('click', () => mutate('greyveil_command_center_revoke_staff', {
        p_user_id: staff.user_id,
      }, 'Staff access revoked.', loadTeam))
      control.append(button)
    }
    table.append(row)
  })
}

const loadReports = async () => {
  if (!can('moderation.read')) return
  const reports = await rpc('greyveil_command_center_reports', {
    p_status: $('[data-report-status]').value || null,
  })
  const host = $('[data-report-list]')
  clear(host)
  if (!reports?.length) {
    host.append(make('p', 'empty', 'No reports match this filter.'))
    return
  }
  reports.forEach((report) => {
    const item = make('article', 'report-item')
    const detail = make('div')
    detail.append(make('strong', '', `${report.reason} · ${report.status} · ${formatDate(report.created_at)}`))
    detail.append(make('p', '', `Reported by ${report.reporter_name} · Story ${report.story_id}`))
    if (report.details) detail.append(make('p', '', report.details))
    item.append(detail)
    if (can('moderation.manage') && report.status === 'open') {
      for (const status of ['resolved', 'dismissed']) {
        const button = make('button', '', status === 'resolved' ? 'Resolve' : 'Dismiss')
        button.type = 'button'
        button.addEventListener('click', () => mutate('greyveil_command_center_update_report', {
          p_report_id: report.report_id, p_status: status,
        }, `Report ${status}.`, loadReports))
        item.append(button)
      }
    }
    host.append(item)
  })
}

const loadAudit = async () => {
  if (!can('audit.read')) return
  const records = await rpc('greyveil_command_center_audit', { p_limit: 200 })
  const table = $('[data-audit-table]')
  clear(table)
  ;(records || []).forEach((record) => {
    const row = document.createElement('tr')
    cell(row, formatDate(record.created_at))
    cell(row, record.actor_name)
    cell(row, record.action)
    cell(row, `${record.target_type} · ${record.target_id || '—'}`)
    cell(row, JSON.stringify(record.details))
    table.append(row)
  })
  if (!records?.length) table.append(make('tr', '', 'No audited actions have been recorded.'))
}

const start = async () => {
  const { data, error } = await supabase.auth.getSession()
  if (error || !data?.session) {
    window.location.replace('/auth/login/?returnTo=%2Fadmin%2Fcommand-center%2F')
    return
  }
  const session = await rpc('greyveil_command_center_session')
  const aal2 = await ensureMfa()
  if (!aal2) {
    return
  }
  showApplication(session)
  try { await loadOverview() } catch (error) { announce(error.message) }
}

$$('[data-view]').forEach((button) => button.addEventListener('click', () => openView(button.dataset.view)))
$$('[data-open-view]').forEach((button) => button.addEventListener('click', () => openView(button.dataset.openView)))
$('[data-refresh]').addEventListener('click', () => openView('overview'))
$('[data-sign-out]').addEventListener('click', async () => {
  try {
    const { error } = await supabase.auth.signOut()
    if (error) throw error
    window.location.replace('/auth/login/')
  } catch (error) {
    console.error('Greyveil command-centre sign out failed.', error)
    announce(error.message || 'Sign out could not be completed.')
  }
})
$('[data-load-inbox]').addEventListener('click', () => loadInbox().catch((error) => announce(error.message)))
for (const selector of ['[data-inbox-status]', '[data-inbox-category]']) {
  $(selector).addEventListener('change', () => loadInbox().catch((error) => announce(error.message)))
}
let inboxSearchTimer
$('[data-inbox-search]').addEventListener('input', () => {
  clearTimeout(inboxSearchTimer)
  inboxSearchTimer = setTimeout(() => loadInbox().catch((error) => announce(error.message)), 250)
})
$('[data-load-readers]').addEventListener('click', () => loadReaders().catch((error) => announce(error.message)))
$('[data-load-team]').addEventListener('click', () => loadTeam().catch((error) => announce(error.message)))
$('[data-load-reports]').addEventListener('click', () => loadReports().catch((error) => announce(error.message)))
$('[data-report-status]').addEventListener('change', () => loadReports().catch((error) => announce(error.message)))
$('[data-load-audit]').addEventListener('click', () => loadAudit().catch((error) => announce(error.message)))
$('[data-reader-search]').addEventListener('search', () => loadReaders().catch((error) => announce(error.message)))

$('[data-assign-form]').addEventListener('submit', async (event) => {
  event.preventDefault()
  const submit = event.currentTarget.querySelector('button[type="submit"]')
  setButtonBusy(submit, true)
  let assigned = false
  try {
    await rpc('greyveil_command_center_assign_role', {
      p_user_id: $('[data-staff-user-id]').value.trim(),
      p_role: $('[data-staff-role]').value,
    })
    announce('Staff role assigned. Owner and existing account roles are unchanged.')
    event.currentTarget.reset()
    assigned = true
  } catch (error) { announce(error.message) } finally { setButtonBusy(submit, false) }
  if (!assigned) return
  try {
    await loadTeam()
    await loadAudit()
  } catch (error) {
    announce(`Staff role change completed. Refresh failed: ${error.message}`)
  }
})

$('[data-invite-form]').addEventListener('submit', async (event) => {
  event.preventDefault()
  const submit = event.currentTarget.querySelector('button[type="submit"]')
  setButtonBusy(submit, true)
  let invitationSent = false
  try {
    const { data, error } = await supabase.functions.invoke('invite-command-center-staff', {
      body: {
        email: $('[data-invite-email]').value.trim(),
        role: $('[data-invite-role]').value,
      },
    })
    if (error) {
      let message = error.message
      if (error.context instanceof Response) {
        const responseBody = await error.context.clone().json().catch(() => null)
        message = responseBody?.error?.message || message
      }
      throw new Error(message || 'The staff invitation could not be completed.')
    }
    if (!data?.success) throw new Error(data?.error?.message || 'The staff invitation was not completed.')
    announce(`Secure invitation sent. Role assigned: ${roleLabels[data.role] || data.role}.`)
    event.currentTarget.reset()
    invitationSent = true
  } catch (error) {
    console.error('Greyveil command-centre staff invitation failed.', error)
    announce(error.message || 'The staff invitation could not be completed.')
  } finally { setButtonBusy(submit, false) }
  if (invitationSent) {
    try {
      await loadTeam()
      await loadAudit()
    } catch (error) {
      announce(`Invitation sent and role assigned. Refresh failed: ${error.message}`)
    }
  }
})

$('[data-mfa-form]').addEventListener('submit', async (event) => {
  event.preventDefault()
  const factor = state.factors[0]
  if (!factor) return
  const button = event.currentTarget.querySelector('button')
  setButtonBusy(button, true)
  try {
    const { error } = await supabase.auth.mfa.challengeAndVerify({
      factorId: factor.id, code: event.currentTarget.elements.code.value.trim(),
    })
    if (error) throw error
    const session = await rpc('greyveil_command_center_session')
    showApplication(session)
    await loadOverview()
  } catch (error) {
    console.error('Greyveil command-centre MFA verification failed.', error)
    gateMessage(error.message || 'The authenticator code could not be verified.')
  } finally { setButtonBusy(button, false) }
})

$('[data-mfa-enroll]').addEventListener('click', async (event) => {
  setButtonBusy(event.currentTarget, true)
  try {
    const { data, error } = await supabase.auth.mfa.enroll({
      factorType: 'totp', friendlyName: 'Greyveil Owner Command Centre',
    })
    if (error) throw error
    state.enrollingFactorId = data.id
    $('[data-mfa-secret]').textContent = data.totp.uri
    $('[data-mfa-setup]').hidden = false
    gateMessage(`Authenticator enrollment started for ${data.totp?.friendly_name || 'this account'}.`)
  } catch (error) {
    console.error('Greyveil command-centre MFA enrollment failed.', error)
    gateMessage(error.message || 'Authenticator setup could not be started.')
  } finally { setButtonBusy(event.currentTarget, false) }
})

$('[data-mfa-enroll-form]').addEventListener('submit', async (event) => {
  event.preventDefault()
  const button = event.currentTarget.querySelector('button')
  setButtonBusy(button, true)
  try {
    const { error } = await supabase.auth.mfa.challengeAndVerify({
      factorId: state.enrollingFactorId, code: event.currentTarget.elements.code.value.trim(),
    })
    if (error) throw error
    const session = await rpc('greyveil_command_center_session')
    showApplication(session)
    await loadOverview()
  } catch (error) {
    console.error('Greyveil command-centre MFA enrollment verification failed.', error)
    gateMessage(error.message || 'Authenticator enrollment could not be verified.')
  } finally { setButtonBusy(button, false) }
})

start().catch((error) => {
  console.error('Greyveil Owner Command Centre could not initialize.', error)
  gateMessage(error.message || 'Command-centre access is unavailable.')
})
