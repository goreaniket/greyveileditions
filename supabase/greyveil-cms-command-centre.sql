-- Greyveil Editions CMS / Admin Command Centre foundation
-- Additive only; does not modify existing books, Reader Match, payments, orders, profiles or access data.
-- This SQL has been applied to the connected Supabase project and verified.
create table if not exists public.cms_pages (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  slug text not null unique,
  excerpt text not null default '',
  body text not null default '',
  status text not null default 'draft' check (status in ('draft','published','archived')),
  is_homepage boolean not null default false,
  seo_title text not null default '',
  seo_description text not null default '',
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  updated_by uuid references auth.users(id) on delete set null default auth.uid(),
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists cms_pages_one_homepage_idx on public.cms_pages (is_homepage) where is_homepage = true;
create index if not exists cms_pages_status_updated_idx on public.cms_pages (status, updated_at desc);
create table if not exists public.cms_sections (
  id uuid primary key default gen_random_uuid(),
  page_id uuid not null references public.cms_pages(id) on delete cascade,
  title text not null default '',
  eyebrow text not null default '',
  body text not null default '',
  button_label text not null default '',
  button_url text not null default '',
  image_path text not null default '',
  sort_order integer not null default 0,
  is_published boolean not null default false,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  updated_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists cms_sections_page_order_idx on public.cms_sections (page_id, sort_order, created_at);
create table if not exists public.cms_media (
  id uuid primary key default gen_random_uuid(),
  storage_path text not null unique,
  file_name text not null,
  mime_type text not null,
  file_size bigint not null default 0 check (file_size >= 0),
  alt_text text not null default '',
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now()
);
create index if not exists cms_media_created_idx on public.cms_media (created_at desc);
create table if not exists public.cms_revisions (
  id uuid primary key default gen_random_uuid(),
  page_id uuid references public.cms_pages(id) on delete set null,
  section_id uuid references public.cms_sections(id) on delete set null,
  entity_type text not null check (entity_type in ('page','section')),
  entity_id uuid not null,
  snapshot jsonb not null,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now()
);
create index if not exists cms_revisions_entity_idx on public.cms_revisions (entity_type, entity_id, created_at desc);
create table if not exists public.cms_audit_logs (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid references auth.users(id) on delete set null default auth.uid(),
  action text not null,
  entity_type text not null,
  entity_id uuid,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists cms_audit_logs_created_idx on public.cms_audit_logs (created_at desc);
alter table public.cms_pages enable row level security;
alter table public.cms_sections enable row level security;
alter table public.cms_media enable row level security;
alter table public.cms_revisions enable row level security;
alter table public.cms_audit_logs enable row level security;
drop policy if exists cms_pages_public_read on public.cms_pages;
drop policy if exists cms_pages_admin_all on public.cms_pages;
drop policy if exists cms_pages_authenticated_read on public.cms_pages;
drop policy if exists cms_pages_admin_insert on public.cms_pages;
drop policy if exists cms_pages_admin_update on public.cms_pages;
drop policy if exists cms_pages_admin_delete on public.cms_pages;
create policy cms_pages_public_read on public.cms_pages for select to anon using (status = 'published');
create policy cms_pages_authenticated_read on public.cms_pages for select to authenticated using (status = 'published' or (select public.greyveil_is_admin()));
create policy cms_pages_admin_insert on public.cms_pages for insert to authenticated with check ((select public.greyveil_is_admin()));
create policy cms_pages_admin_update on public.cms_pages for update to authenticated using ((select public.greyveil_is_admin())) with check ((select public.greyveil_is_admin()));
create policy cms_pages_admin_delete on public.cms_pages for delete to authenticated using ((select public.greyveil_is_admin()));

drop policy if exists cms_sections_public_read on public.cms_sections;
drop policy if exists cms_sections_admin_all on public.cms_sections;
drop policy if exists cms_sections_authenticated_read on public.cms_sections;
drop policy if exists cms_sections_admin_insert on public.cms_sections;
drop policy if exists cms_sections_admin_update on public.cms_sections;
drop policy if exists cms_sections_admin_delete on public.cms_sections;
create policy cms_sections_public_read on public.cms_sections for select to anon using (
  is_published = true and exists (select 1 from public.cms_pages p where p.id = cms_sections.page_id and p.status = 'published')
);
create policy cms_sections_authenticated_read on public.cms_sections for select to authenticated using (
  (is_published = true and exists (select 1 from public.cms_pages p where p.id = cms_sections.page_id and p.status = 'published'))
  or (select public.greyveil_is_admin())
);
create policy cms_sections_admin_insert on public.cms_sections for insert to authenticated with check ((select public.greyveil_is_admin()));
create policy cms_sections_admin_update on public.cms_sections for update to authenticated using ((select public.greyveil_is_admin())) with check ((select public.greyveil_is_admin()));
create policy cms_sections_admin_delete on public.cms_sections for delete to authenticated using ((select public.greyveil_is_admin()));

create index if not exists cms_pages_created_by_idx on public.cms_pages (created_by);
create index if not exists cms_pages_updated_by_idx on public.cms_pages (updated_by);
create index if not exists cms_sections_created_by_idx on public.cms_sections (created_by);
create index if not exists cms_sections_updated_by_idx on public.cms_sections (updated_by);
create index if not exists cms_media_created_by_idx on public.cms_media (created_by);
create index if not exists cms_revisions_page_id_idx on public.cms_revisions (page_id);
create index if not exists cms_revisions_section_id_idx on public.cms_revisions (section_id);
create index if not exists cms_revisions_created_by_idx on public.cms_revisions (created_by);
create index if not exists cms_audit_logs_actor_id_idx on public.cms_audit_logs (actor_id);

grant select on public.cms_pages, public.cms_sections to anon, authenticated;
grant insert, update, delete on public.cms_pages, public.cms_sections to authenticated;
grant select, insert, update, delete on public.cms_media, public.cms_revisions, public.cms_audit_logs to authenticated;
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('cms-media', 'cms-media', true, 26214400, array['image/jpeg','image/png','image/webp','image/gif'])
on conflict (id) do update set public = excluded.public, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;
drop policy if exists cms_media_storage_admin_select on storage.objects;
create policy cms_media_storage_admin_select on storage.objects for select to authenticated using (bucket_id = 'cms-media' and (select public.greyveil_is_admin()));
drop policy if exists cms_media_storage_admin_insert on storage.objects;
create policy cms_media_storage_admin_insert on storage.objects for insert to authenticated with check (bucket_id = 'cms-media' and (select public.greyveil_is_admin()));
drop policy if exists cms_media_storage_admin_update on storage.objects;
create policy cms_media_storage_admin_update on storage.objects for update to authenticated using (bucket_id = 'cms-media' and (select public.greyveil_is_admin())) with check (bucket_id = 'cms-media' and (select public.greyveil_is_admin()));
drop policy if exists cms_media_storage_admin_delete on storage.objects;
create policy cms_media_storage_admin_delete on storage.objects for delete to authenticated using (bucket_id = 'cms-media' and (select public.greyveil_is_admin()));
insert into public.cms_pages (title, slug, status, is_homepage, seo_title, seo_description)
values ('Homepage', 'home', 'published', true, 'Greyveil Editions — Beyond the surface', 'Thought, literature and the human experience.')
on conflict (slug) do nothing;
