import { supabase } from './supabase-client.js'
const state = document.querySelector('#discover-state')
const grid = document.querySelector('#offering-grid')
const filter = document.querySelector('#type-filter')
let offerings = []
let user = null
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]))
const typeNames = {programme:'Programme',event:'Event',workshop:'Workshop',opportunity:'Opportunity'}
const dateLabel = (value) => value ? new Date(value).toLocaleString(undefined,{dateStyle:'medium',timeStyle:'short'}) : ''
const render = () => {
 const selected = filter.value
 const visible = offerings.filter(item => selected === 'all' || item.offering_type === selected)
 state.textContent = visible.length ? `${visible.length} available ${visible.length === 1 ? 'experience' : 'experiences'}` : 'Nothing is listed here yet. New programmes and experiences will appear when they are ready.'
 grid.innerHTML = visible.map(item => {
   const date = dateLabel(item.starts_at)
   const mode = item.delivery_mode === 'in_person' ? (item.location_label || 'In person') : item.delivery_mode === 'hybrid' ? 'Hybrid' : 'Online'
   return `<article class="offering-card"><span class="offering-type">${escapeHtml(typeNames[item.offering_type] || item.offering_type)}</span><h3>${escapeHtml(item.title)}</h3><p>${escapeHtml(item.summary)}</p><div class="offering-meta">${date ? `<span>${escapeHtml(date)}</span>` : ''}<span>${escapeHtml(mode)}</span></div><button type="button" data-enroll="${escapeHtml(item.id)}" ${!user ? 'data-needs-login="true"' : ''}>I'm interested</button></article>`
 }).join('')
}
const load = async () => {
 const auth = await supabase.auth.getUser()
 user = auth.data?.user || null
 const {data,error} = await supabase.from('connect_offerings').select('id,title,offering_type,summary,delivery_mode,location_label,starts_at,capacity').eq('status','published').order('starts_at',{ascending:true,nullsFirst:false})
 if(error){console.error(error);state.textContent='Experiences could not be loaded. Please refresh or try again.';return}
 offerings = data || []
 render()
}
filter.addEventListener('change',render)
grid.addEventListener('click',async(event)=>{
 const button=event.target.closest('[data-enroll]')
 if(!button)return
 if(!user){window.location.href='/auth/login/';return}
 const offering=offerings.find(item=>item.id===button.dataset.enroll)
 if(!offering)return
 button.disabled=true
 const {error}=await supabase.from('connect_enrollments').insert({offering_id:offering.id,member_id:user.id})
 if(error?.code==='23505'){button.textContent='Already requested';return}
 if(error){console.error(error);button.disabled=false;button.textContent='Try again';return}
 button.textContent='Request sent'
})
load()
