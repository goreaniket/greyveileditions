import { supabase } from './supabase-client.js'
import { checkoutUrlForPayload, formatCurrency } from './commerce.js'

const host = document.querySelector('[data-access-pass-offer]')
const make = (tag, className = '', value = '') => {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (value) node.textContent = value
  return node
}
const remaining = (expiresAt) => {
  const seconds = Math.max(0, Math.floor((Date.parse(expiresAt) - Date.now()) / 1000))
  return `${String(Math.floor(seconds / 3600)).padStart(2, '0')}h ${String(Math.floor(seconds % 3600 / 60)).padStart(2, '0')}m`
}

const init = async () => {
  if (!host) return
  const { data: passes } = await supabase.from('temporary_access_passes')
    .select('id,title,price_amount,duration_hours,scope_type,collection_id').eq('active', true).order('created_at').limit(1)
  const pass = passes?.[0]
  if (!pass) return
  const payload = { purchase_type: 'pass', temporary_access_pass_id: String(pass.id) }
  const { data: auth } = await supabase.auth.getUser()
  let activation = null
  if (auth?.user) {
    const { data } = await supabase.from('temporary_access_pass_activations').select('expires_at').eq('user_id', auth.user.id).eq('pass_id', pass.id).order('expires_at', { ascending: false }).limit(1)
    activation = data?.find((item) => Date.parse(item.expires_at) > Date.now()) || null
  }
  const card = make('section', 'access-pass-offer')
  card.append(make('p', 'eyebrow', 'Greyveil 1-Day Pass'), make('h2', '', activation ? '1-Day Pass Active' : pass.title), make('p', '', activation ? `Expires in: ${remaining(activation.expires_at)}` : `Explore eligible Greyveil content for ${pass.duration_hours} hours.`))
  if (!activation) {
    card.append(make('strong', 'access-pass-offer__price', formatCurrency(pass.price_amount)))
    const link = make('a', 'button primary', 'Get 1-Day Pass')
    link.href = checkoutUrlForPayload(payload, `${window.location.pathname}${window.location.search}`)
    card.append(link)
  }
  host.replaceChildren(card)
}
init().catch(() => {})
