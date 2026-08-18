-- Greyveil hierarchical commerce and temporary-pass access.
-- Apply after platform-architecture-upgrade.sql. This is additive and retains
-- existing orders and book_access rows as valid historical evidence.

begin;

alter table public.books add column if not exists price_amount integer;
alter table public.series add column if not exists price_amount integer;
alter table public.collections add column if not exists price_amount integer;

alter table public.books drop constraint if exists books_price_amount_positive;
alter table public.series drop constraint if exists series_price_amount_positive;
alter table public.collections drop constraint if exists collections_price_amount_positive;
alter table public.books add constraint books_price_amount_positive check (price_amount is null or price_amount > 0) not valid;
alter table public.series add constraint series_price_amount_positive check (price_amount is null or price_amount > 0) not valid;
alter table public.collections add constraint collections_price_amount_positive check (price_amount is null or price_amount > 0) not valid;

-- Preserve current published prices as one-time defaults. Future checkout reads
-- these catalog columns, never literals or a client-supplied amount.
update public.books set price_amount = 14900 where price_amount is null;
update public.series
set price_amount = case lower(slug)
  when 'human-fiction' then 49900
  when 'human-mind' then 59900
  when 'human-paradox' then 59900
  else price_amount
end
where price_amount is null;
update public.collections
set price_amount = 129900
where price_amount is null
  and lower(slug) in ('human-paradox-collection', 'the-human-paradox-collection');

create table if not exists public.catalog_access_grants (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  target_type text not null check (target_type in ('book', 'series', 'collection')),
  book_id bigint references public.books(id) on delete restrict,
  series_id uuid references public.series(id) on delete restrict,
  collection_id uuid references public.collections(id) on delete restrict,
  access_type text not null default 'manual' check (access_type = 'manual'),
  granted_by uuid references auth.users(id) on delete set null,
  granted_at timestamptz not null default now(),
  expires_at timestamptz,
  is_visible boolean not null default true,
  can_read boolean not null default true,
  check (
    (target_type = 'book' and book_id is not null and series_id is null and collection_id is null)
    or (target_type = 'series' and book_id is null and series_id is not null and collection_id is null)
    or (target_type = 'collection' and book_id is null and series_id is null and collection_id is not null)
  )
);
create index if not exists catalog_access_grants_user_active_idx
  on public.catalog_access_grants (user_id, target_type, expires_at)
  where is_visible and can_read;

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

alter table public.orders add column if not exists temporary_access_pass_id uuid references public.temporary_access_passes(id) on delete restrict;

-- Replace only target-shape constraints, retaining all historical orders.
alter table public.orders drop constraint if exists orders_purchase_type_valid;
alter table public.orders drop constraint if exists orders_purchase_target_matches_type;
alter table public.orders drop constraint if exists orders_purchase_target_check;
alter table public.orders add constraint orders_purchase_target_check check (
  (purchase_type is null and num_nonnulls(book_id, series_id, collection_id, temporary_access_pass_id) <= 1)
  or (purchase_type = 'book' and book_id is not null and series_id is null and collection_id is null and temporary_access_pass_id is null)
  or (purchase_type = 'series' and book_id is null and series_id is not null and collection_id is null and temporary_access_pass_id is null)
  or (purchase_type = 'collection' and book_id is null and series_id is null and collection_id is not null and temporary_access_pass_id is null)
  or (purchase_type = 'pass' and book_id is null and series_id is null and collection_id is null and temporary_access_pass_id is not null)
) not valid;

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

-- Parent orders are intentionally not expanded into book_access. The existing
-- paid-order trigger is retained for direct book purchases only; series and
-- collection ownership is resolved against the live hierarchy below.
create or replace function public.greyveil_grant_paid_order_access()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.purchase_type <> 'book' or new.user_id is null or new.status <> 'paid' or new.book_id is null then
    return new;
  end if;
  perform pg_advisory_xact_lock(hashtextextended(new.user_id::text, 0));
  update public.book_access access_row
  set access_type = 'purchase', granted_by = new.user_id, granted_at = coalesce(new.paid_at, now()),
      expires_at = null, is_visible = true, can_read = true
  where access_row.user_id = new.user_id and access_row.book_id = new.book_id;
  if not found then
    insert into public.book_access (user_id, book_id, granted_by, access_type, granted_at, expires_at, is_visible, can_read)
    values (new.user_id, new.book_id, new.user_id, 'purchase', coalesce(new.paid_at, now()), null, true, true);
  end if;
  return new;
