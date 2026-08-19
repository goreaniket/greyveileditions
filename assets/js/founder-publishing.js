import { supabase } from './supabase-client.js'

const host = document.querySelector('[data-founder-publishing]')
const ADMIN_ROLES = new Set(['admin', 'super_admin'])
const INPUT_BUCKET = 'generation-inputs'
const POLL_MS = 8000
let timer = 0
let state = { profile: null, jobs: [], books: [], series: [], collections: [], passes: [], catalogErrors: [], selectedJob: null }
let jobsRequest = 0
let jobsLoading = false
let jobsHost = null
let catalogHost = null
let passesHost = null
let passSummaryHost = null

const el = (tag, className = '', text = '') => {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text) node.textContent = text
  return node
}
const text = (value, fallback = '') => String(value ?? '').trim() || fallback
const rupees = (value) => Number.isInteger(Number(value)) && Number(value) > 0
  ? new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(Number(value) / 100)
  : 'Price not set'
const paise = (value) => {
  const match = String(value ?? '').trim().match(/^(0|[1-9]\d*)(?:\.(\d{1,2}))?$/)
  if (!match) return null
  const whole = Number(match[1]); const fraction = Number((match[2] || '').padEnd(2, '0'))
  const result = whole * 100 + fraction
  return Number.isSafeInteger(result) && result > 0 ? result : null
}
const local = (value) => value ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : '-'
const select = (name, label, items, selected = '', empty = 'Select', catalogKey = '') => {
  const wrap = el('label', 'admin-book-control'); wrap.append(el('span', '', label))
  const control = document.createElement('select'); control.name = name
  if (catalogKey) { control.dataset.catalogSelect = catalogKey; control.dataset.emptyLabel = empty }
  control.append(new Option(empty, ''))
  items.forEach((item) => control.append(new Option(text(item.title, item.slug), item.id)))
  control.value = selected || ''
  wrap.append(control); return wrap
}
const field = (name, label, type = 'text', value = '', required = false) => {
  const wrap = el('label', 'admin-book-control'); wrap.append(el('span', '', label))
  const input = document.createElement(type === 'textarea' ? 'textarea' : 'input'); input.name = name; input.value = value || ''; input.required = required
  if (type !== 'textarea') input.type = type; else input.rows = 2
  wrap.append(input); return wrap
}
const setStatus = (node, message, kind = '') => { node.textContent = message; node.dataset.status = kind }
const protectForm = (form) => {
  form.dataset.dirty = 'false'
  const markDirty = () => { form.dataset.dirty = 'true' }
  form.addEventListener('input', markDirty)
  form.addEventListener('change', markDirty)
  return form
}
const eta = (job) => {
  const started = Date.parse(job.started_at); const progress = Number(job.progress)
  if (!started || !progress || progress >= 100 || ['FAILED', 'PUBLISHED'].includes(job.status)) return ''
  const remaining = Math.round(((Date.now() - started) / 1000) * (100 - progress) / progress)
  if (!Number.isFinite(remaining) || remaining < 1) return ''
  return `Estimated remaining: ~${String(Math.floor(remaining / 60)).padStart(2, '0')}:${String(remaining % 60).padStart(2, '0')}`
}

const catalogDefinitions = [
  { key: 'books', table: 'books', select: 'id,title,slug,series_id,book_number,visibility,is_active,price_amount', fallback: 'id,title,slug,series_id,book_number,visibility,is_active' },
  { key: 'series', table: 'series', select: 'id,title,slug,collection_id,visibility,price_amount', fallback: 'id,title,slug,collection_id,visibility' },
  { key: 'collections', table: 'collections', select: 'id,title,slug,visibility,price_amount', fallback: 'id,title,slug,visibility' },
  { key: 'passes', table: 'temporary_access_passes', select: 'id,slug,title,active,price_amount,duration_hours,scope_type,collection_id' },
]

const catalogError = (key, error) => `${key[0].toUpperCase()}${key.slice(1)} could not be loaded: ${text(error?.message, 'an authorized catalog query failed.')}`

