-- Greyveil Editions Admin Publishing & File Management - Step 1 only.
-- Apply this in Supabase SQL editor before using Admin file uploads.
-- This keeps book files private and allows browser uploads only for admin/super_admin users.

create extension if not exists pgcrypto;

create or replace function public.greyveil_current_role()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select role
  from public.profiles
  where id = auth.uid()
  limit 1
$$;

create or replace function public.greyveil_is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.greyveil_current_role() in ('admin', 'super_admin')
$$;

create or replace function public.greyveil_is_super_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.greyveil_current_role() = 'super_admin'
$$;

grant execute on function public.greyveil_current_role() to authenticated;
grant execute on function public.greyveil_is_admin() to authenticated;
grant execute on function public.greyveil_is_super_admin() to authenticated;

create table if not exists public.book_files (
  id uuid primary key default gen_random_uuid(),
  book_id bigint not null references public.books(id) on delete restrict,
  file_type text not null check (file_type in ('pdf', 'epub', 'docx', 'source')),
  storage_path text not null,
  file_name text not null,
  mime_type text,
  file_size bigint not null check (file_size >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (book_id, file_type)
);

create table if not exists public.book_covers (
  id uuid primary key default gen_random_uuid(),
  book_id bigint not null references public.books(id) on delete restrict,
  cover_type text not null check (cover_type in ('front_cover', 'print_cover', 'source_cover')),
  storage_path text not null,
  file_name text not null,
  mime_type text,
  file_size bigint not null check (file_size >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (book_id, cover_type)
);

create or replace function public.greyveil_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists touch_book_files_updated_at on public.book_files;
create trigger touch_book_files_updated_at
before update on public.book_files
for each row execute function public.greyveil_touch_updated_at();

drop trigger if exists touch_book_covers_updated_at on public.book_covers;
create trigger touch_book_covers_updated_at
before update on public.book_covers
for each row execute function public.greyveil_touch_updated_at();

alter table public.book_files enable row level security;
alter table public.book_covers enable row level security;

drop policy if exists "Admins can read book file metadata" on public.book_files;
create policy "Admins can read book file metadata"
on public.book_files
for select
to authenticated
using (public.greyveil_is_admin());

drop policy if exists "Admins can write allowed book file metadata" on public.book_files;
create policy "Admins can write allowed book file metadata"
on public.book_files
for insert
to authenticated
with check (
  public.greyveil_is_super_admin()
  or (public.greyveil_is_admin() and file_type = 'pdf')
);

drop policy if exists "Admins can update allowed book file metadata" on public.book_files;
create policy "Admins can update allowed book file metadata"
on public.book_files
for update
to authenticated
using (
  public.greyveil_is_super_admin()
  or (public.greyveil_is_admin() and file_type = 'pdf')
)
with check (
  public.greyveil_is_super_admin()
  or (public.greyveil_is_admin() and file_type = 'pdf')
);

drop policy if exists "Admins can delete allowed book file metadata" on public.book_files;
create policy "Admins can delete allowed book file metadata"
on public.book_files
for delete
to authenticated
using (
  public.greyveil_is_super_admin()
  or (public.greyveil_is_admin() and file_type = 'pdf')
);

drop policy if exists "Admins can read cover metadata" on public.book_covers;
create policy "Admins can read cover metadata"
on public.book_covers
for select
to authenticated
using (public.greyveil_is_admin());

drop policy if exists "Admins can insert cover metadata" on public.book_covers;
create policy "Admins can insert cover metadata"
on public.book_covers
for insert
to authenticated
with check (public.greyveil_is_admin());

drop policy if exists "Admins can update cover metadata" on public.book_covers;
create policy "Admins can update cover metadata"
on public.book_covers
for update
to authenticated
using (public.greyveil_is_admin())
with check (public.greyveil_is_admin());

drop policy if exists "Admins can delete cover metadata" on public.book_covers;
create policy "Admins can delete cover metadata"
on public.book_covers
for delete
to authenticated
using (public.greyveil_is_admin());

drop policy if exists "Admins can delete empty collections" on public.collections;
create policy "Admins can delete empty collections"
on public.collections
for delete
to authenticated
using (
  public.greyveil_is_admin()
  and not exists (
    select 1 from public.volumes
    where volumes.collection_id = collections.id
  )
  and not exists (
    select 1 from public.series
    where series.collection_id = collections.id
  )
  and not exists (
    select 1
    from public.books
    join public.series on series.id = books.series_id
    where series.collection_id = collections.id
  )
);

drop policy if exists "Admins can delete empty volumes" on public.volumes;
create policy "Admins can delete empty volumes"
on public.volumes
for delete
to authenticated
using (
  public.greyveil_is_admin()
  and not exists (
    select 1 from public.series
    where series.volume_id = volumes.id
  )
  and not exists (
    select 1
    from public.books
    join public.series on series.id = books.series_id
    where series.volume_id = volumes.id
  )
);

drop policy if exists "Admins can delete empty series" on public.series;
create policy "Admins can delete empty series"
on public.series
for delete
to authenticated
using (
  public.greyveil_is_admin()
  and not exists (
    select 1 from public.books
    where books.series_id = series.id
  )
);

drop policy if exists "Admins can delete books" on public.books;
create policy "Admins can delete books"
on public.books
for delete
to authenticated
using (public.greyveil_is_admin());

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'book-covers',
  'book-covers',
  false,
  12582912,
  array['image/png', 'image/jpeg', 'image/webp']::text[]
)
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'book-files',
  'book-files',
  false,
  125829120,
  array[
    'application/pdf',
    'application/epub+zip',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/zip',
    'application/octet-stream'
  ]::text[]
)
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Admins can read cover objects" on storage.objects;
create policy "Admins can read cover objects"
on storage.objects
for select
to authenticated
using (bucket_id = 'book-covers' and public.greyveil_is_admin());

