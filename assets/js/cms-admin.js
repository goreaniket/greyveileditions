import { supabase } from './supabase-client.js'

const $ = (selector, root = document) => root.querySelector(selector)
const create = (tag, className, text) => {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}
const clean = (value) => String(value ?? '').trim()
const slugify = (value) => clean(value).toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80)
const status = (message, type = '') => {
  const node = $('[data-cms-status]')
  if (node) { node.textContent = message; node.dataset.status = type }
}
const setFormStatus = (selector, message, type = '') => {
  const node = $(selector)
  if (node) { node.textContent = message; node.dataset.status = type }
}
const safeUrl = (value) => {
  const raw = clean(value)
  if (!raw) return ''
  if (raw.startsWith('/') || raw.startsWith('#')) return raw
  try {
    const url = new URL(raw)
    return ['https:', 'http:'].includes(url.protocol) ? url.href : ''
  } catch { return '' }
}
const state = { user: null, role: '', pages: [], sections: [], media: [], selectedPage: null, editingPage: null, editingSection: null }

const audit = async (action, entityType, entityId, details = {}) => {
  const { error } = await supabase.from('cms_audit_logs').insert({ action, entity_type: entityType, entity_id: entityId || null, details })
  if (error) console.warn('CMS audit log write failed:', error.message)
}
const saveRevision = async (entityType, item) => {
  const payload = { entity_type: entityType, entity_id: item.id, snapshot: item }
  if (entityType === 'page') payload.page_id = item.id
  if (entityType === 'section') { payload.page_id = item.page_id; payload.section_id = item.id }
  const { error } = await supabase.from('cms_revisions').insert(payload)
  if (error) throw error
}
const mediaUrl = (path) => path ? supabase.storage.from('cms-media').getPublicUrl(path).data.publicUrl : ''

const requireAdmin = async () => {
  const { data: sessionData, error: sessionError } = await supabase.auth.getSession()
  if (sessionError || !sessionData.session?.user) throw new Error('Sign in with your Greyveil admin account first.')
  state.user = sessionData.session.user
  const { data: profile, error } = await supabase.from('profiles').select('role').eq('id', state.user.id).maybeSingle()
  if (error) throw error
  if (!['admin', 'super_admin'].includes(profile?.role)) throw new Error('Your account does not have CMS administration permission.')
  state.role = profile.role
}