const loadCatalogRecord = async ({ key, table, select: columns, fallback }) => {
  const result = await supabase.from(table).select(columns).order('title')
  if (!result.error) return { key, data: result.data || [], error: '' }
  if (!fallback) return { key, data: [], error: catalogError(key, result.error) }
  const fallbackResult = await supabase.from(table).select(fallback).order('title')
  if (fallbackResult.error) return { key, data: [], error: catalogError(key, fallbackResult.error) }
  return {
    key,
    data: (fallbackResult.data || []).map((item) => ({ ...item, price_amount: null })),
    error: `${catalogError(key, result.error)} Prices are shown as not set until the pricing schema is available.`,
  }
}

const loadCatalog = async () => {
  const results = await Promise.all(catalogDefinitions.map(loadCatalogRecord))
  state.catalogErrors = results.map((result) => result.error).filter(Boolean)
  results.forEach((result) => { state[result.key] = result.data })
}

const loadInitial = async () => {
  const [jobs] = await Promise.all([
    supabase.from('book_generation_jobs').select('*').order('created_at', { ascending: false }).limit(12),
    loadCatalog(),
  ])
  if (jobs.error) throw jobs.error
  state.jobs = jobs.data || []
  render()
}

const refreshJobs = async () => {
  if (jobsLoading) return
  jobsLoading = true
  const request = ++jobsRequest
  try {
    const { data, error } = await supabase.from('book_generation_jobs').select('*').order('created_at', { ascending: false }).limit(12)
    if (error) throw error
    if (request !== jobsRequest) return
    state.jobs = data || []
    renderJobsPanel()
  } finally {
    jobsLoading = false
  }
}

const refreshPasses = async () => {
  const { data, error } = await supabase.from('temporary_access_passes').select('id,slug,title,active,price_amount,duration_hours,scope_type,collection_id').order('title')
  if (error) throw error
  state.passes = data || []
  renderPassSummary()
}

const catalogItemsFor = (key) => state[key] || []
const syncCatalogSelect = (control) => {
  const selected = control.value
  const items = catalogItemsFor(control.dataset.catalogSelect)
  control.replaceChildren(new Option(control.dataset.emptyLabel || 'Select', ''))
  items.forEach((item) => control.append(new Option(text(item.title, item.slug), item.id)))
  control.value = selected
}
const syncCatalogSelectors = () => {
  document.querySelectorAll('[data-founder-publishing] [data-catalog-select]').forEach(syncCatalogSelect)
}
const hasDirtyCatalogInputs = () => Boolean(catalogHost?.querySelector('form[data-dirty="true"]'))
const refreshCatalog = async () => {
  await loadCatalog()
  syncCatalogSelectors()
  if (!hasDirtyCatalogInputs()) renderCatalogPanel()
  else catalogHost?.querySelector('[data-catalog-refresh-note]')?.replaceChildren('Catalog data changed. Save or reload your unsaved price edits to see newly added rows.')
  renderCatalogNotices()
}

const createJob = async (bookId = null) => {
  const { data, error } = await supabase.rpc('greyveil_admin_create_generation_job', { target_book_id: bookId })
  if (error) throw error
  return data
}
const uploadInput = async (jobId, name, file) => {
  if (!file) return ''
  const path = `jobs/${jobId}/${name}`
  const { error } = await supabase.storage.from(INPUT_BUCKET).upload(path, file, { upsert: true, contentType: file.type || 'application/octet-stream' })
  if (error) throw error
  return path
}
const queue = async (jobId, form, manuscriptPath, coverPath) => {
  const values = new FormData(form)
  const metadata = Object.fromEntries(['title', 'subtitle', 'author', 'language', 'publisher', 'slug', 'description'].map((key) => [key, text(values.get(key))]))
  const visibility = text(values.get('visibility'), 'paid')
  const price = visibility === 'paid' ? paise(values.get('price')) : null
  const { error } = await supabase.rpc('greyveil_admin_queue_generation_job', {
    target_job_id: jobId, target_manuscript_path: manuscriptPath, target_cover_path: coverPath || '', target_metadata: metadata,
    target_design_source_slug: text(values.get('design'), 'the-last-shift'), target_series_id: text(values.get('series')) || null,
    target_collection_id: text(values.get('collection')) || null, target_book_number: Number(values.get('book_number')) || null,
    target_visibility: visibility, target_price_amount: price,
  })
  if (error) throw error
}
const jobAction = async (job, action) => {
  if (action === 'publish') {
    const { error } = await supabase.rpc('greyveil_admin_publish_generation_job', { target_job_id: job.id }); if (error) throw error
  } else if (action === 'cancel') {
    const { error } = await supabase.rpc('greyveil_admin_cancel_generation_job', { target_job_id: job.id }); if (error) throw error
  } else if (action === 'retry') {
    const { error } = await supabase.rpc('greyveil_admin_queue_generation_job', {
      target_job_id: job.id, target_manuscript_path: job.manuscript_path, target_cover_path: job.cover_path || '', target_metadata: job.metadata,
      target_design_source_slug: job.design_source_slug, target_series_id: job.series_id, target_collection_id: job.collection_id,
      target_book_number: job.book_number, target_visibility: job.visibility, target_price_amount: job.price_amount,
    }); if (error) throw error
  }
  await refreshJobs()
  if (action === 'publish') await refreshCatalog()
}