end;
$$;

create or replace function public.greyveil_activate_paid_temporary_pass()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  pass_row public.temporary_access_passes%rowtype;
  activation_time timestamptz;
begin
  if new.status <> 'paid' or new.purchase_type <> 'pass'
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

-- This is the authoritative protected-content decision. Parent ownership is
-- evaluated against current membership, so future catalog additions need no
-- individual child entitlement rows.
create or replace function public.greyveil_resolve_book_access(target_user_id uuid, target_book_id bigint)
returns table (allowed boolean, access_state text)
language plpgsql stable security definer set search_path = public as $$
declare
  hierarchy record;
  viewer_role text;
begin
  select book.id as book_id, book.series_id,
    coalesce(series_item.collection_id, volume.collection_id) as collection_id,
    coalesce(book.is_active, true) as book_active,
    coalesce(series_item.is_active, true) as series_active,
    coalesce(volume.is_active, true) as volume_active,
    coalesce(collection_item.is_active, true) as collection_active,
    case when lower(coalesce(book.visibility, '')) = 'private' then 'private'
         when coalesce(book.is_public, false) or lower(coalesce(book.visibility, '')) = 'public' then 'public'
         when lower(coalesce(series_item.visibility, 'public')) = 'private'
           or lower(coalesce(volume.visibility, 'public')) = 'private'
           or lower(coalesce(collection_item.visibility, 'public')) = 'private' then 'private'
         else 'paid' end as visibility
  into hierarchy
  from public.books book
  left join public.series series_item on series_item.id = book.series_id
  left join public.volumes volume on volume.id = series_item.volume_id
  left join public.collections collection_item on collection_item.id = coalesce(series_item.collection_id, volume.collection_id)
  where book.id = target_book_id;

  if not found or not hierarchy.book_active or not hierarchy.series_active or not hierarchy.volume_active or not hierarchy.collection_active then
    allowed := false; access_state := 'NO_ACCESS'; return next; return;
  end if;
  if target_user_id is not null then select role into viewer_role from public.profiles where id = target_user_id; end if;
  if viewer_role in ('admin', 'super_admin') then allowed := true; access_state := 'ADMIN_ACCESS'; return next; return; end if;
  if hierarchy.visibility = 'public' then allowed := true; access_state := 'PUBLIC'; return next; return; end if;
  if hierarchy.visibility = 'private' or target_user_id is null then allowed := false; access_state := 'NO_ACCESS'; return next; return; end if;

  if exists (select 1 from public.orders order_row where order_row.user_id = target_user_id and order_row.status = 'paid' and coalesce(lower(order_row.purchase_type), case when order_row.book_id is not null then 'book' when order_row.series_id is not null then 'series' when order_row.collection_id is not null then 'collection' end) = 'book' and order_row.book_id = hierarchy.book_id) then
    allowed := true; access_state := 'DIRECTLY_OWNED'; return next; return;
  end if;
  if exists (select 1 from public.orders order_row where order_row.user_id = target_user_id and order_row.status = 'paid' and coalesce(lower(order_row.purchase_type), case when order_row.book_id is not null then 'book' when order_row.series_id is not null then 'series' when order_row.collection_id is not null then 'collection' end) = 'series' and order_row.series_id = hierarchy.series_id) then
    allowed := true; access_state := 'SERIES_OWNED'; return next; return;
  end if;
  if hierarchy.collection_id is not null and exists (select 1 from public.orders order_row where order_row.user_id = target_user_id and order_row.status = 'paid' and coalesce(lower(order_row.purchase_type), case when order_row.book_id is not null then 'book' when order_row.series_id is not null then 'series' when order_row.collection_id is not null then 'collection' end) = 'collection' and order_row.collection_id = hierarchy.collection_id) then
    allowed := true; access_state := 'COLLECTION_OWNED'; return next; return;
  end if;
  if exists (select 1 from public.book_access access_row where access_row.user_id = target_user_id and access_row.book_id = hierarchy.book_id and access_row.is_visible and access_row.can_read and (access_row.expires_at is null or access_row.expires_at > now())) then
    allowed := true; access_state := 'MANUAL_GRANT'; return next; return;
  end if;
  if exists (select 1 from public.catalog_access_grants grant_row where grant_row.user_id = target_user_id and grant_row.is_visible and grant_row.can_read and (grant_row.expires_at is null or grant_row.expires_at > now()) and ((grant_row.target_type = 'book' and grant_row.book_id = hierarchy.book_id) or (grant_row.target_type = 'series' and grant_row.series_id = hierarchy.series_id) or (grant_row.target_type = 'collection' and grant_row.collection_id = hierarchy.collection_id))) then
    allowed := true; access_state := 'MANUAL_GRANT'; return next; return;
  end if;
  if exists (select 1 from public.temporary_access_pass_activations activation join public.temporary_access_passes pass_row on pass_row.id = activation.pass_id where activation.user_id = target_user_id and activation.expires_at > now() and (pass_row.scope_type = 'library' or (pass_row.scope_type = 'collection' and pass_row.collection_id = hierarchy.collection_id))) then
    allowed := true; access_state := 'TEMPORARY_PASS'; return next; return;
  end if;
  allowed := false; access_state := 'NO_ACCESS'; return next;
