-- Greyveil production repair for the 1-Day Pass backend.
-- Apply after the existing commerce, payment, hierarchy, and private-reader
-- migrations. It does not update catalog data, orders, payments, grants, or
-- prices. The only replaced enforcement is the existing order target checks
-- (to add `pass`) and the private Reader authorization function (to add a
-- pass-activation branch while retaining every existing access source).

begin;

create extension if not exists pgcrypto;

-- Safe whether the Founder-created table already exists or not. These additive
-- columns support a partial/manual table without recreating or deleting rows.
create table if not exists public.temporary_access_passes (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug = lower(btrim(slug)) and slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  title text not null,
  active boolean not null default true,
  price_amount integer not null check (price_amount > 0),
  duration_hours integer not null default 24 check (duration_hours > 0 and duration_hours <= 720),
  scope_type text not null default 'collection' check (scope_type in ('collection', 'library')),
  collection_id uuid references public.collections(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((scope_type = 'collection' and collection_id is not null) or (scope_type = 'library' and collection_id is null))
);
alter table public.temporary_access_passes add column if not exists active boolean default true;
alter table public.temporary_access_passes add column if not exists price_amount integer;
alter table public.temporary_access_passes add column if not exists duration_hours integer default 24;
alter table public.temporary_access_passes add column if not exists scope_type text default 'collection';
alter table public.temporary_access_passes add column if not exists collection_id uuid references public.collections(id) on delete restrict;
alter table public.temporary_access_passes add column if not exists created_at timestamptz default now();
alter table public.temporary_access_passes add column if not exists updated_at timestamptz default now();

create table if not exists public.temporary_access_pass_activations (
  id uuid primary key default gen_random_uuid(),
  pass_id uuid not null references public.temporary_access_passes(id) on delete restrict,
  user_id uuid not null references auth.users(id) on delete cascade,
  order_id uuid not null unique references public.orders(id) on delete restrict,
  activated_at timestamptz not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  check (expires_at > activated_at)
);
create index if not exists temporary_access_pass_activations_user_expiry_idx
  on public.temporary_access_pass_activations (user_id, expires_at desc);

alter table public.orders
  add column if not exists temporary_access_pass_id uuid references public.temporary_access_passes(id) on delete restrict;

-- These are the purchase-type/target checks, so extending them is required for
-- pass orders. The recreated check preserves the complete Book/Series/
-- Collection rules and adds exactly one Pass case. `not valid` preserves all
-- historical rows without a data rewrite while enforcing new writes.
do $$
declare constraint_name text; constraint_definition text;
begin
  for constraint_name, constraint_definition in
    select conname, pg_get_constraintdef(oid)
    from pg_constraint
    where conrelid = 'public.orders'::regclass
      and conname in ('orders_purchase_type_valid', 'orders_purchase_target_matches_type', 'orders_purchase_target_check')
  loop
    if constraint_definition not ilike '%pass%' then
      execute format('alter table public.orders drop constraint %I', constraint_name);
    end if;
  end loop;

  if not exists (
    select 1 from pg_constraint where conrelid = 'public.orders'::regclass and conname = 'orders_purchase_type_valid'
  ) then
    alter table public.orders add constraint orders_purchase_type_valid
      check (purchase_type is null or purchase_type in ('book', 'series', 'collection', 'pass')) not valid;
  end if;

  if not exists (
    select 1 from pg_constraint where conrelid = 'public.orders'::regclass and conname = 'orders_purchase_target_check'
  ) then
    alter table public.orders add constraint orders_purchase_target_check check (
      (purchase_type is null and num_nonnulls(book_id, series_id, collection_id, temporary_access_pass_id) <= 1)
      or (purchase_type = 'book' and book_id is not null and series_id is null and collection_id is null and temporary_access_pass_id is null)
      or (purchase_type = 'series' and book_id is null and series_id is not null and collection_id is null and temporary_access_pass_id is null)
      or (purchase_type = 'collection' and book_id is null and series_id is null and collection_id is not null and temporary_access_pass_id is null)
      or (purchase_type = 'pass' and book_id is null and series_id is null and collection_id is null and temporary_access_pass_id is not null)
    ) not valid;
  end if;
end;
$$;

create or replace function public.greyveil_touch_temporary_pass_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;
drop trigger if exists touch_temporary_access_passes_updated_at on public.temporary_access_passes;
create trigger touch_temporary_access_passes_updated_at
before update on public.temporary_access_passes
for each row execute function public.greyveil_touch_temporary_pass_updated_at();

-- Only a verified payment path can set an order paid; this trigger then creates
-- one immutable activation per paid pass order and computes expiry server-side.
create or replace function public.greyveil_activate_paid_temporary_pass()
returns trigger language plpgsql security definer set search_path = public as $$
declare pass_row public.temporary_access_passes%rowtype; activation_time timestamptz;
begin
  if new.status is distinct from 'paid' or new.purchase_type is distinct from 'pass'
     or new.temporary_access_pass_id is null or new.user_id is null then
    return new;
  end if;
  select * into pass_row from public.temporary_access_passes where id = new.temporary_access_pass_id;
  if not found then raise exception 'Temporary pass configuration is missing.'; end if;
  activation_time := coalesce(new.paid_at, now());
  insert into public.temporary_access_pass_activations (pass_id, user_id, order_id, activated_at, expires_at)
  values (pass_row.id, new.user_id, new.id, activation_time, activation_time + make_interval(hours => pass_row.duration_hours))
  on conflict (order_id) do nothing;
  return new;
end;
$$;
drop trigger if exists greyveil_activate_paid_temporary_pass on public.orders;
create trigger greyveil_activate_paid_temporary_pass
after insert or update of status, temporary_access_pass_id on public.orders
for each row execute function public.greyveil_activate_paid_temporary_pass();

-- The deployed private Reader gate retains public/admin/private/manual/direct
-- Book/Series/Collection behavior. The last OR branch is the sole new pass
-- entitlement, evaluated with database time and current hierarchy membership.
create or replace function public.greyveil_reader_content_authorization(
  target_user_id uuid, target_book_slug text
)
returns table (book_id bigint, book_slug text, book_title text, effective_visibility text, allowed boolean, reason text)
language plpgsql stable security definer set search_path = public as $$
declare hierarchy record; viewer_role text; viewer_has_access boolean := false;
begin
  select book.id as resolved_book_id, book.slug as resolved_book_slug, book.title as resolved_book_title,
    series_item.id as resolved_series_id, coalesce(series_item.collection_id, volume.collection_id) as resolved_collection_id,
    coalesce(book.is_active, true) and coalesce(series_item.is_active, true) and coalesce(volume.is_active, true) and coalesce(collection_item.is_active, true) as hierarchy_active,
    case when lower(coalesce(book.visibility, '')) = 'private' then 'private'
         when coalesce(book.is_public, false) or lower(coalesce(book.visibility, '')) = 'public' then 'public'
         when lower(coalesce(series_item.visibility, 'public')) = 'private' or lower(coalesce(volume.visibility, 'public')) = 'private' or lower(coalesce(collection_item.visibility, 'public')) = 'private' then 'private'
         else 'paid' end as resolved_visibility
  into hierarchy
  from public.books book
  join public.series series_item on series_item.id = book.series_id
  join public.volumes volume on volume.id = series_item.volume_id
  join public.collections collection_item on collection_item.id = coalesce(series_item.collection_id, volume.collection_id)
  where book.slug = lower(btrim(target_book_slug)) limit 1;
  if not found then return; end if;
  book_id := hierarchy.resolved_book_id; book_slug := hierarchy.resolved_book_slug; book_title := hierarchy.resolved_book_title; effective_visibility := hierarchy.resolved_visibility;
  if not hierarchy.hierarchy_active then allowed := false; reason := 'unavailable'; return next; return; end if;
  if target_user_id is not null then select profile.role into viewer_role from public.profiles profile where profile.id = target_user_id limit 1; end if;
  if viewer_role in ('admin', 'super_admin') then allowed := true; reason := 'admin'; return next; return; end if;
  if effective_visibility = 'public' then allowed := true; reason := 'public'; return next; return; end if;
  if effective_visibility = 'private' then allowed := false; reason := 'unavailable'; return next; return; end if;
  if target_user_id is null then allowed := false; reason := 'login_required'; return next; return; end if;
  select exists (
    select 1 from public.book_access access
    where access.user_id = target_user_id and access.book_id = hierarchy.resolved_book_id
      and access.is_visible = true and access.can_read = true and (access.expires_at is null or access.expires_at > now())
  ) or exists (
    select 1 from public.orders paid_order
    where paid_order.user_id = target_user_id and paid_order.status = 'paid'
      and ((paid_order.purchase_type = 'book' and paid_order.book_id = hierarchy.resolved_book_id)
        or (paid_order.purchase_type = 'series' and paid_order.series_id = hierarchy.resolved_series_id)
        or (paid_order.purchase_type = 'collection' and paid_order.collection_id = hierarchy.resolved_collection_id))
  ) or exists (
    select 1 from public.temporary_access_pass_activations activation
    join public.temporary_access_passes pass_row on pass_row.id = activation.pass_id
    where activation.user_id = target_user_id and activation.expires_at > now()
      and (pass_row.scope_type = 'library' or (pass_row.scope_type = 'collection' and pass_row.collection_id = hierarchy.resolved_collection_id))
  ) into viewer_has_access;
  allowed := viewer_has_access; reason := case when viewer_has_access then 'entitled' else 'access_required' end;
  return next;
end;
$$;

alter table public.temporary_access_passes enable row level security;
alter table public.temporary_access_pass_activations enable row level security;
drop policy if exists "Public reads active temporary passes" on public.temporary_access_passes;
create policy "Public reads active temporary passes" on public.temporary_access_passes
for select to anon, authenticated using (active or public.greyveil_is_admin());
drop policy if exists "Admins manage temporary passes" on public.temporary_access_passes;
create policy "Admins manage temporary passes" on public.temporary_access_passes
for all to authenticated using (public.greyveil_is_admin()) with check (public.greyveil_is_admin());
drop policy if exists "Users and admins read pass activations" on public.temporary_access_pass_activations;
create policy "Users and admins read pass activations" on public.temporary_access_pass_activations
for select to authenticated using (user_id = auth.uid() or public.greyveil_is_admin());

grant select on public.temporary_access_passes to anon, authenticated;
grant insert, update, delete on public.temporary_access_passes to authenticated;
grant select on public.temporary_access_pass_activations to authenticated;
revoke insert, update, delete on public.temporary_access_pass_activations from anon, authenticated;
revoke all on function public.greyveil_touch_temporary_pass_updated_at() from public;
revoke all on function public.greyveil_touch_temporary_pass_updated_at() from anon, authenticated;
revoke all on function public.greyveil_activate_paid_temporary_pass() from public;
revoke all on function public.greyveil_activate_paid_temporary_pass() from anon, authenticated;
revoke all on function public.greyveil_reader_content_authorization(uuid, text) from public;
revoke all on function public.greyveil_reader_content_authorization(uuid, text) from anon;
revoke all on function public.greyveil_reader_content_authorization(uuid, text) from authenticated;
grant execute on function public.greyveil_reader_content_authorization(uuid, text) to service_role;

commit;
notify pgrst, 'reload schema';

-- Read-only verification after commit:
-- select to_regclass('public.temporary_access_passes'), to_regclass('public.temporary_access_pass_activations');
-- select column_name, data_type from information_schema.columns where table_schema = 'public' and table_name in ('temporary_access_passes', 'temporary_access_pass_activations') order by table_name, ordinal_position;
-- select relname, relrowsecurity from pg_class where oid in ('public.temporary_access_passes'::regclass, 'public.temporary_access_pass_activations'::regclass);
-- select tablename, policyname, roles, cmd from pg_policies where schemaname = 'public' and tablename like 'temporary_access_pass%' order by tablename, policyname;
-- select proname from pg_proc join pg_namespace on pg_namespace.oid = pg_proc.pronamespace where nspname = 'public' and proname in ('greyveil_activate_paid_temporary_pass', 'greyveil_reader_content_authorization');