const renderCreator = () => {
  const card = protectForm(el('form', 'admin-card founder-creator')); card.noValidate = true
  card.append(el('p', 'admin-eyebrow', 'New or replacement manuscript'), el('h3', '', 'Add New Book'))
  const existing = select('existing_book', 'Existing Book (optional)', state.books, '', 'New book', 'books')
  const grid = el('div', 'admin-access-grid')
  grid.append(existing, field('manuscript', 'Manuscript (.docx)', 'file', '', true), field('cover', 'Cover image', 'file'), field('title', 'Title', 'text', '', true), field('subtitle', 'Subtitle'), field('author', 'Author'), field('language', 'Language', 'text', 'en'), field('publisher', 'Publisher', 'text', 'Greyveil Editions'), field('slug', 'Slug', 'text', '', true), field('description', 'Description', 'textarea'), select('design', 'Design', [{ id: 'the-last-shift', title: 'Configured reference design' }], 'the-last-shift'), select('series', 'Series', state.series, '', 'Select', 'series'), select('collection', 'Collection', state.collections, '', 'Select', 'collections'), field('book_number', 'Book number', 'number'), select('visibility', 'Commerce status', [{ id: 'public', title: 'Public' }, { id: 'paid', title: 'Paid' }], 'paid'), field('price', 'Book price (₹)', 'number', ''))
  grid.querySelector('[name=manuscript]').accept = '.docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  grid.querySelector('[name=cover]').accept = 'image/png,image/jpeg,image/webp'
  card.append(grid)
  const actions = el('div', 'admin-form-actions'); const detect = el('button', 'admin-action', 'Detect Structure'); detect.type = 'button'; const submit = el('button', 'admin-action admin-action--primary', 'Queue Generation'); submit.type = 'submit'; const status = el('p', 'admin-form-status'); status.setAttribute('role', 'status'); actions.append(detect, submit, status); card.append(actions)
  detect.addEventListener('click', async () => {
    const manuscript = card.elements.manuscript.files?.[0]; const cover = card.elements.cover.files?.[0]
    if (!manuscript || !/\.docx$/i.test(manuscript.name)) return setStatus(status, 'Choose a DOCX manuscript before detection.', 'error')
    detect.disabled = true; try { const job = await createJob(card.elements.existing_book.value || null); const manuscriptPath = await uploadInput(job.id, 'manuscript.docx', manuscript); const coverPath = cover ? await uploadInput(job.id, `cover.${cover.name.split('.').pop().toLowerCase()}`, cover) : ''; const { error } = await supabase.rpc('greyveil_admin_request_generation_detection', { target_job_id: job.id, target_manuscript_path: manuscriptPath, target_cover_path: coverPath || null }); if (error) throw error; card.dataset.jobId = job.id; setStatus(status, 'Detection queued. Review the detected metadata in the job list, then confirm the editable fields and queue generation.', 'success'); await refreshJobs() } catch (error) { setStatus(status, error.message || 'Detection could not be queued.', 'error') } finally { detect.disabled = false }
  })
  card.addEventListener('submit', async (event) => {
    event.preventDefault(); if (!card.reportValidity()) return
    const manuscript = card.elements.manuscript.files?.[0]; const cover = card.elements.cover.files?.[0]
    if (!manuscript || !/\.docx$/i.test(manuscript.name)) return setStatus(status, 'A DOCX manuscript is required.', 'error')
    submit.disabled = true; setStatus(status, 'Uploading private inputs…', 'info')
    try {
      const job = card.dataset.jobId ? { id: card.dataset.jobId } : await createJob(card.elements.existing_book.value || null)
      const manuscriptPath = await uploadInput(job.id, 'manuscript.docx', manuscript)
      const coverPath = cover ? await uploadInput(job.id, `cover.${cover.name.split('.').pop().toLowerCase()}`, cover) : ''
      await queue(job.id, card, manuscriptPath, coverPath); card.dataset.dirty = 'false'; setStatus(status, 'Queued. The external worker will detect, import, generate, and validate this candidate.', 'success'); await refreshJobs()
    } catch (error) { setStatus(status, error.message || 'The job could not be queued.', 'error') } finally { submit.disabled = false }
  })
  return card
}

