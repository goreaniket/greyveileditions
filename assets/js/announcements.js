import { supabase } from './supabase-client.js'
import { getEntitlementSnapshot } from './content-access.js'

const create = (tag, className = '', text = '') => {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text) node.textContent = text
  return node
}

const placementForPage = () => {
  const path = window.location.pathname
  if (/^\/(?:index\.html)?$/.test(path)) return 'home'
  if (path.startsWith('/account')) return 'account'
  if (path.startsWith('/projects')) return 'project'
  return ''
}

const dismissed = (id) => {
  try { return localStorage.getItem(`greyveil:announcement-dismissed:${id}`) === 'true' } catch (_error) { return false }
}

const dismiss = (id) => {
  try { localStorage.setItem(`greyveil:announcement-dismissed:${id}`, 'true') } catch (_error) {}
}

const safeUrl = (value, { allowRelative = true } = {}) => {
  const text = String(value || '').trim()
  if (!text) return ''
  try {
    const url = new URL(text, window.location.origin)
    if (!['http:', 'https:'].includes(url.protocol)) return ''
    if (!allowRelative && !/^https?:\/\//i.test(text)) return ''
    return url.href
  } catch (_error) {
    return ''
  }
}

const announcementContent = (announcement, compact = false) => {
  const content = create('div', compact ? 'announcement-content announcement-content--compact' : 'announcement-content')
  const imageUrl = safeUrl(announcement.image_url, { allowRelative: false })
  if (imageUrl && !compact) {
    const image = create('img', 'announcement-image')
    image.src = imageUrl
    image.alt = ''
    image.loading = 'lazy'
    content.append(image)
  }
  const copy = create('div')
  if (!compact) copy.append(create('em', 'announcement-kicker', 'New from Greyveil'))
  copy.append(create('strong', '', announcement.title), create('span', '', announcement.message))
  content.append(copy)
  const ctaUrl = safeUrl(announcement.cta_url)
  if (announcement.cta_label && ctaUrl) {
    const link = create('a', 'announcement-link', announcement.cta_label)
    link.href = ctaUrl
    content.append(link)
  }
  return content
}

const renderHeroHighlight = (announcement) => {
  if (dismissed(announcement.id)) return
  const main = document.querySelector('main')
  if (!main) return
  const section = create('section', 'page-shell announcement-hero-highlight')
  section.setAttribute('aria-label', 'New from Greyveil')
  section.append(announcementContent(announcement))
  const close = create('button', 'announcement-hero-highlight__close', 'Dismiss')
  close.type = 'button'
  close.addEventListener('click', () => { dismiss(announcement.id); section.remove() })
  section.append(close)
  const hero = main.querySelector('h1')?.closest('section, header, div')
  if (hero?.parentNode) hero.insertAdjacentElement('afterend', section)
  else main.insertBefore(section, main.firstChild)
}

const renderFloating = (announcement) => {
  if (dismissed(announcement.id)) return
  const card = create('aside', 'floating-announcement')
  card.setAttribute('aria-label', 'Announcement')
  card.append(announcementContent(announcement, true))
  const close = create('button', 'floating-announcement__close', 'Close')
  close.type = 'button'
  close.setAttribute('aria-label', 'Dismiss announcement')
  close.addEventListener('click', () => { dismiss(announcement.id); card.remove() })
  card.append(close)
  document.body.append(card)
}

const renderBanner = (announcement) => {
  if (dismissed(announcement.id)) return
  const banner = create('aside', 'site-announcement')
  banner.setAttribute('aria-label', 'Announcement')
  banner.append(announcementContent(announcement))
  const close = create('button', 'site-announcement__close', 'Close')
  close.type = 'button'
  close.setAttribute('aria-label', 'Dismiss announcement')
  close.addEventListener('click', () => { dismiss(announcement.id); banner.remove() })
  banner.append(close)
  const skipLink = document.querySelector('.skip-link')
  if (skipLink?.parentNode === document.body) skipLink.insertAdjacentElement('afterend', banner)
  else document.body.insertBefore(banner, document.body.firstChild)
}

const renderPageAnnouncement = (announcement) => {
  if (dismissed(announcement.id)) return
  const main = document.querySelector('main')
  if (!main) return
  const section = create('section', 'page-shell page-announcement')
  section.append(announcementContent(announcement))
  const library = announcement.placement === 'library'
    ? document.querySelector('[data-account-library]')
    : null
  if (library?.parentNode) library.parentNode.insertBefore(section, library)
  else main.insertBefore(section, main.firstChild)
}

const markRead = async (userId, announcementIds) => {
  if (!announcementIds.length) return
  await supabase.from('notification_reads').upsert(
    announcementIds.map((announcementId) => ({ user_id: userId, announcement_id: announcementId, read_at: new Date().toISOString() })),
    { onConflict: 'user_id,announcement_id' }
  )
}

const renderNotificationCenter = async (snapshot, announcements) => {
  if (!snapshot.context.user?.id || !announcements.length) return
  const { data: reads } = await supabase
    .from('notification_reads')
    .select('announcement_id, read_at')
    .eq('user_id', snapshot.context.user.id)
  const readIds = new Set((reads || []).map((item) => item.announcement_id))
  const unread = announcements.filter((item) => !readIds.has(item.id))

  const host = document.querySelector('.nav-links') || document.querySelector('nav')
  if (!host || document.querySelector('[data-notification-center]')) return
  const wrapper = create('div', 'notification-center')
  wrapper.dataset.notificationCenter = ''
  const button = create('button', 'notification-center__button', 'Notifications')
  button.type = 'button'
  button.setAttribute('aria-expanded', 'false')
  if (unread.length) button.append(create('span', 'notification-center__count', String(unread.length)))
  const panel = create('div', 'notification-center__panel')
  panel.hidden = true
  const heading = create('div', 'notification-center__heading')
  heading.append(create('strong', '', 'Notifications'), create('span', '', unread.length ? `${unread.length} unread` : 'Up to date'))
  panel.append(heading)
  announcements.forEach((announcement) => {
    const item = create('article', `notification-item ${readIds.has(announcement.id) ? '' : 'is-unread'}`.trim())
    item.append(announcementContent(announcement, true))
    panel.append(item)
  })
  button.addEventListener('click', async () => {
    panel.hidden = !panel.hidden
    button.setAttribute('aria-expanded', String(!panel.hidden))
    if (!panel.hidden && unread.length) {
      await markRead(snapshot.context.user.id, unread.map((item) => item.id))
      button.querySelector('.notification-center__count')?.remove()
      panel.querySelectorAll('.is-unread').forEach((item) => item.classList.remove('is-unread'))
    }
  })
  document.addEventListener('click', (event) => {
    if (wrapper.contains(event.target)) return
    panel.hidden = true
    button.setAttribute('aria-expanded', 'false')
  })
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || panel.hidden) return
    panel.hidden = true
    button.setAttribute('aria-expanded', 'false')
    button.focus()
  })
  wrapper.append(button, panel)
  host.append(wrapper)
}

export const initAnnouncements = async () => {
  try {
    const snapshot = await getEntitlementSnapshot()
    const { data, error } = await supabase
      .from('announcements')
      .select('id, title, message, image_url, cta_label, cta_url, placement, audience, starts_at, ends_at, active, created_at')
      .order('created_at', { ascending: false })
    if (error) return
    const announcements = data || []
    const pagePlacement = placementForPage()
    const banner = announcements.find((item) => item.placement === 'site-wide')
    if (banner) renderFloating(banner)
    if (pagePlacement === 'home') announcements.filter((item) => item.placement === 'home').forEach(renderHeroHighlight)
    announcements
      .filter((item) => item.placement === pagePlacement && item.placement !== 'home' || (pagePlacement === 'account' && item.placement === 'library'))
      .forEach(renderPageAnnouncement)
    await renderNotificationCenter(snapshot, announcements)
  } catch (error) {
    console.info('Announcements are not available.', { message: error?.message, code: error?.code })
  }
}
