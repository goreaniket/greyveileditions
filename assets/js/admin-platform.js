import { supabase } from './supabase-client.js'

const ADMIN_ROLES = new Set(['admin', 'super_admin'])
const ROLE_OPTIONS = ['customer', 'admin', 'super_admin']
const getText = (value, fallback = '') => String(value ?? '').trim() || fallback
const bySelector = (selector) => document.querySelector(selector)
const clear = (node) => { if (node) node.replaceChildren() }
const formatDate = (value) => {
  if (!value) return '-'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '-' : new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium' }).format(date)
}
const formatRole = (role) => role === 'super_admin' ? 'Super Admin' : role === 'admin' ? 'Admin' : 'Customer'
const create = (tag, className = '', text = '') => {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text) node.textContent = text
  return node
}
const setStatus = (selector, message, type = '') => {
  const node = bySelector(selector)
  if (!node) return
  node.textContent = message
  node.dataset.status = type
}
const nullableNumber = (value) => getText(value) ? Number(value) : null
const nullableDate = (value) => getText(value) ? new Date(value).toISOString() : null

const sessionToken = async () => {
  const { data } = await supabase.auth.getSession()
  return data?.session?.access_token || ''
}

const adminApiGet = async (path) => {
  const token = await sessionToken()
  const response = await fetch(path, {
    headers: { Authorization: `Bearer ${token}` },
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(payload?.error?.message || 'Admin data could not be loaded.')
  return payload
}

const state = {
  user: null,
  profile: null,
  users: [],
  reviews: [],
  profiles: [],
  books: [],
  coupons: [],
  couponProducts: [],
  announcements: [],
}

const isSuperAdmin = () => state.profile?.role === 'super_admin'

const accessSummary = (summary = {}) => {
  const parts = [
    summary.collections ? `${summary.collections} collection` : '',
    summary.series ? `${summary.series} series` : '',
    summary.books ? `${summary.books} book` : '',
    summary.direct_grants ? `${summary.direct_grants} grant` : '',
  ].filter(Boolean)
  return parts.join(', ') || 'No paid access'
}

const renderUsers = () => {
  const table = bySelector('[data-users-table]')
  if (!table) return
  clear(table)
  const query = getText(bySelector('[data-user-search]')?.value).toLowerCase()
  const roleFilter = getText(bySelector('[data-user-role]')?.value)
  const users = state.users.filter((profile) => {
    const haystack = `${profile.display_name || ''} ${profile.email || ''}`.toLowerCase()
    return (!query || haystack.includes(query)) && (!roleFilter || profile.role === roleFilter)
  })

  users.forEach((profile) => {
    const row = document.createElement('tr')
    ;[
      getText(profile.display_name, 'Unnamed reader'),
      getText(profile.email, 'Email unavailable'),
      formatRole(profile.role),
      formatDate(profile.created_at),
      accessSummary(profile.summary),
    ].forEach((value) => {
      const cell = document.createElement('td')
      cell.textContent = value
      row.append(cell)
    })

    const controlCell = document.createElement('td')
    if (isSuperAdmin() && profile.id !== state.user.id) {
      const select = document.createElement('select')
      select.className = 'admin-compact-control'
      ROLE_OPTIONS.forEach((role) => {
        const option = new Option(formatRole(role), role, false, role === profile.role)
        select.add(option)
      })
      select.setAttribute('aria-label', `Role for ${getText(profile.display_name, profile.email)}`)
      select.addEventListener('change', async () => {
        const previousRole = profile.role
        select.disabled = true
        const { error } = await supabase.from('profiles').update({ role: select.value }).eq('id', profile.id)
        if (error) {
          select.value = previousRole
          window.alert(error.message || 'Role could not be changed.')
        } else {
          profile.role = select.value
          window.dispatchEvent(new CustomEvent('greyveil:role-changed', { detail: { userId: profile.id } }))
        }
        select.disabled = false
      })
      controlCell.append(select)
    } else {
      controlCell.textContent = isSuperAdmin() ? 'Current account' : 'Super admin only'
    }
    row.append(controlCell)
    table.append(row)
  })
  const empty = bySelector('[data-users-empty]')
  if (empty) empty.hidden = Boolean(users.length)
}

const loadUsers = async () => {
  const payload = await adminApiGet('/api/admin-users')
  state.users = payload.users || []
  renderUsers()
}

const reviewCard = (review) => {
  const profile = state.profiles.find((item) => String(item.id) === String(review.user_id))
  const book = state.books.find((item) => String(item.id) === String(review.book_id))
  const card = create('article', 'admin-platform-item admin-review-item')
  const heading = create('div', 'admin-platform-item__heading')
  const title = create('div')
  title.append(
    create('strong', '', getText(book?.title, 'Unknown book')),
    create('span', '', `${getText(profile?.display_name, 'Reader')} - ${review.rating}/5`)
  )
  heading.append(title, create('span', `admin-status admin-status--${review.moderation_status}`, review.moderation_status))
  const text = create('p', 'admin-review-item__text', review.review_text)
  const meta = create('p', 'admin-platform-item__meta', `Submitted ${formatDate(review.created_at)} - Updated ${formatDate(review.updated_at)}`)
  const actions = create('div', 'admin-form-actions')
  ;['pending', 'approved', 'rejected'].forEach((status) => {
    const button = create('button', `admin-action ${status === 'approved' ? 'admin-action--primary' : ''}`, status === 'pending' ? 'Return to Pending' : status === 'approved' ? 'Approve' : 'Reject')
    button.type = 'button'
    button.disabled = review.moderation_status === status
    button.addEventListener('click', async () => {
      button.disabled = true
      const { error } = await supabase.from('book_reviews').update({ moderation_status: status }).eq('id', review.id)
      if (error) window.alert(error.message || 'Review could not be updated.')
      else {
        review.moderation_status = status
        renderReviews()
      }
      button.disabled = false
    })
    actions.append(button)
  })
  card.append(heading, text, meta, actions)
  return card
}

const renderReviews = () => {
  const list = bySelector('[data-admin-reviews]')
  if (!list) return
  clear(list)
  const filter = getText(bySelector('[data-review-filter]')?.value)
  const reviews = state.reviews.filter((review) => !filter || review.moderation_status === filter)
  reviews.forEach((review) => list.append(reviewCard(review)))
  const empty = bySelector('[data-admin-reviews-empty]')
  if (empty) empty.hidden = Boolean(reviews.length)
}

const loadReviews = async () => {
  const [reviews, profiles, books] = await Promise.all([
    supabase.from('book_reviews').select('*').order('created_at', { ascending: false }),
    supabase.from('profiles').select('id, display_name'),
    supabase.from('books').select('id, title'),
  ])
  if (reviews.error) throw reviews.error
  state.reviews = reviews.data || []
  state.profiles = profiles.data || []
  state.books = books.data || []
  renderReviews()
}

const couponProductsFor = (couponId) => state.couponProducts.filter((item) => item.coupon_id === couponId)

const fillCouponForm = (coupon) => {
  const form = bySelector('[data-coupon-form]')
  if (!form) return
  form.reset()
  ;['id', 'code', 'description', 'discount_type', 'discount_value', 'fixed_final_price', 'maximum_total_uses', 'maximum_uses_per_user'].forEach((name) => {
    if (form.elements[name]) form.elements[name].value = coupon?.[name] ?? ''
  })
  form.elements.active.value = String(coupon?.active !== false)
  form.elements.valid_from.value = coupon?.valid_from ? coupon.valid_from.slice(0, 16) : ''
  form.elements.valid_until.value = coupon?.valid_until ? coupon.valid_until.slice(0, 16) : ''
  Array.from(form.elements.purchase_types || []).forEach((input) => {
    input.checked = (coupon?.applicable_purchase_types || ['book', 'series', 'collection']).includes(input.value)
  })
  form.elements.products.value = coupon
    ? couponProductsFor(coupon.id).map((item) => `${item.purchase_type}:${item.target_id}`).join('\n')
    : ''
  form.elements.code.focus()
}

const renderCoupons = () => {
  const list = bySelector('[data-admin-coupons]')
  if (!list) return
  clear(list)
  state.coupons.forEach((coupon) => {
    const item = create('article', 'admin-platform-item')
    const heading = create('div', 'admin-platform-item__heading')
    const title = create('div')
    title.append(create('strong', '', coupon.code), create('span', '', getText(coupon.description, coupon.discount_type)))
    heading.append(title, create('span', `admin-status admin-status--${coupon.active ? 'approved' : 'rejected'}`, coupon.active ? 'active' : 'inactive'))
    const detail = coupon.discount_type === 'fixed_final_price'
      ? `Final price: ${(Number(coupon.fixed_final_price) / 100).toLocaleString('en-IN', { style: 'currency', currency: 'INR' })}`
      : `${coupon.discount_type}: ${coupon.discount_value}`
    const meta = create('p', 'admin-platform-item__meta', `${detail} - ${coupon.applicable_purchase_types.join(', ')}`)
    const actions = create('div', 'admin-form-actions')
    const edit = create('button', 'admin-action', 'Edit')
    edit.type = 'button'
    edit.addEventListener('click', () => fillCouponForm(coupon))
    const toggle = create('button', 'admin-action', coupon.active ? 'Deactivate' : 'Activate')
    toggle.type = 'button'
    toggle.addEventListener('click', async () => {
      const { error } = await supabase.from('coupons').update({ active: !coupon.active, updated_at: new Date().toISOString() }).eq('id', coupon.id)
      if (error) window.alert(error.message)
      else { coupon.active = !coupon.active; renderCoupons() }
    })
    const remove = create('button', 'admin-action admin-action--danger', 'Delete')
    remove.type = 'button'
    remove.addEventListener('click', async () => {
      if (!window.confirm(`Delete coupon ${coupon.code}?`)) return
      const { error } = await supabase.from('coupons').delete().eq('id', coupon.id)
      if (error) window.alert(error.message)
      else { state.coupons = state.coupons.filter((item) => item.id !== coupon.id); renderCoupons() }
    })
    actions.append(edit, toggle, remove)
    item.append(heading, meta, actions)
    list.append(item)
  })
}

const loadCoupons = async () => {
  if (!isSuperAdmin()) return
  const [coupons, products] = await Promise.all([
    supabase.from('coupons').select('*').order('created_at', { ascending: false }),
    supabase.from('coupon_products').select('*'),
  ])
  if (coupons.error) throw coupons.error
  state.coupons = coupons.data || []
  state.couponProducts = products.data || []
  renderCoupons()
}

const saveCoupon = async (event) => {
  event.preventDefault()
  const form = event.currentTarget
  const id = getText(form.elements.id.value)
  const applicableTypes = Array.from(form.querySelectorAll('[name="purchase_types"]:checked')).map((input) => input.value)
  if (!applicableTypes.length) return setStatus('[data-coupon-status]', 'Choose at least one purchase type.', 'error')
  const productLines = getText(form.elements.products.value).split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  const products = productLines.map((line) => {
    const separator = line.indexOf(':')
    const purchaseType = separator > 0 ? line.slice(0, separator).trim() : ''
    const targetId = separator > 0 ? line.slice(separator + 1).trim() : ''
    return ['book', 'series', 'collection'].includes(purchaseType) && targetId
      ? { purchase_type: purchaseType, target_id: targetId }
      : null
  })
  if (products.some((product) => !product)) {
    return setStatus('[data-coupon-status]', 'Use one valid type:id product target per line.', 'error')
  }
  const payload = {
    code: getText(form.elements.code.value).toUpperCase(),
    description: getText(form.elements.description.value) || null,
    active: form.elements.active.value === 'true',
    discount_type: form.elements.discount_type.value,
    discount_value: Number(form.elements.discount_value.value || 0),
    fixed_final_price: nullableNumber(form.elements.fixed_final_price.value),
    valid_from: nullableDate(form.elements.valid_from.value),
    valid_until: nullableDate(form.elements.valid_until.value),
    maximum_total_uses: nullableNumber(form.elements.maximum_total_uses.value),
    maximum_uses_per_user: nullableNumber(form.elements.maximum_uses_per_user.value),
    applicable_purchase_types: applicableTypes,
    applies_to_all_products: products.length === 0,
    updated_at: new Date().toISOString(),
    ...(!id ? { created_by: state.user.id } : {}),
  }
  setStatus('[data-coupon-status]', 'Saving coupon...', 'info')
  const result = id
    ? await supabase.from('coupons').update(payload).eq('id', id).select().single()
    : await supabase.from('coupons').insert(payload).select().single()
  if (result.error) return setStatus('[data-coupon-status]', result.error.message, 'error')

  const coupon = result.data
  await supabase.from('coupon_products').delete().eq('coupon_id', coupon.id)
  if (products.length) {
    const productResult = await supabase.from('coupon_products').insert(
      products.map((product) => ({ ...product, coupon_id: coupon.id }))
    )
    if (productResult.error) return setStatus('[data-coupon-status]', productResult.error.message, 'error')
  }
  form.reset()
  setStatus('[data-coupon-status]', 'Coupon saved.', 'success')
  await loadCoupons()
}

const fillAnnouncementForm = (announcement) => {
  const form = bySelector('[data-announcement-form]')
  if (!form) return
  form.reset()
  ;['id', 'title', 'message', 'placement', 'audience', 'audience_target_id', 'image_url', 'cta_label', 'cta_url'].forEach((name) => {
    if (form.elements[name]) form.elements[name].value = announcement?.[name] ?? ''
  })
  form.elements.active.value = String(announcement?.active !== false)
  form.elements.starts_at.value = announcement?.starts_at ? announcement.starts_at.slice(0, 16) : ''
  form.elements.ends_at.value = announcement?.ends_at ? announcement.ends_at.slice(0, 16) : ''
  form.elements.title.focus()
}

const renderAnnouncements = () => {
  const list = bySelector('[data-admin-announcements]')
  if (!list) return
  clear(list)
  state.announcements.forEach((announcement) => {
    const item = create('article', 'admin-platform-item')
    const heading = create('div', 'admin-platform-item__heading')
    const title = create('div')
    title.append(create('strong', '', announcement.title), create('span', '', `${announcement.placement} - ${announcement.audience}`))
    heading.append(title, create('span', `admin-status admin-status--${announcement.active ? 'approved' : 'rejected'}`, announcement.active ? 'active' : 'inactive'))
    const message = create('p', 'admin-review-item__text', announcement.message)
    const meta = create('p', 'admin-platform-item__meta', `${formatDate(announcement.starts_at || announcement.created_at)} to ${formatDate(announcement.ends_at)}`)
    const actions = create('div', 'admin-form-actions')
    const edit = create('button', 'admin-action', 'Edit')
    edit.type = 'button'
    edit.addEventListener('click', () => fillAnnouncementForm(announcement))
    const toggle = create('button', 'admin-action', announcement.active ? 'Deactivate' : 'Activate')
    toggle.type = 'button'
    toggle.addEventListener('click', async () => {
      const { error } = await supabase.from('announcements').update({ active: !announcement.active, updated_at: new Date().toISOString() }).eq('id', announcement.id)
      if (error) window.alert(error.message)
      else { announcement.active = !announcement.active; renderAnnouncements() }
    })
    actions.append(edit, toggle)
    item.append(heading, message, meta, actions)
    list.append(item)
  })
}

const loadAnnouncements = async () => {
  const { data, error } = await supabase.from('announcements').select('*').order('created_at', { ascending: false })
  if (error) throw error
  state.announcements = data || []
  renderAnnouncements()
}

const saveAnnouncement = async (event) => {
  event.preventDefault()
  const form = event.currentTarget
  const id = getText(form.elements.id.value)
  const audience = form.elements.audience.value
  const payload = {
    title: getText(form.elements.title.value),
    message: getText(form.elements.message.value),
    placement: form.elements.placement.value,
    audience,
    audience_target_id: ['series-owner', 'collection-owner'].includes(audience) ? getText(form.elements.audience_target_id.value) : null,
    image_url: getText(form.elements.image_url.value) || null,
    cta_label: getText(form.elements.cta_label.value) || null,
    cta_url: getText(form.elements.cta_url.value) || null,
    starts_at: nullableDate(form.elements.starts_at.value),
    ends_at: nullableDate(form.elements.ends_at.value),
    active: form.elements.active.value === 'true',
    updated_at: new Date().toISOString(),
    ...(!id ? { created_by: state.user.id } : {}),
  }
  setStatus('[data-announcement-status]', 'Saving announcement...', 'info')
  const result = id
    ? await supabase.from('announcements').update(payload).eq('id', id)
    : await supabase.from('announcements').insert(payload)
  if (result.error) return setStatus('[data-announcement-status]', result.error.message, 'error')
  form.reset()
  setStatus('[data-announcement-status]', 'Announcement saved.', 'success')
  await loadAnnouncements()
}

const init = async () => {
  const { data: userResult } = await supabase.auth.getUser()
  state.user = userResult?.user || null
  if (!state.user) return
  const { data: profile } = await supabase.from('profiles').select('id, role').eq('id', state.user.id).maybeSingle()
  state.profile = profile
  if (!ADMIN_ROLES.has(profile?.role)) return

  document.body.dataset.platformUsersManaged = 'true'
  document.querySelectorAll('[data-super-admin-only]').forEach((node) => {
    node.hidden = !isSuperAdmin()
  })
  const roleFilter = bySelector('[data-user-role]')
  if (roleFilter && roleFilter.options.length === 1) {
    ROLE_OPTIONS.forEach((role) => roleFilter.add(new Option(formatRole(role), role)))
  }

  bySelector('[data-user-search]')?.addEventListener('input', () => window.setTimeout(renderUsers, 0))
  roleFilter?.addEventListener('change', () => window.setTimeout(renderUsers, 0))
  bySelector('[data-review-filter]')?.addEventListener('change', renderReviews)
  bySelector('[data-coupon-form]')?.addEventListener('submit', saveCoupon)
  bySelector('[data-announcement-form]')?.addEventListener('submit', saveAnnouncement)
  bySelector('[data-admin-refresh]')?.addEventListener('click', () => window.setTimeout(loadAll, 0))

  await loadAll()
}

const loadAll = async () => {
  const tasks = [loadUsers(), loadReviews(), loadAnnouncements()]
  if (isSuperAdmin()) tasks.push(loadCoupons())
  const results = await Promise.allSettled(tasks)
  results.filter((result) => result.status === 'rejected').forEach((result) => {
    console.info('Admin platform section could not be loaded.', { message: result.reason?.message })
  })
}

init()