const renderJobs = () => {
  const card = el('section', 'admin-card founder-jobs'); card.append(el('div', 'admin-card-heading', ''))
  card.firstChild.append(el('h3', '', 'Generation Jobs'), el('p', '', 'Polling only while this panel is open. ETA is calculated from actual elapsed runtime and recorded progress.'))
  if (!state.jobs.length) { card.append(el('p', 'admin-empty', 'No generation jobs yet.')); return card }
  state.jobs.forEach((job) => {
    const row = el('article', 'founder-job'); const top = el('div', 'founder-job__top')
    const title = text(job.metadata?.title, state.books.find((book) => String(book.id) === String(job.book_id))?.title || 'Untitled candidate')
    top.append(el('strong', '', title), el('span', 'admin-badge', job.status.replaceAll('_', ' '))); row.append(top)
    const meter = document.createElement('progress'); meter.max = 100; meter.value = Number(job.progress) || 0; row.append(meter, el('p', '', `${job.progress}% · ${job.status.replaceAll('_', ' ')}`))
    const remaining = eta(job); if (remaining) row.append(el('small', '', remaining)); if (job.error) row.append(el('p', 'admin-form-status', job.error))
    const qa = job.qa || {}; const qaLine = el('p', 'founder-job__qa', `Source ${qa.source ? '✓' : '—'} · PDF ${qa.pdf ? '✓' : '—'} · EPUB ${qa.epub ? '✓' : '—'} · DOCX ${qa.docx ? '✓' : '—'} · Metadata ${qa.metadata ? '✓' : '—'}`); row.append(qaLine)
    if (job.status === 'AWAITING_REVIEW') row.append(el('small', '', `Detected: ${text(job.metadata?.title, 'title missing')} · ${text(job.metadata?.author, 'author missing')} · ${text(job.metadata?.language, 'language unspecified')}`))
    const actions = el('div', 'admin-form-actions')
    if (job.status === 'READY_TO_PUBLISH' && qa.ok === true) { const button = el('button', 'admin-action admin-action--primary', 'Request Publish'); button.type = 'button'; button.addEventListener('click', () => jobAction(job, 'publish').catch((error) => alert(error.message))); actions.append(button) }
    if (['FAILED', 'CANCELLED'].includes(job.status)) { const button = el('button', 'admin-action', 'Regenerate'); button.type = 'button'; button.addEventListener('click', () => jobAction(job, 'retry').catch((error) => alert(error.message))); actions.append(button) }
    if (['DRAFT', 'QUEUED', 'AWAITING_REVIEW', 'FAILED'].includes(job.status)) { const button = el('button', 'admin-action', 'Cancel'); button.type = 'button'; button.addEventListener('click', () => jobAction(job, 'cancel').catch((error) => alert(error.message))); actions.append(button) }
    row.append(actions); card.append(row)
  }); return card
}

const renderJobsPanel = () => { if (jobsHost) jobsHost.replaceChildren(renderJobs()) }

