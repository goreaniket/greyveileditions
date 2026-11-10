create table if not exists public.connect_offerings (
  id uuid primary key default gen_random_uuid(),
  title text not null check (char_length(btrim(title)) between 3 and 120),
  offering_type text not null check (offering_type in ('programme','event','opportunity','workshop')),
  summary text not null check (char_length(btrim(summary)) between 20 and 1800),
  details text,
  delivery_mode text not null default 'online' check (delivery_mode in ('online','in_person','hybrid')),
  location_label text,
  starts_at timestamptz,
  ends_at timestamptz,
  capacity integer check (capacity is null or capacity > 0),
  status text not null default 'draft' check (status in ('draft','published','full','completed','cancelled')),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table if not exists public.connect_enrollments (
  id uuid primary key default gen_random_uuid(),
  offering_id uuid not null references public.connect_offerings(id) on delete cascade,
  member_id uuid not null references auth.users(id) on delete cascade,
  note text check (note is null or char_length(note) <= 800),
  status text not null default 'requested' check (status in ('requested','accepted','waitlisted','declined','withdrawn','attended')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (offering_id, member_id)
);
alter table public.connect_offerings enable row level security;
alter table public.connect_enrollments enable row level security;
grant select, insert, update, delete on public.connect_offerings to authenticated;
grant select, insert, update, delete on public.connect_enrollments to authenticated;
create index if not exists connect_offerings_status_date_idx on public.connect_offerings(status, starts_at);
create index if not exists connect_enrollments_offering_idx on public.connect_enrollments(offering_id, created_at desc);
create index if not exists connect_enrollments_member_idx on public.connect_enrollments(member_id, created_at desc);
drop policy if exists "Members view published offerings" on public.connect_offerings;
create policy "Members view published offerings" on public.connect_offerings for select to authenticated using (status = 'published' or (select public.greyveil_is_admin()));
drop policy if exists "Admins create offerings" on public.connect_offerings;
create policy "Admins create offerings" on public.connect_offerings for insert to authenticated with check ((select public.greyveil_is_admin()) and created_by = (select auth.uid()));
drop policy if exists "Admins update offerings" on public.connect_offerings;
create policy "Admins update offerings" on public.connect_offerings for update to authenticated using ((select public.greyveil_is_admin())) with check ((select public.greyveil_is_admin()));
drop policy if exists "Admins delete offerings" on public.connect_offerings;
create policy "Admins delete offerings" on public.connect_offerings for delete to authenticated using ((select public.greyveil_is_admin()));
drop policy if exists "Members view own enrollments and admins view all" on public.connect_enrollments;
create policy "Members view own enrollments and admins view all" on public.connect_enrollments for select to authenticated using (member_id = (select auth.uid()) or (select public.greyveil_is_admin()));
drop policy if exists "Members request enrollment in published offerings" on public.connect_enrollments;
create policy "Members request enrollment in published offerings" on public.connect_enrollments for insert to authenticated with check (member_id = (select auth.uid()) and status = 'requested' and exists (select 1 from public.connect_offerings o where o.id = offering_id and o.status = 'published'));
drop policy if exists "Members withdraw own enrollment and admins manage enrollments" on public.connect_enrollments;
create policy "Members withdraw own enrollment and admins manage enrollments" on public.connect_enrollments for update to authenticated using ((member_id = (select auth.uid()) and status in ('requested','accepted','waitlisted')) or (select public.greyveil_is_admin())) with check ((member_id = (select auth.uid()) and status = 'withdrawn') or (select public.greyveil_is_admin()));