end;
$$;

create or replace function public.greyveil_effective_book_access(target_user_id uuid, target_book_id bigint)
returns boolean language sql stable security definer set search_path = public as $$
  select decision.allowed from public.greyveil_resolve_book_access(target_user_id, target_book_id) decision limit 1;
$$;

create or replace function public.greyveil_reader_content_authorization(target_user_id uuid, target_book_slug text)
returns table (book_id bigint, book_slug text, book_title text, effective_visibility text, allowed boolean, reason text)
language plpgsql stable security definer set search_path = public as $$
declare target record; decision record;
begin
  select book.id, book.slug, book.title,
    case when lower(coalesce(book.visibility, '')) = 'private' then 'private'
         when coalesce(book.is_public, false) or lower(coalesce(book.visibility, '')) = 'public' then 'public'
         when lower(coalesce(series_item.visibility, 'public')) = 'private' or lower(coalesce(volume.visibility, 'public')) = 'private' or lower(coalesce(collection_item.visibility, 'public')) = 'private' then 'private'
         else 'paid' end as visibility
  into target
  from public.books book
  left join public.series series_item on series_item.id = book.series_id
  left join public.volumes volume on volume.id = series_item.volume_id
  left join public.collections collection_item on collection_item.id = coalesce(series_item.collection_id, volume.collection_id)
  where book.slug = lower(btrim(target_book_slug)) limit 1;
  if not found then return; end if;
  select * into decision from public.greyveil_resolve_book_access(target_user_id, target.id);
  book_id := target.id; book_slug := target.slug; book_title := target.title; effective_visibility := target.visibility;
  allowed := coalesce(decision.allowed, false);
  reason := case when allowed then lower(decision.access_state) when target_user_id is null and target.visibility = 'paid' then 'login_required' when target.visibility = 'private' then 'unavailable' else 'access_required' end;
  return next;
end;
$$;

create or replace function public.greyveil_admin_update_catalog_price(target_type text, target_id text, new_price_amount integer)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.greyveil_is_admin() then raise exception 'Admin access required.' using errcode = '42501'; end if;
  if new_price_amount is null or new_price_amount <= 0 then raise exception 'Price must be positive.'; end if;
  if target_type = 'book' then update public.books set price_amount = new_price_amount where id = target_id::bigint;
  elsif target_type = 'series' then update public.series set price_amount = new_price_amount where id = target_id::uuid;
  elsif target_type = 'collection' then update public.collections set price_amount = new_price_amount where id = target_id::uuid;
  else raise exception 'Unsupported catalog target.'; end if;
  if not found then raise exception 'Catalog target was not found.'; end if;
