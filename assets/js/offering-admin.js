import { supabase } from './supabase-client.js'
const state=document.querySelector('#offering-admin-state')
const app=document.querySelector('#offering-admin-app')
const form=document.querySelector('#offering-form')
const list=document.querySelector('#offering-admin-list')
const message=document.querySelector('#offering-form-message')
const save=document.querySelector('#offering-save')
const val=id=>document.querySelector('#'+id).value
const set=(id,value)=>{document.querySelector('#'+id).value=value??''}
const escapeHtml=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))
const localInput=value=>value?new Date(value).toISOString().slice(0,16):''
let adminUser=null
const reset=()=>{form.reset();set('offering-id','');set('offering-form-title','Create an experience');document.querySelector('#offering-form-title').textContent='Create an experience';save.textContent='Save experience';message.textContent=''}
const load=async()=>{
 list.textContent='Loading listings…'
 const {data,error}=await supabase.from('connect_offerings').select('*').order('created_at',{ascending:false}).limit(100)
 if(error){console.error(error);list.textContent='Could not load listings.';return}
 if(!data.length){list.textContent='No listings yet. Create the first one.';return}
 list.innerHTML=data.map(item=>`<article class="offering-admin-item" data-offering="${escapeHtml(item.id)}"><small>${escapeHtml(item.offering_type)} · ${escapeHtml(item.status)}</small><h3>${escapeHtml(item.title)}</h3><p>${escapeHtml(item.summary)}</p><div class="offering-admin-item-actions"><button class="admin-action" type="button" data-edit> Edit </button><button class="admin-action" type="button" data-toggle>${item.status==='published'?'Unpublish':'Publish'} </button><button class="admin-action" type="button" data-enrolments>Enrolments</button></div></article>`).join('')
}
const boot=async()=>{
 const {data:{user}}=await supabase.auth.getUser()
 if(!user){state.textContent='Administrator sign-in required.';return}
 const {data:profile,error}=await supabase.from('profiles').select('role').eq('id',user.id).single()
 if(error||!['admin','super_admin'].includes(profile?.role)){state.textContent='Access denied. This page is restricted to Greyveil administrators.';return}
 adminUser=user;state.textContent='Administrator access verified.';app.hidden=false;await load()
}
form.addEventListener('submit',async event=>{
 event.preventDefault()
 const title=val('offering-title').trim(),summary=val('offering-summary').trim()
 if(title.length<3||summary.length<20){message.textContent='Add a title and a description of at least 20 characters.';return}
 const start=val('offering-start'),end=val('offering-end')
 if(start&&end&&new Date(end)<=new Date(start)){message.textContent='End time must be after start time.';return}
 const payload={title,offering_type:val('offering-type'),summary,details:val('offering-details')||null,delivery_mode:val('offering-mode'),location_label:val('offering-location')||null,starts_at:start?new Date(start).toISOString():null,ends_at:end?new Date(end).toISOString():null,capacity:val('offering-capacity')?Number(val('offering-capacity')):null,status:val('offering-status'),updated_at:new Date().toISOString()}
 const id=val('offering-id')
 save.disabled=true;message.textContent='Saving…'
 const result=id?await supabase.from('connect_offerings').update(payload).eq('id',id):await supabase.from('connect_offerings').insert({...payload,created_by:adminUser.id})
 save.disabled=false
 if(result.error){console.error(result.error);message.textContent='Could not save. Check required fields and permissions.';return}
 message.textContent='Saved successfully.';reset();await load()
})
list.addEventListener('click',async event=>{
 const card=event.target.closest('[data-offering]');if(!card)return
 const id=card.dataset.offering
 if(event.target.closest('[data-edit]')){
  const {data,error}=await supabase.from('connect_offerings').select('*').eq('id',id).single()
  if(error||!data){message.textContent='Could not load this listing.';return}
  set('offering-id',data.id);set('offering-title',data.title);set('offering-type',data.offering_type);set('offering-summary',data.summary);set('offering-details',data.details);set('offering-mode',data.delivery_mode);set('offering-location',data.location_label);set('offering-capacity',data.capacity);set('offering-start',localInput(data.starts_at));set('offering-end',localInput(data.ends_at));set('offering-status',data.status);document.querySelector('#offering-form-title').textContent='Edit experience';save.textContent='Update experience';window.scrollTo({top:0,behavior:'smooth'});return
 }
 if(event.target.closest('[data-toggle]')){
  const {data,error}=await supabase.from('connect_offerings').select('status').eq('id',id).single()
  if(error)return
  const next=data.status==='published'?'draft':'published'
  const result=await supabase.from('connect_offerings').update({status:next,updated_at:new Date().toISOString()}).eq('id',id)
  if(result.error){console.error(result.error);return}await load();return
 }
 if(event.target.closest('[data-enrolments]')){
  const {data,error}=await supabase.from('connect_enrollments').select('id,member_id,status,created_at,note').eq('offering_id',id).order('created_at',{ascending:false})
  if(error){window.alert('Could not load enrolments.');return}
  const summary=(data||[]).map(x=>x.member_id+' — '+x.status+(x.note?' — '+x.note:'')).join('\n')
  window.alert((data?.length||0)+' enrolment(s)\n'+(summary||'No enrolments yet.'))
 }
})
document.querySelector('#offering-refresh').addEventListener('click',load)
document.querySelector('#offering-reset').addEventListener('click',reset)
boot()