drop policy if exists "Admins can insert cover objects" on storage.objects;
create policy "Admins can insert cover objects"
on storage.objects
for insert
to authenticated
with check (bucket_id = 'book-covers' and public.greyveil_is_admin());

drop policy if exists "Admins can update cover objects" on storage.objects;
create policy "Admins can update cover objects"
on storage.objects
for update
to authenticated
using (bucket_id = 'book-covers' and public.greyveil_is_admin())
with check (bucket_id = 'book-covers' and public.greyveil_is_admin());

drop policy if exists "Admins can delete cover objects" on storage.objects;
create policy "Admins can delete cover objects"
on storage.objects
for delete
to authenticated
using (bucket_id = 'book-covers' and public.greyveil_is_admin());

drop policy if exists "Admins can read allowed book file objects" on storage.objects;
create policy "Admins can read allowed book file objects"
on storage.objects
for select
to authenticated
using (
  bucket_id = 'book-files'
  and (
    public.greyveil_is_super_admin()
    or (public.greyveil_is_admin() and storage.filename(name) = 'book.pdf')
  )
);

drop policy if exists "Admins can insert allowed book file objects" on storage.objects;
create policy "Admins can insert allowed book file objects"
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'book-files'
  and (
    public.greyveil_is_super_admin()
    or (public.greyveil_is_admin() and storage.filename(name) = 'book.pdf')
  )
);

drop policy if exists "Admins can update allowed book file objects" on storage.objects;
create policy "Admins can update allowed book file objects"
on storage.objects
for update
to authenticated
using (
  bucket_id = 'book-files'
  and (
    public.greyveil_is_super_admin()
    or (public.greyveil_is_admin() and storage.filename(name) = 'book.pdf')
  )
)
with check (
  bucket_id = 'book-files'
  and (
    public.greyveil_is_super_admin()
    or (public.greyveil_is_admin() and storage.filename(name) = 'book.pdf')
  )
);

drop policy if exists "Admins can delete allowed book file objects" on storage.objects;
create policy "Admins can delete allowed book file objects"
on storage.objects
for delete
to authenticated
using (
  bucket_id = 'book-files'
  and (
    public.greyveil_is_super_admin()
    or (public.greyveil_is_admin() and storage.filename(name) = 'book.pdf')
  )
);