end;
$$;

create or replace function public.greyveil_admin_update_catalog_visibility(target_type text, target_id text, new_visibility text)
returns void language plpgsql security definer set search_path = public as $$
declare normalized_visibility text := lower(btrim(new_visibility));
begin
  if not public.greyveil_is_admin() then raise exception 'Admin access required.' using errcode = '42501'; end if;
  if normalized_visibility not in ('public', 'paid', 'private') then raise exception 'Unsupported visibility.'; end if;
  if target_type = 'book' then
    update public.books set visibility = normalized_visibility, is_public = normalized_visibility = 'public' where id = target_id::bigint;
  elsif target_type = 'series' then
    update public.series set visibility = normalized_visibility where id = target_id::uuid;
  elsif target_type = 'collection' then
    update public.collections set visibility = normalized_visibility where id = target_id::uuid;
  else raise exception 'Unsupported catalog target.'; end if;
  if not found then raise exception 'Catalog target was not found.'; end if;
end;
$$;

create or replace function public.greyveil_admin_set_book_series(target_book_id bigint, target_series_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.greyveil_is_admin() then raise exception 'Admin access required.' using errcode = '42501'; end if;
  update public.books set series_id = target_series_id where id = target_book_id;
  if not found then raise exception 'Book was not found.'; end if;
end;
$$;

create or replace function public.greyveil_admin_set_series_collection(target_series_id uuid, target_collection_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.greyveil_is_admin() then raise exception 'Admin access required.' using errcode = '42501'; end if;
  update public.series set collection_id = target_collection_id where id = target_series_id;
  if not found then raise exception 'Series was not found.'; end if;
end;
$$;

alter table public.catalog_access_grants enable row level security;
alter table public.temporary_access_passes enable row level security;
alter table public.temporary_access_pass_activations enable row level security;
drop policy if exists "Users and admins read catalog grants" on public.catalog_access_grants;
create policy "Users and admins read catalog grants" on public.catalog_access_grants for select to authenticated using (user_id = auth.uid() or public.greyveil_is_admin());
drop policy if exists "Admins manage catalog grants" on public.catalog_access_grants;
create policy "Admins manage catalog grants" on public.catalog_access_grants for all to authenticated using (public.greyveil_is_admin()) with check (public.greyveil_is_admin());
drop policy if exists "Public reads active temporary passes" on public.temporary_access_passes;
create policy "Public reads active temporary passes" on public.temporary_access_passes for select to anon, authenticated using (active or public.greyveil_is_admin());
drop policy if exists "Admins manage temporary passes" on public.temporary_access_passes;
create policy "Admins manage temporary passes" on public.temporary_access_passes for all to authenticated using (public.greyveil_is_admin()) with check (public.greyveil_is_admin());
drop policy if exists "Users and admins read pass activations" on public.temporary_access_pass_activations;
create policy "Users and admins read pass activations" on public.temporary_access_pass_activations for select to authenticated using (user_id = auth.uid() or public.greyveil_is_admin());

revoke all on function public.greyveil_resolve_book_access(uuid, bigint) from public;
revoke all on function public.greyveil_resolve_book_access(uuid, bigint) from anon;
revoke all on function public.greyveil_resolve_book_access(uuid, bigint) from authenticated;
grant execute on function public.greyveil_resolve_book_access(uuid, bigint) to service_role;
grant execute on function public.greyveil_effective_book_access(uuid, bigint) to authenticated;
grant execute on function public.greyveil_admin_update_catalog_price(text, text, integer) to authenticated;
grant execute on function public.greyveil_admin_update_catalog_visibility(text, text, text) to authenticated;
grant execute on function public.greyveil_admin_set_book_series(bigint, uuid) to authenticated;
grant execute on function public.greyveil_admin_set_series_collection(uuid, uuid) to authenticated;

commit;
notify pgrst, 'reload schema';
