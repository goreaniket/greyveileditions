import {supabase} from './supabase-client.js'
const feed=document.querySelector('#community-feed'),form=document.querySelector('#post-form'),postStatus=document.querySelector('#post-status'),submit=document.querySelector('#post-submit'),filter=document.querySelector('#feed-filter')
let user=null,posts=[]
const topics={belonging:'Belonging & connection',everyday_life:'Everyday life',learning:'Learning & growth',creativity:'Creativity',ideas:'Ideas & solutions',wins:'Small wins'}
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))
const load=async()=>{
 const auth=await supabase.auth.getUser();user=auth.data?.user||null
 if(!user){feed.innerHTML='<div class="feed-empty">Sign in to read and participate in the Greyveil community. <a href="/auth/login/">Sign in ↗</a></div>';form.hidden=true;return}
 const {data,error}=await supabase.from('community_posts').select('id,member_id,title,body,topic,status,created_at').eq('status','published').order('created_at',{ascending:false}).limit(50)
 if(error){console.error(error);feed.textContent='Community posts could not be loaded.';return}
 posts=data||[];render()
}
const render=()=>{
 const visible=posts.filter(p=>filter.value==='all'||p.topic===filter.value)
 feed.innerHTML=visible.length?visible.map(p=>`<article class="feed-card" data-post="${esc(p.id)}"><span class="feed-topic">${esc(topics[p.topic]||p.topic)}</span><h3>${esc(p.title)}</h3><div class="feed-body">${esc(p.body)}</div><div class="feed-meta">Community member · ${esc(new Date(p.created_at).toLocaleDateString())}</div><div class="comment-list" id="comments-${esc(p.id)}"><span class="comment-note">Loading replies…</span></div><form class="comment-form" data-comment-form="${esc(p.id)}"><input name="comment" minlength="2" maxlength="1200" required placeholder="Add a thoughtful reply"><button type="submit">Reply</button></form><p class="comment-note">Replies are reviewed before appearing.</p></article>`).join(''):'<div class="feed-empty">No published conversations in this topic yet. You can start one; it will be reviewed before appearing.</div>'
 visible.forEach(loadComments)
}
const loadComments=async p=>{
 const target=document.querySelector('#comments-'+p.id);if(!target)return
 const {data,error}=await supabase.from('community_comments').select('id,body,created_at').eq('post_id',p.id).eq('status','published').order('created_at')
 if(error){target.textContent='Replies unavailable.';return}
 target.innerHTML=data?.length?data.map(c=>`<div class="feed-comment">${esc(c.body)}</div>`).join(''):'<span class="comment-note">No replies yet.</span>'
}
form.addEventListener('submit',async e=>{
 e.preventDefault();if(!user){window.location.href='/auth/login/';return}
 const title=document.querySelector('#post-title').value.trim(),body=document.querySelector('#post-body').value.trim(),topic=document.querySelector('#post-topic').value
 submit.disabled=true;postStatus.textContent='Submitting for review…'
 const {error}=await supabase.from('community_posts').insert({member_id:user.id,title,body,topic,status:'pending'})
 submit.disabled=false
 if(error){console.error(error);postStatus.textContent='Could not submit your post. Please try again.';return}
 form.reset();postStatus.textContent='Submitted. Your post will appear after moderation.' 
})
feed.addEventListener('submit',async e=>{
 const f=e.target.closest('[data-comment-form]');if(!f)return;e.preventDefault()
 const input=f.querySelector('input'),button=f.querySelector('button'),body=input.value.trim()
 button.disabled=true
 const {error}=await supabase.from('community_comments').insert({post_id:f.dataset.commentForm,member_id:user.id,body,status:'pending'})
 button.disabled=false
 if(error){console.error(error);button.textContent='Try again';return}
 input.value='';button.textContent='Sent';f.nextElementSibling.textContent='Reply submitted for review.'
})
filter.addEventListener('change',render)
load()