const updateCatalogBaseline = (item, priceAmount, visibility) => {
  const records = item.type === 'book' ? state.books : item.type === 'series' ? state.series : state.collections
  const baseline = records.find((record) => String(record.id) === String(item.id))
  if (baseline) { baseline.price_amount = priceAmount; baseline.visibility = visibility }
}

const renderCatalog = () => {
  const card = el('section', 'admin-card founder-catalog'); card.append(el('p', 'admin-eyebrow', 'Commerce changes'), el('h3', '', 'Prices and Membership'))
  card.append(el('p', 'admin-panel-note', 'Saving price or public/paid status never regenerates files. Series and Collection ownership follows current membership automatically.'))
  const refresh = el('button', 'admin-action', 'Refresh catalog'); refresh.type = 'button'; refresh.addEventListener('click', () => refreshCatalog().catch((error) => alert(error.message || 'Catalog could not be refreshed.'))); card.append(refresh)
  const refreshNote = el('p', 'admin-form-status'); refreshNote.dataset.catalogRefreshNote = ''; refreshNote.setAttribute('role', 'status'); card.append(refreshNote)
  const list = el('div', 'admin-platform-list')
  const rows = [...state.books.map((item) => ({ ...item, type: 'book' })), ...state.series.map((item) => ({ ...item, type: 'series' })), ...state.collections.map((item) => ({ ...item, type: 'collection' }))]
  rows.forEach((item) => {
    const row = protectForm(el('form', 'admin-platform-item')); const title = el('strong', '', `${item.type}: ${item.title}`); const price = document.createElement('input'); price.type = 'text'; price.inputMode = 'decimal'; price.placeholder = 'Price not set'; price.value = Number.isInteger(Number(item.price_amount)) && Number(item.price_amount) > 0 ? String(Number(item.price_amount) / 100) : ''
    const visibility = document.createElement('select'); ['public', 'paid', 'private'].forEach((value) => visibility.append(new Option(value, value))); visibility.value = item.visibility || 'paid'
    const save = el('button', 'admin-action', 'Save Commerce Changes'); save.type = 'submit'; row.append(title, price, visibility, save)
    row.addEventListener('submit', async (event) => { event.preventDefault(); save.disabled = true; try { const p = paise(price.value); if (visibility.value === 'paid' && !p) throw new Error('Paid items require a valid price.'); if (!p) throw new Error('Enter a valid positive price.'); const id = String(item.id); const { error: priceError } = await supabase.rpc('greyveil_admin_update_catalog_price', { target_type: item.type, target_id: id, new_price_amount: p }); if (priceError) throw priceError; const { error: visibilityError } = await supabase.rpc('greyveil_admin_update_catalog_visibility', { target_type: item.type, target_id: id, new_visibility: visibility.value }); if (visibilityError) throw visibilityError; updateCatalogBaseline(item, p, visibility.value); row.dataset.dirty = 'false' } catch (error) { alert(error.message) } finally { save.disabled = false } })
    list.append(row)
  }); card.append(list); return card
}