const pageForm = () => $('[data-cms-page-form]')
const sectionForm = () => $('[data-cms-section-form]')
const resetPageForm = () => {
  pageForm()?.reset()
  pageForm().elements.id.value = ''
  pageForm().elements.slug.readOnly = false
  pageForm().elements.status.disabled = false
  state.editingPage = null
  $('[data-cms-page-submit]').textContent = 'Create Page'
}
const resetSectionForm = () => {
  sectionForm()?.reset()
  sectionForm().elements.id.value = ''
  state.editingSection = null
  $('[data-cms-section-submit]').textContent = 'Add Section'
}
const fillPageForm = (page) => {
  const form = pageForm()
  form.reset()
  form.elements.id.value = page.id
  form.elements.title.value = page.title || ''
  form.elements.slug.value = page.slug || ''
  form.elements.slug.readOnly = page.is_homepage
  form.elements.status.disabled = page.is_homepage
  form.elements.excerpt.value = page.excerpt || ''
  form.elements.body.value = page.body || ''
  form.elements.status.value = page.status
  form.elements.seo_title.value = page.seo_title || ''
  form.elements.seo_description.value = page.seo_description || ''
  state.editingPage = page
  $('[data-cms-page-submit]').textContent = 'Save Page'
}
const fillSectionForm = (section) => {
  const form = sectionForm()
  form.reset()
  form.elements.id.value = section.id
  form.elements.title.value = section.title || ''
  form.elements.eyebrow.value = section.eyebrow || ''
  form.elements.body.value = section.body || ''
  form.elements.button_label.value = section.button_label || ''
  form.elements.button_url.value = section.button_url || ''
  form.elements.image_path.value = section.image_path || ''
  form.elements.sort_order.value = section.sort_order ?? 0
  form.elements.is_published.value = String(section.is_published)
  state.editingSection = section
  $('[data-cms-section-submit]').textContent = 'Save Section'
}
const renderPages = () => {
  const list = $('[data-cms-pages]')
  list.replaceChildren()
  state.pages.forEach((page) => {
    const card = create('article', 'cms-admin-item')
    const info = create('div', 'cms-admin-item__info')
    info.append(create('strong', '', page.title), create('span', '', '/' + page.slug + ' · ' + page.status + (page.is_homepage ? ' · Homepage' : '')))
    const actions = create('div', 'cms-admin-actions')
    const edit = create('button', 'admin-action', 'Edit')
    edit.type = 'button'; edit.addEventListener('click', () => { state.selectedPage = page; fillPageForm(page); renderSections() })
    actions.append(edit)
    if (page.status === 'published') {
      const preview = create('a', 'admin-action', 'Preview')
      preview.href = page.is_homepage ? '/' : '/cms-page.html?slug=' + encodeURIComponent(page.slug)
      preview.target = '_blank'; preview.rel = 'noopener'
      actions.append(preview)
    }
    if (!page.is_homepage && page.status !== 'archived') {
      const archive = create('button', 'admin-action admin-action--danger', 'Archive')
      archive.type = 'button'
      archive.addEventListener('click', async () => {
        if (!window.confirm('Archive "' + page.title + '"? It will no longer be publicly visible.')) return
        archive.disabled = true
        try { await saveRevision('page', page) } catch (revisionError) { status(revisionError.message || 'Page revision could not be saved.', 'error'); archive.disabled = false; return }
        const { error } = await supabase.from('cms_pages').update({ status: 'archived', updated_by: state.user.id, updated_at: new Date().toISOString() }).eq('id', page.id)
        if (error) { status(error.message, 'error'); archive.disabled = false; return }
        await audit('archive', 'page', page.id, { title: page.title, slug: page.slug })
        await loadAll()
        status('Page archived.', 'success')
      })
      actions.append(archive)
    }
    card.append(info, actions)
    list.append(card)
  })
  if (!state.pages.length) list.append(create('p', 'admin-empty', 'No pages yet.'))
}
const renderSections = () => {
  resetSectionForm()
  const list = $('[data-cms-sections]')
  list.replaceChildren()
  const page = state.selectedPage
  $('[data-cms-selected-page]').textContent = page ? page.title + ' · /' + page.slug : 'Select a page to manage its sections.'
  $('[data-cms-section-form]').hidden = !page
  $('[data-cms-section-page-empty]').hidden = Boolean(page)
  if (!page) return
  state.sections.filter((section) => section.page_id === page.id).sort((a,b) => a.sort_order - b.sort_order).forEach((section) => {
    const card = create('article', 'cms-admin-item')
    const info = create('div', 'cms-admin-item__info')
    info.append(create('strong', '', section.title || 'Untitled section'), create('span', '', 'Order ' + section.sort_order + ' · ' + (section.is_published ? 'Published' : 'Draft')))
    const actions = create('div', 'cms-admin-actions')
    const edit = create('button', 'admin-action', 'Edit')
    edit.type = 'button'; edit.addEventListener('click', () => fillSectionForm(section))
    const remove = create('button', 'admin-action admin-action--danger', 'Delete')
    remove.type = 'button'
    remove.addEventListener('click', async () => {
      if (!window.confirm('Permanently delete this homepage/page section?')) return
      remove.disabled = true
      await audit('delete', 'section', section.id, { page_id: section.page_id, title: section.title })
      const { error } = await supabase.from('cms_sections').delete().eq('id', section.id)
      if (error) { status(error.message, 'error'); remove.disabled = false; return }
      state.sections = state.sections.filter((item) => item.id !== section.id)
      renderSections(); status('Section deleted.', 'success')
    })
    actions.append(edit, remove)
    card.append(info, actions); list.append(card)
  })
  if (!state.sections.some((section) => section.page_id === page.id)) list.append(create('p', 'admin-empty', 'No sections on this page yet.'))
}
const renderMedia = () => {
  const list = $('[data-cms-media]')
  const select = sectionForm().elements.image_path
  const current = select.value
  list.replaceChildren()
  select.replaceChildren(new Option('No image', ''))
  state.media.forEach((item) => {
    const option = new Option(item.file_name, item.storage_path)
    select.add(option)
    const card = create('article', 'cms-media-item')
    if (item.mime_type.startsWith('image/')) {
      const img = document.createElement('img'); img.src = mediaUrl(item.storage_path); img.alt = item.alt_text || item.file_name; card.append(img)
    }
    const details = create('div', 'cms-admin-item__info')
    details.append(create('strong', '', item.file_name), create('span', '', item.mime_type + ' · ' + Math.ceil(item.file_size / 1024) + ' KB'))
    const actions = create('div', 'cms-admin-actions')
    const copy = create('button', 'admin-action', 'Copy URL')
    copy.type = 'button'; copy.addEventListener('click', async () => { await navigator.clipboard.writeText(mediaUrl(item.storage_path)); status('Public file URL copied.', 'success') })
    const remove = create('button', 'admin-action admin-action--danger', 'Delete')
    remove.type = 'button'
    remove.addEventListener('click', async () => {
      const used = state.sections.some((section) => section.image_path === item.storage_path)
      if (used) { status('This file is attached to a section. Remove the attachment before deleting it.', 'error'); return }
      if (!window.confirm('Delete "' + item.file_name + '" from the media library?')) return
      remove.disabled = true
      const { error: storageError } = await supabase.storage.from('cms-media').remove([item.storage_path])
      if (storageError) { status(storageError.message, 'error'); remove.disabled = false; return }
      const { error } = await supabase.from('cms_media').delete().eq('id', item.id)
      if (error) { status(error.message, 'error'); remove.disabled = false; return }
      await audit('delete', 'media', item.id, { file_name: item.file_name })
      await loadMedia(); status('File deleted.', 'success')
    })
    actions.append(copy, remove); card.append(details, actions); list.append(card)
  })
  select.value = state.media.some((item) => item.storage_path === current) ? current : ''
  if (!state.media.length) list.append(create('p', 'admin-empty', 'No uploaded files yet.'))
}
const loadMedia = async () => {
  const { data, error } = await supabase.from('cms_media').select('*').order('created_at', { ascending: false })
  if (error) throw error
  state.media = data || []; renderMedia()
}
const loadAll = async () => {
  const [pagesResult, sectionsResult] = await Promise.all([
    supabase.from('cms_pages').select('*').order('updated_at', { ascending: false }),
    supabase.from('cms_sections').select('*').order('sort_order', { ascending: true }),
  ])
  if (pagesResult.error) throw pagesResult.error
  if (sectionsResult.error) throw sectionsResult.error
  state.pages = pagesResult.data || []; state.sections = sectionsResult.data || []
  if (!state.selectedPage || !state.pages.some((page) => page.id === state.selectedPage.id)) state.selectedPage = state.pages.find((page) => page.is_homepage) || state.pages[0] || null
  renderPages(); renderSections(); await loadMedia()
}
const handlePageSubmit = async (event) => {
  event.preventDefault()
  const form = event.currentTarget
  const title = clean(form.elements.title.value)
  const slug = state.editingPage?.is_homepage ? 'home' : slugify(form.elements.slug.value || title)
  if (!title || !slug) { setFormStatus('[data-cms-page-status]', 'Page title and slug are required.', 'error'); return }
  const payload = { title, slug, excerpt: clean(form.elements.excerpt.value), body: clean(form.elements.body.value), status: form.elements.status.value, seo_title: clean(form.elements.seo_title.value), seo_description: clean(form.elements.seo_description.value), updated_by: state.user.id, updated_at: new Date().toISOString() }
  if (payload.status === 'published') payload.published_at = state.editingPage?.published_at || new Date().toISOString()
  const submit = $('[data-cms-page-submit]'); submit.disabled = true
  try {
    let result
    if (state.editingPage) {
      await saveRevision('page', state.editingPage)
      result = await supabase.from('cms_pages').update(payload).eq('id', state.editingPage.id).select().single()
    } else {
      result = await supabase.from('cms_pages').insert({ ...payload, created_by: state.user.id }).select().single()
    }
    if (result.error) throw result.error
    await audit(state.editingPage ? 'update' : 'create', 'page', result.data.id, { title, slug, status: payload.status })
    state.selectedPage = result.data
    await loadAll(); fillPageForm(result.data)
    setFormStatus('[data-cms-page-status]', 'Page saved.', 'success')
  } catch (error) { setFormStatus('[data-cms-page-status]', error.message || 'Page could not be saved.', 'error') }
  finally { submit.disabled = false }
}
const handleSectionSubmit = async (event) => {
  event.preventDefault()
  const form = event.currentTarget
  if (!state.selectedPage) return
  const payload = { page_id: state.selectedPage.id, title: clean(form.elements.title.value), eyebrow: clean(form.elements.eyebrow.value), body: clean(form.elements.body.value), button_label: clean(form.elements.button_label.value), button_url: safeUrl(form.elements.button_url.value), image_path: form.elements.image_path.value, sort_order: Number(form.elements.sort_order.value || 0), is_published: form.elements.is_published.value === 'true', updated_by: state.user.id, updated_at: new Date().toISOString() }
  if (!payload.title) { setFormStatus('[data-cms-section-status]', 'Section title is required.', 'error'); return }
  if (clean(form.elements.button_url.value) && !payload.button_url) { setFormStatus('[data-cms-section-status]', 'Use a valid http(s), site-relative or anchor URL.', 'error'); return }
  const submit = $('[data-cms-section-submit]'); submit.disabled = true
  try {
    let result
    if (state.editingSection) {
      await saveRevision('section', state.editingSection)
      result = await supabase.from('cms_sections').update(payload).eq('id', state.editingSection.id).select().single()
    } else {
      result = await supabase.from('cms_sections').insert({ ...payload, created_by: state.user.id }).select().single()
    }
    if (result.error) throw result.error
    await audit(state.editingSection ? 'update' : 'create', 'section', result.data.id, { page_id: payload.page_id, title: payload.title })
    state.sections = state.sections.filter((item) => item.id !== result.data.id).concat(result.data)
    resetSectionForm(); renderSections()
    setFormStatus('[data-cms-section-status]', 'Section saved.', 'success')
  } catch (error) { setFormStatus('[data-cms-section-status]', error.message || 'Section could not be saved.', 'error') }
  finally { submit.disabled = false }
}
const handleUpload = async (event) => {
  const file = event.currentTarget.files?.[0]
  if (!file) return
  const allowed = ['image/jpeg','image/png','image/webp','image/gif']
  if (!allowed.includes(file.type) || file.size > 25 * 1024 * 1024) { status('Choose a JPG, PNG, WebP or GIF image under 25 MB. Private PDFs and EPUBs stay in the existing protected Books / Files system.', 'error'); event.currentTarget.value = ''; return }
  const path = state.user.id + '/' + crypto.randomUUID() + '-' + file.name.replace(/[^a-zA-Z0-9._-]/g, '-')
  const upload = await supabase.storage.from('cms-media').upload(path, file, { contentType: file.type, upsert: false })
  if (upload.error) { status(upload.error.message, 'error'); return }
  const record = await supabase.from('cms_media').insert({ storage_path: path, file_name: file.name, mime_type: file.type, file_size: file.size, alt_text: clean($('[data-cms-upload-alt]').value), created_by: state.user.id }).select().single()
  if (record.error) {
    await supabase.storage.from('cms-media').remove([path])
    status(record.error.message, 'error'); return
  }
  await audit('upload', 'media', record.data.id, { file_name: file.name, mime_type: file.type, file_size: file.size })
  event.currentTarget.value = ''; $('[data-cms-upload-alt]').value = ''
  await loadMedia(); status('File uploaded to the media library.', 'success')
}

