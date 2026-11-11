-- Greyveil Connect: private member requests with admin-managed follow-up.
-- The live database change is applied separately; keep this migration in version control.

create table if not exists public.community_requests (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references auth.users(id) on delete cascade,
  request_type text not null check (request_type in ('belonging','wellbeing','growth','practical_help','volunteer','partnership')),
  summary text not null check (char_length(btrim(summary)) between 10 and 1200),
  status text not null default 'received' check (status in ('received','reviewing','referred','resolved','closed')),
  consent_to_review boolean not null default false check (consent_to_review = true),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.community_requests enable row level security;

grant select, insert, update, delete on public.community_requests to authenticated;

create index if not exists community_requests_member_created_idx
  on public.community_requests (member_id, created_at desc);
create index if not exists community_requests_status_created_idx
  on public.community_requests (status, created_at desc);

drop policy if exists "Members create their own community requests" on public.community_requests;
create policy "Members create their own community requests"
  on public.community_requests for insert to authenticated
  with check (
    (select auth.uid()) = member_id
    and status = 'received'
    and consent_to_review = true
  );

drop policy if exists "Members and admins read community requests" on public.community_requests;
create policy "Members and admins read community requests"
  on public.community_requests for select to authenticated
  using (
    (select auth.uid()) = member_id
    or (select public.greyveil_is_admin())
  );

drop policy if exists "Admins update community requests" on public.community_requests;
create policy "Admins update community requests"
  on public.community_requests for update to authenticated
  using ((select public.greyveil_is_admin()))
  with check ((select public.greyveil_is_admin()));

drop policy if exists "Members delete unreviewed community requests" on public.community_requests;
create policy "Members delete unreviewed community requests"
  on public.community_requests for delete to authenticated
  using (
    ((select auth.uid()) = member_id and status = 'received')
    or (select public.greyveil_is_admin())
  );
