import { supabase } from './assets/js/supabase-client.js'
const root = document.querySelector('#cms-homepage-sections')
if (root) {
  const safeUrl = (value) => { const raw = String(value || '').trim(); if (raw.startsWith('/') || raw.startsWith('#')) return raw; try { const u = new URL(raw); return ['http:','https:'].includes(u.protocol) ? u.href : '' } catch { return '' } }
  const add = (parent, tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; node.textContent = text || ''; parent.append(node); return node }
  const load = async () => {
    const { data: page, error } = await supabase.from('cms_pages').select('id').eq('slug','home').eq('status','published').maybeSingle()
    if (error || !page) return
    const { data: sections, error: sectionError } = await supabase.from('cms_sections').select('*').eq('page_id',page.id).eq('is_published',true).order('sort_order')
    if (sectionError) return
    for (const section of sections || []) {
      const card = document.createElement('section'); card.className = 'cms-homepage-section'
      const copy = document.createElement('div')
      if (section.eyebrow) add(copy,'p','cms-homepage-eyebrow',section.eyebrow)
      add(copy,'h2','',section.title)
      if (section.body) section.body.split(/\n\s*\n/).filter(Boolean).forEach((p) => add(copy,'p','',p))
      const url = safeUrl(section.button_url)
      if (section.button_label && url) { const link = add(copy,'a','',section.button_label); link.href = url; if (/^https?:/.test(url)) { link.target='_blank'; link.rel='noopener noreferrer' } }
      card.append(copy)
      if (section.image_path) { const image = document.createElement('img'); image.src = supabase.storage.from('cms-media').getPublicUrl(section.image_path).data.publicUrl; image.alt = section.title || 'Greyveil Editions'; image.loading = 'lazy'; card.append(image) }
      root.append(card)
    }
  }
  load()
}
