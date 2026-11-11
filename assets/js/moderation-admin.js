import {supabase} from './supabase-client.js'
const state=document.querySelector('#moderation-state'),app=document.querySelector('#moderation-app'),list=document.querySelector('#moderation-list')
let active='posts'
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))
const load=async()=>{
 list.textContent='Loading submissions…'
 const [posts,comments]=await Promise.all([
 supabase.from('community_posts').select('id,title,body,topic,member_id,created_at').eq('status','pending').order('created_at'),
 supabase.from('community_comments').select('id,post_id,body,member_id,created_at').eq('status','pending').order('created_at')
 ])
 if(posts.error||comments.error){console.error(posts.error,comments.error);list.textContent='Could not load moderation queue.';return}
 document.querySelector('#pending-post-count').textContent=posts.data?.length||0
 document.querySelector('#pending-comment-count').textContent=comments.data?.length||0
 const rows=active==='posts'?posts.data:comments.data
 if(!rows?.length){list.innerHTML='<div class="moderation-empty">Nothing waiting for review.</div>';return}
 list.innerHTML=rows.map(item=>`<article class="moderation-item" data-id="${esc(item.id)}"><div class="moderation-meta">${active==='posts'?'POST · '+esc(item.topic):'REPLY · POST '+esc(item.post_id.slice(0,8))} · ${esc(new Date(item.created_at).toLocaleString())} · MEMBER ${esc(item.member_id.slice(0,8))}</div>${active==='posts'?'<h2>'+esc(item.title)+'</h2>':''}<p>${esc(active==='posts'?item.body:item.body)}</p><div class="moderation-actions"><button class="admin-action admin-action--primary" data-decision="published">Approve & publish</button><button class="admin-action" data-decision="rejected">Reject</button><button class="admin-action" data-decision="hidden">Hide</button></div><p class="community-request-message" role="status"></p></article>`).join('')
}
const boot=async()=>{
 const {data:{user}}=await supabase.auth.getUser()
 if(!user){state.textContent='Administrator sign-in required.';return}
 const {data:profile,error}=await supabase.from('profiles').select('role').eq('id',user.id).single()
 if(error||!['admin','super_admin'].includes(profile?.role)){state.textContent='Access denied.';return}
 state.textContent='Administrator access verified.';app.hidden=false;await load()
}
document.querySelectorAll('[data-tab]').forEach(button=>button.addEventListener('click',()=>{active=button.dataset.tab;document.querySelectorAll('[data-tab]').forEach(x=>x.classList.toggle('active',x===button));load()}))
list.addEventListener('click',async event=>{
 const button=event.target.closest('[data-decision]');if(!button)return
 const card=button.closest('[data-id]'),message=card.querySelector('.community-request-message')
 button.disabled=true;message.textContent='Saving decision…'
 const table=active==='posts'?'community_posts':'community_comments'
 const {error}=await supabase.from(table).update({status:button.dataset.decision,...(active==='posts'?{updated_at:new Date().toISOString()}:{})}).eq('id',card.dataset.id)
 if(error){console.error(error);button.disabled=false;message.textContent='Could not save. Please retry.';return}
 await load()
})
boot()