const init = async () => {
  const panel = $('[data-admin-panel="cms"]')
  if (!panel) return
  try {
    await requireAdmin()
    $('[data-cms-role]').textContent = state.role === 'super_admin' ? 'Super Admin' : 'Admin'
    await loadAll()
    pageForm().addEventListener('submit', handlePageSubmit)
    sectionForm().addEventListener('submit', handleSectionSubmit)
    document.querySelectorAll('[data-cms-page-reset]').forEach((button) => button.addEventListener('click', resetPageForm))
    $('[data-cms-section-reset]').addEventListener('click', resetSectionForm)
    $('[data-cms-upload]').addEventListener('change', handleUpload)
    $('[data-cms-page-title]').addEventListener('input', (event) => {
      if (!state.editingPage) pageForm().elements.slug.value = slugify(event.target.value)
    })
    $('[data-cms-page-select-home]').addEventListener('click', () => {
      const home = state.pages.find((page) => page.is_homepage)
      if (home) { state.selectedPage = home; fillPageForm(home); renderSections() }
    })
    window.addEventListener('greyveil:cms-refresh', () => loadAll().catch((error) => status(error.message, 'error')))
    panel.addEventListener('cms:opened', () => loadAll().catch((error) => status(error.message, 'error')))
    document.querySelectorAll('[data-admin-tab="cms"]').forEach((button) => button.addEventListener('click', () => {
      if (!state.pages.length) loadAll().catch((error) => status(error.message, 'error'))
    }))
    status('CMS connected. Public pages and homepage sections are managed here.', 'success')
  } catch (error) {
    status(error.message || 'CMS could not initialize.', 'error')
  }
}
init()
