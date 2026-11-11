create table if not exists public.community_posts (
 id uuid primary key default gen_random_uuid(), member_id uuid not null references auth.users(id) on delete cascade,
 title text not null check(char_length(btrim(title)) between 5 and 120),
 body text not null check(char_length(btrim(body)) between 20 and 3000),
 topic text not null check(topic in ('belonging','everyday_life','learning','creativity','ideas','wins')),
 status text not null default 'pending' check(status in ('pending','published','rejected','hidden')),
 created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table if not exists public.community_comments (
 id uuid primary key default gen_random_uuid(), post_id uuid not null references public.community_posts(id) on delete cascade,
 member_id uuid not null references auth.users(id) on delete cascade,
 body text not null check(char_length(btrim(body)) between 2 and 1200),
 status text not null default 'pending' check(status in ('pending','published','rejected','hidden')),
 created_at timestamptz not null default now()
);
alter table public.community_posts enable row level security;
alter table public.community_comments enable row level security;
grant select,insert,update,delete on public.community_posts to authenticated;
grant select,insert,update,delete on public.community_comments to authenticated;
create index if not exists community_posts_feed_idx on public.community_posts(status,created_at desc);
create index if not exists community_comments_post_idx on public.community_comments(post_id,status,created_at);
drop policy if exists "Members read published posts and own submissions" on public.community_posts;
create policy "Members read published posts and own submissions" on public.community_posts for select to authenticated using(status='published' or member_id=(select auth.uid()) or (select public.greyveil_is_admin()));
drop policy if exists "Members submit posts for moderation" on public.community_posts;
create policy "Members submit posts for moderation" on public.community_posts for insert to authenticated with check(member_id=(select auth.uid()) and status='pending');
drop policy if exists "Admins moderate posts" on public.community_posts;
create policy "Admins moderate posts" on public.community_posts for update to authenticated using((select public.greyveil_is_admin())) with check((select public.greyveil_is_admin()));
drop policy if exists "Members delete own pending posts and admins delete any" on public.community_posts;
create policy "Members delete own pending posts and admins delete any" on public.community_posts for delete to authenticated using((member_id=(select auth.uid()) and status='pending') or (select public.greyveil_is_admin()));
drop policy if exists "Members read published comments and own submissions" on public.community_comments;
create policy "Members read published comments and own submissions" on public.community_comments for select to authenticated using(status='published' or member_id=(select auth.uid()) or (select public.greyveil_is_admin()));
drop policy if exists "Members comment on published posts" on public.community_comments;
create policy "Members comment on published posts" on public.community_comments for insert to authenticated with check(member_id=(select auth.uid()) and status='pending' and exists(select 1 from public.community_posts p where p.id=post_id and p.status='published'));
drop policy if exists "Admins moderate comments" on public.community_comments;
create policy "Admins moderate comments" on public.community_comments for update to authenticated using((select public.greyveil_is_admin())) with check((select public.greyveil_is_admin()));
drop policy if exists "Members delete own pending comments and admins delete any" on public.community_comments;
create policy "Members delete own pending comments and admins delete any" on public.community_comments for delete to authenticated using((member_id=(select auth.uid()) and status='pending') or (select public.greyveil_is_admin()));
