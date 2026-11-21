import { supabase } from './supabase-client.js'
const root = document.querySelector('#cms-page')
const text = (value) => String(value ?? '').trim()
const addText = (parent, tag, className, value) => { const node = document.createElement(tag); if (className) node.className = className; node.textContent = value; parent.append(node); return node }
const slug = new URLSearchParams(location.search).get('slug') || ''
const safeUrl = (value) => { const raw = text(value); if (raw.startsWith('/') || raw.startsWith('#')) return raw; try { const url = new URL(raw); return ['http:','https:'].includes(url.protocol) ? url.href : '' } catch { return '' } }
const render = async () => {
  if (!/^[a-z0-9-]{1,80}$/.test(slug)) throw new Error('This page address is invalid.')
  const { data: page, error } = await supabase.from('cms_pages').select('id,title,slug,excerpt,body,seo_title,seo_description').eq('slug', slug).eq('status','published').maybeSingle()
  if (error) throw error
  if (!page) throw new Error('This page is not available.')
  document.title = page.seo_title || page.title + ' | Greyveil Editions'
  const description = document.querySelector('meta[name="description"]')
  if (description) description.content = page.seo_description || page.excerpt || ''
  root.replaceChildren()
  addText(root, 'p', 'cms-public-eyebrow', 'GREYVEIL EDITIONS')
  addText(root, 'h1', 'cms-public-title', page.title)
  if (page.excerpt) addText(root, 'p', 'cms-public-excerpt', page.excerpt)
  if (page.body) page.body.split(/\n\s*\n/).filter(Boolean).forEach((paragraph) => addText(root, 'p', 'cms-public-body', paragraph))
  const { data: sections, error: sectionError } = await supabase.from('cms_sections').select('*').eq('page_id', page.id).eq('is_published', true).order('sort_order')
  if (sectionError) throw sectionError
  for (const section of sections || []) {
    const card = document.createElement('section'); card.className = 'cms-public-section'
    if (section.image_path) {
      const url = supabase.storage.from('cms-media').getPublicUrl(section.image_path).data.publicUrl
      const image = document.createElement('img'); image.src = url; image.alt = section.title || 'Greyveil Editions'; image.loading = 'lazy'; card.append(image)
    }
    if (section.eyebrow) addText(card, 'p', 'cms-public-eyebrow', section.eyebrow)
    addText(card, 'h2', 'cms-public-section-title', section.title)
    if (section.body) section.body.split(/\n\s*\n/).filter(Boolean).forEach((paragraph) => addText(card, 'p', 'cms-public-body', paragraph))
    const href = safeUrl(section.button_url)
    if (section.button_label && href) { const link = document.createElement('a'); link.className = 'cms-public-button'; link.href = href; link.textContent = section.button_label; if (/^https?:/.test(href)) { link.target = '_blank'; link.rel = 'noopener noreferrer' }; card.append(link) }
    root.append(card)
  }
}
render().catch((error) => { root.replaceChildren(); addText(root, 'h1', 'cms-public-title', 'Page unavailable'); addText(root, 'p', 'cms-public-body', error.message || 'This page could not be loaded.') })
