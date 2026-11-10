create table if not exists public.contributor_applications (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references auth.users(id) on delete cascade,
  contribution_areas text[] not null check (cardinality(contribution_areas) between 1 and 5),
  skills text not null check (char_length(btrim(skills)) between 2 and 1000),
  availability text not null check (availability in ('occasional','weekly','monthly','project_based')),
  motivation text not null check (char_length(btrim(motivation)) between 20 and 1600),
  consent_to_contact boolean not null default false check (consent_to_contact = true),
  status text not null default 'submitted' check (status in ('submitted','reviewing','conversation','accepted','waitlisted','declined','withdrawn')),
  admin_note text check (admin_note is null or char_length(admin_note) <= 1200),
  reviewed_by uuid references auth.users(id) on delete set null,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.contributor_applications enable row level security;
grant select, insert, update on public.contributor_applications to authenticated;
create index if not exists contributor_applications_status_created_idx on public.contributor_applications(status, created_at desc);
create index if not exists contributor_applications_member_created_idx on public.contributor_applications(member_id, created_at desc);
drop policy if exists "Members view own contributor applications and admins view all" on public.contributor_applications;
create policy "Members view own contributor applications and admins view all"
on public.contributor_applications for select to authenticated
using (member_id = (select auth.uid()) or (select public.greyveil_is_admin()));
drop policy if exists "Members submit contributor applications" on public.contributor_applications;
create policy "Members submit contributor applications"
on public.contributor_applications for insert to authenticated
with check (member_id = (select auth.uid()) and status = 'submitted' and admin_note is null and reviewed_by is null and reviewed_at is null and consent_to_contact = true);
drop policy if exists "Members withdraw own submitted applications and admins review" on public.contributor_applications;
create policy "Members withdraw own submitted applications and admins review"
on public.contributor_applications for update to authenticated
using ((member_id = (select auth.uid()) and status in ('submitted','reviewing')) or (select public.greyveil_is_admin()))
with check ((member_id = (select auth.uid()) and status = 'withdrawn' and admin_note is null and reviewed_by is null and reviewed_at is null) or (select public.greyveil_is_admin()));