const renderPasses = () => {
  const card = el('section', 'admin-card founder-passes'); card.append(el('p', 'admin-eyebrow', 'Temporary access'), el('h3', '', '1-Day Passes'))
  const current = state.passes[0] || {}; const form = protectForm(el('form', 'admin-access-grid')); const title = field('title', 'Title', 'text', current.title || '', true); const slug = field('slug', 'Slug', 'text', current.slug || '', true); const price = field('price', 'Price (₹)', 'text', Number.isInteger(Number(current.price_amount)) && Number(current.price_amount) > 0 ? String(Number(current.price_amount) / 100) : '', true); price.querySelector('input').inputMode = 'decimal'; price.querySelector('input').placeholder = 'Price not set'; const duration = field('duration', 'Duration hours', 'number', current.duration_hours || '24', true); const scope = select('scope', 'Scope', [{ id: 'collection', title: 'Collection' }, { id: 'library', title: 'Library' }], current.scope_type || 'collection'); const collection = select('collection', 'Collection', state.collections, current.collection_id, 'Select', 'collections'); const active = select('active', 'Status', [{ id: 'true', title: 'Active' }, { id: 'false', title: 'Inactive' }], current.active === false ? 'false' : 'true'); const save = el('button', 'admin-action admin-action--primary', 'Save 1-Day Pass'); save.type = 'submit'; const status = el('p', 'admin-form-status'); status.setAttribute('role', 'status')
  form.append(title, slug, price, duration, scope, collection, active, save, status); card.append(form)
  const syncScope = () => { const library = form.elements.scope.value === 'library'; form.elements.collection.disabled = library; form.elements.collection.required = !library; collection.classList.toggle('is-disabled', library); if (library) setStatus(status, 'Library scope does not require a Collection.', 'info'); else if (status.dataset.status === 'info') setStatus(status) }
  form.elements.scope.addEventListener('change', syncScope); syncScope()
  form.addEventListener('submit', async (event) => { event.preventDefault(); if (!form.reportValidity()) return; save.disabled = true; try { const library = form.elements.scope.value === 'library'; const priceAmount = paise(form.elements.price.value); const payload = { title: form.elements.title.value.trim(), slug: form.elements.slug.value.trim().toLowerCase(), price_amount: priceAmount, duration_hours: Number(form.elements.duration.value), scope_type: library ? 'library' : 'collection', collection_id: library ? null : form.elements.collection.value || null, active: form.elements.active.value === 'true' }; if (!priceAmount) throw new Error('Enter a valid positive price.'); if (!library && !payload.collection_id) throw new Error('Choose a collection-scoped pass or select Library.'); const { error } = await supabase.from('temporary_access_passes').upsert(payload, { onConflict: 'slug' }); if (error) throw error; form.dataset.dirty = 'false'; setStatus(status, '1-Day Pass saved.', 'success'); await refreshPasses() } catch (error) { setStatus(status, error.message || '1-Day Pass could not be saved.', 'error') } finally { save.disabled = false } })
  passSummaryHost = el('div', 'founder-pass-summary')
  card.append(passSummaryHost)
  renderPassSummary()
  return card
}

const renderCatalogPanel = () => { if (catalogHost) catalogHost.replaceChildren(renderCatalog()) }
const renderPassesPanel = () => { if (passesHost) passesHost.replaceChildren(renderPasses()) }
const renderCatalogNotices = () => {
  const message = state.catalogErrors.join(' ')
  document.querySelectorAll('[data-founder-publishing] [data-catalog-status]').forEach((node) => setStatus(node, message, message ? 'error' : ''))
}
const renderPassSummary = () => {
  if (!passSummaryHost) return
  if (!state.passes.length) { passSummaryHost.replaceChildren(el('p', 'admin-empty', 'No access passes are configured.')); return }
  passSummaryHost.replaceChildren(...state.passes.map((pass) => el('p', '', `${pass.active ? 'Active' : 'Inactive'} · ${pass.title} · ${rupees(pass.price_amount)} · ${pass.duration_hours} hours`)))
}
const render = () => {
  if (!host) return
  jobsHost = el('div', 'founder-jobs-host')
  catalogHost = el('div', 'founder-catalog-host')
  passesHost = el('div', 'founder-passes-host')
  const catalogStatus = el('p', 'admin-form-status'); catalogStatus.dataset.catalogStatus = ''; catalogStatus.setAttribute('role', 'status')
  host.replaceChildren(catalogStatus, renderCreator(), jobsHost, catalogHost, passesHost)
  renderJobsPanel()
  renderCatalogPanel()
  renderPassesPanel()
  renderCatalogNotices()
}
const start = async () => {
  if (!host) return
  const { data: auth } = await supabase.auth.getUser(); if (!auth?.user) return
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', auth.user.id).maybeSingle(); if (!ADMIN_ROLES.has(profile?.role)) return
  state.profile = profile; await loadInitial()
  window.addEventListener('greyveil:catalog-changed', () => refreshCatalog().catch(() => {}))
  window.clearInterval(timer); timer = window.setInterval(() => {
    if (!document.hidden && document.querySelector('[data-admin-panel="publishing"]')?.classList.contains('is-active')) refreshJobs().catch(() => {})
  }, POLL_MS)
}
start().catch(() => {})
