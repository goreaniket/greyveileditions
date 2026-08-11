-- Greyveil Editions platform architecture upgrade.
-- Apply after razorpay-standard-checkout.sql, razorpay-test-coupon.sql,
-- and admin-publishing-step-1.sql. Safe to run more than once.

begin;

create extension if not exists pgcrypto;

-- The legacy constraint only understood book/series targets. Keep one canonical
-- constraint that also accepts the existing collection purchase shape.
do $$
declare
  legacy_definition text;
begin
  select pg_get_constraintdef(oid)
  into legacy_definition
  from pg_constraint
  where conrelid = 'public.orders'::regclass
    and conname = 'orders_purchase_target_check';

  if legacy_definition is not null then
    raise notice 'Replacing orders_purchase_target_check: %', legacy_definition;
  end if;

  alter table public.orders drop constraint if exists orders_purchase_target_check;
  alter table public.orders drop constraint if exists orders_purchase_target_matches_type;

  alter table public.orders
    add constraint orders_purchase_target_check
    check (
      (
        purchase_type is null
        and num_nonnulls(book_id, series_id, collection_id) <= 1
      )
      or (
        purchase_type = 'book'
        and book_id is not null
        and series_id is null
        and collection_id is null
      )
      or (
        purchase_type = 'series'
        and book_id is null
        and series_id is not null
        and collection_id is null
      )
      or (
        purchase_type = 'collection'
        and book_id is null
        and series_id is null
        and collection_id is not null
      )
    ) not valid;
end;
$$;

create or replace function public.greyveil_effective_book_access(
  target_user_id uuid,
  target_book_id bigint
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  with book_hierarchy as (
    select
      book.id as book_id,
      book.series_id,
      coalesce(series_item.collection_id, volume.collection_id) as collection_id,
      coalesce(book.is_active, true) as book_active,
      coalesce(series_item.is_active, true) as series_active,
      coalesce(volume.is_active, true) as volume_active,
      coalesce(collection_item.is_active, true) as collection_active,
      coalesce(book.visibility, case when book.is_public then 'public' else 'paid' end) as book_visibility,
      coalesce(series_item.visibility, 'public') as series_visibility,
      coalesce(volume.visibility, 'public') as volume_visibility,
      coalesce(collection_item.visibility, 'public') as collection_visibility
    from public.books book
    join public.series series_item on series_item.id = book.series_id
    left join public.volumes volume on volume.id = series_item.volume_id
    left join public.collections collection_item
      on collection_item.id = coalesce(series_item.collection_id, volume.collection_id)
    where book.id = target_book_id
  )
  select exists (
    select 1
    from book_hierarchy hierarchy
    where target_user_id is not null
      and hierarchy.book_active
      and hierarchy.series_active
      and hierarchy.volume_active
      and hierarchy.collection_active
      and hierarchy.book_visibility <> 'private'
      and hierarchy.series_visibility <> 'private'
      and hierarchy.volume_visibility <> 'private'
      and hierarchy.collection_visibility <> 'private'
      and (
        exists (
          select 1 from public.profiles profile
          where profile.id = target_user_id
            and profile.role in ('admin', 'super_admin')
        )
        or (
          hierarchy.book_visibility = 'public'
          and hierarchy.series_visibility = 'public'
          and hierarchy.volume_visibility = 'public'
          and hierarchy.collection_visibility = 'public'
        )
        or exists (
          select 1
          from public.book_access access
          where access.user_id = target_user_id
            and access.book_id = target_book_id
            and access.is_visible = true
            and access.can_read = true
            and (access.expires_at is null or access.expires_at > now())
        )
        or exists (
          select 1
          from public.orders paid_order
          where paid_order.user_id = target_user_id
            and paid_order.status = 'paid'
            and (
              (paid_order.purchase_type = 'book' and paid_order.book_id = target_book_id)
              or (paid_order.purchase_type = 'series' and paid_order.series_id = hierarchy.series_id)
              or (paid_order.purchase_type = 'collection' and paid_order.collection_id = hierarchy.collection_id)
            )
        )
      )
  );
$$;

revoke all on function public.greyveil_effective_book_access(uuid, bigint) from public;
grant execute on function public.greyveil_effective_book_access(uuid, bigint) to authenticated;

-- Reader reviews.
create table if not exists public.book_reviews (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  book_id bigint not null references public.books(id) on delete cascade,
  rating smallint not null check (rating between 1 and 5),
  review_text text not null check (char_length(btrim(review_text)) between 10 and 4000),
  moderation_status text not null default 'pending'
    check (moderation_status in ('pending', 'approved', 'rejected')),
  moderated_by uuid references auth.users(id) on delete set null,
  moderated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, book_id)
);

create index if not exists book_reviews_public_book_idx
  on public.book_reviews (book_id, moderation_status, created_at desc);

create or replace function public.greyveil_prepare_book_review()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    if new.user_id <> auth.uid() and not public.greyveil_is_admin() then
      raise exception 'A review may only be created for the signed-in user.';
    end if;
    if not public.greyveil_effective_book_access(new.user_id, new.book_id) then
      raise exception 'Valid book access is required to review this book.';
    end if;
    new.moderation_status = 'pending';
    new.moderated_by = null;
    new.moderated_at = null;
  elsif not public.greyveil_is_admin() then
    if new.user_id <> old.user_id or new.book_id <> old.book_id then
      raise exception 'Review ownership and book cannot be changed.';
    end if;
    if not public.greyveil_effective_book_access(old.user_id, old.book_id) then
      raise exception 'Valid book access is required to edit this review.';
    end if;
    new.moderation_status = 'pending';
    new.moderated_by = null;
    new.moderated_at = null;
    new.created_at = old.created_at;
  else
    if new.moderation_status is distinct from old.moderation_status then
      new.moderated_by = auth.uid();
      new.moderated_at = now();
    end if;
  end if;

  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists greyveil_prepare_book_review on public.book_reviews;
create trigger greyveil_prepare_book_review
before insert or update on public.book_reviews
for each row execute function public.greyveil_prepare_book_review();

alter table public.book_reviews enable row level security;

drop policy if exists "Approved reviews are public" on public.book_reviews;
create policy "Approved reviews are public"
on public.book_reviews for select
to anon, authenticated
using (moderation_status = 'approved');

drop policy if exists "Users read their reviews" on public.book_reviews;
create policy "Users read their reviews"
on public.book_reviews for select
to authenticated
using (user_id = auth.uid() or public.greyveil_is_admin());

drop policy if exists "Entitled users create reviews" on public.book_reviews;
create policy "Entitled users create reviews"
on public.book_reviews for insert
to authenticated
with check (
  user_id = auth.uid()
  and moderation_status = 'pending'
  and public.greyveil_effective_book_access(auth.uid(), book_id)
);

drop policy if exists "Users edit their reviews" on public.book_reviews;
create policy "Users edit their reviews"
on public.book_reviews for update
to authenticated
using (user_id = auth.uid() or public.greyveil_is_admin())
with check (
  public.greyveil_is_admin()
  or (
    user_id = auth.uid()
    and moderation_status = 'pending'
    and public.greyveil_effective_book_access(auth.uid(), book_id)
  )
);

drop policy if exists "Users delete their reviews" on public.book_reviews;
create policy "Users delete their reviews"
on public.book_reviews for delete
to authenticated
using (user_id = auth.uid() or public.greyveil_is_admin());

-- Trusted role changes. Existing profile updates remain possible when role is unchanged.
create or replace function public.greyveil_guard_profile_role()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  requester_role text;
  super_admin_count integer;
  jwt_role text := coalesce(current_setting('request.jwt.claim.role', true), '');
begin
  if new.role is not distinct from old.role then
    return new;
  end if;

  if new.role not in ('customer', 'admin', 'super_admin') then
    raise exception 'Unsupported Greyveil role.';
  end if;

  if jwt_role = 'service_role' then
    return new;
  end if;

  select role into requester_role from public.profiles where id = auth.uid();
  if requester_role <> 'super_admin' then
    raise exception 'Only a super admin may change roles.';
  end if;
  if new.id = auth.uid() then
    raise exception 'A super admin cannot change their own role.';
  end if;

  if old.role = 'super_admin' and new.role <> 'super_admin' then
    perform pg_advisory_xact_lock(809217551693617777);
    select count(*) into super_admin_count
    from public.profiles
    where role = 'super_admin';
    if super_admin_count <= 1 then
      raise exception 'The final super admin cannot be removed.';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists greyveil_guard_profile_role on public.profiles;
create trigger greyveil_guard_profile_role
before update of role on public.profiles
for each row execute function public.greyveil_guard_profile_role();

drop policy if exists "Super admins update profiles" on public.profiles;
create policy "Super admins update profiles"
on public.profiles for update
to authenticated
using (public.greyveil_is_super_admin())
with check (public.greyveil_is_super_admin());

drop policy if exists "Users update their own profile" on public.profiles;
create policy "Users update their own profile"
on public.profiles for update
to authenticated
using (id = auth.uid())
with check (id = auth.uid());

grant update on public.profiles to authenticated;

-- Managed coupons and enforced usage limits.
alter table public.orders
  add column if not exists original_amount integer,
  add column if not exists coupon_code text,
  add column if not exists discount_amount integer;

alter table public.payments
  add column if not exists original_amount integer,
  add column if not exists coupon_code text,
  add column if not exists discount_amount integer;

update public.orders
set original_amount = coalesce(original_amount, amount),
    discount_amount = coalesce(discount_amount, 0)
where original_amount is null or discount_amount is null;

update public.payments
set original_amount = coalesce(original_amount, amount),
    discount_amount = coalesce(discount_amount, 0)
where original_amount is null or discount_amount is null;

alter table public.orders alter column discount_amount set default 0;
alter table public.payments alter column discount_amount set default 0;

create table if not exists public.coupons (
  id uuid primary key default gen_random_uuid(),
  code text not null,
  description text,
  active boolean not null default true,
  discount_type text not null
    check (discount_type in ('percentage', 'fixed_amount', 'fixed_final_price')),
  discount_value integer not null default 0 check (discount_value >= 0),
  fixed_final_price integer check (fixed_final_price is null or fixed_final_price > 0),
  valid_from timestamptz,
  valid_until timestamptz,
  maximum_total_uses integer check (maximum_total_uses is null or maximum_total_uses > 0),
  maximum_uses_per_user integer check (maximum_uses_per_user is null or maximum_uses_per_user > 0),
  applicable_purchase_types text[] not null default array['book', 'series', 'collection']::text[],
  applies_to_all_products boolean not null default true,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (code = upper(btrim(code)) and code ~ '^[A-Z0-9_-]{2,40}$'),
  check (discount_type <> 'percentage' or discount_value <= 100),
  check (valid_until is null or valid_from is null or valid_until > valid_from),
  check (applicable_purchase_types <@ array['book', 'series', 'collection']::text[]),
  check (
    (discount_type = 'fixed_final_price' and fixed_final_price is not null)
    or discount_type <> 'fixed_final_price'
  )
);

alter table public.coupons
  add column if not exists applies_to_all_products boolean not null default true;

create unique index if not exists coupons_code_upper_uidx on public.coupons (upper(code));

create table if not exists public.coupon_products (
  id uuid primary key default gen_random_uuid(),
  coupon_id uuid not null references public.coupons(id) on delete cascade,
  purchase_type text not null check (purchase_type in ('book', 'series', 'collection')),
  target_id text not null,
  created_at timestamptz not null default now(),
  unique (coupon_id, purchase_type, target_id)
);

create or replace function public.greyveil_validate_coupon_product()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  allowed_types text[];
  target_exists boolean := false;
begin
  select applicable_purchase_types into allowed_types
  from public.coupons
  where id = new.coupon_id;

  if allowed_types is null or not (new.purchase_type = any(allowed_types)) then
    raise exception 'Coupon does not apply to this purchase type.';
  end if;

  if new.purchase_type = 'book' then
    select exists(select 1 from public.books where id::text = new.target_id) into target_exists;
  elsif new.purchase_type = 'series' then
    select exists(select 1 from public.series where id::text = new.target_id) into target_exists;
  elsif new.purchase_type = 'collection' then
    select exists(select 1 from public.collections where id::text = new.target_id) into target_exists;
  end if;

  if not target_exists then
    raise exception 'Coupon product target does not exist.';
  end if;
  return new;
end;
$$;

drop trigger if exists greyveil_validate_coupon_product on public.coupon_products;
create trigger greyveil_validate_coupon_product
before insert or update on public.coupon_products
for each row execute function public.greyveil_validate_coupon_product();

alter table public.orders add column if not exists coupon_id uuid references public.coupons(id) on delete set null;
alter table public.payments add column if not exists coupon_id uuid references public.coupons(id) on delete set null;

create table if not exists public.coupon_usages (
  id uuid primary key default gen_random_uuid(),
  coupon_id uuid not null references public.coupons(id) on delete restrict,
  order_id uuid not null references public.orders(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  coupon_code text not null,
  discount_amount integer not null check (discount_amount >= 0),
  status text not null default 'pending' check (status in ('pending', 'redeemed', 'void', 'refunded')),
  created_at timestamptz not null default now(),
  redeemed_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (order_id)
);

create index if not exists coupon_usages_limit_idx
  on public.coupon_usages (coupon_id, user_id, status, created_at);

create or replace function public.greyveil_validate_coupon_usage()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  coupon_row public.coupons%rowtype;
  total_uses integer;
  user_uses integer;
begin
  if new.status <> 'pending' then
    new.updated_at = now();
    return new;
  end if;

  select * into coupon_row
  from public.coupons
  where id = new.coupon_id
  for update;

  if not found or not coupon_row.active
     or (coupon_row.valid_from is not null and coupon_row.valid_from > now())
     or (coupon_row.valid_until is not null and coupon_row.valid_until <= now()) then
    raise exception 'Coupon is not active.';
  end if;

  select count(*) into total_uses
  from public.coupon_usages usage
  where usage.coupon_id = new.coupon_id
    and (
      usage.status = 'redeemed'
      or (usage.status = 'pending' and usage.created_at > now() - interval '30 minutes')
    );

  select count(*) into user_uses
  from public.coupon_usages usage
  where usage.coupon_id = new.coupon_id
    and usage.user_id = new.user_id
    and (
      usage.status = 'redeemed'
      or (usage.status = 'pending' and usage.created_at > now() - interval '30 minutes')
    );

  if coupon_row.maximum_total_uses is not null and total_uses >= coupon_row.maximum_total_uses then
    raise exception 'Coupon usage limit reached.';
  end if;
  if coupon_row.maximum_uses_per_user is not null and user_uses >= coupon_row.maximum_uses_per_user then
    raise exception 'Coupon user limit reached.';
  end if;

  new.coupon_code = coupon_row.code;
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists greyveil_validate_coupon_usage on public.coupon_usages;
create trigger greyveil_validate_coupon_usage
before insert or update on public.coupon_usages
for each row execute function public.greyveil_validate_coupon_usage();

insert into public.coupons (
  code, description, active, discount_type, discount_value, fixed_final_price,
  applicable_purchase_types
)
values (
  'RIZZ', 'Greyveil secure test checkout coupon', true,
  'fixed_final_price', 0, 100,
  array['book', 'series', 'collection']::text[]
)
on conflict (upper(code)) do update
set description = excluded.description,
    active = excluded.active,
    discount_type = excluded.discount_type,
    discount_value = excluded.discount_value,
    fixed_final_price = excluded.fixed_final_price,
    applicable_purchase_types = excluded.applicable_purchase_types,
    applies_to_all_products = true,
    updated_at = now();

alter table public.coupons enable row level security;
alter table public.coupon_products enable row level security;
alter table public.coupon_usages enable row level security;

drop policy if exists "Admins read coupons" on public.coupons;
create policy "Admins read coupons" on public.coupons for select to authenticated
using (public.greyveil_is_admin());
drop policy if exists "Super admins insert coupons" on public.coupons;
create policy "Super admins insert coupons" on public.coupons for insert to authenticated
with check (public.greyveil_is_super_admin() and created_by = auth.uid());
drop policy if exists "Super admins update coupons" on public.coupons;
create policy "Super admins update coupons" on public.coupons for update to authenticated
using (public.greyveil_is_super_admin()) with check (public.greyveil_is_super_admin());
drop policy if exists "Super admins delete coupons" on public.coupons;
create policy "Super admins delete coupons" on public.coupons for delete to authenticated
using (public.greyveil_is_super_admin());

drop policy if exists "Admins read coupon products" on public.coupon_products;
create policy "Admins read coupon products" on public.coupon_products for select to authenticated
using (public.greyveil_is_admin());
drop policy if exists "Super admins manage coupon products" on public.coupon_products;
create policy "Super admins manage coupon products" on public.coupon_products for all to authenticated
using (public.greyveil_is_super_admin()) with check (public.greyveil_is_super_admin());

drop policy if exists "Users read their coupon usage" on public.coupon_usages;
create policy "Users read their coupon usage" on public.coupon_usages for select to authenticated
using (user_id = auth.uid() or public.greyveil_is_admin());

-- First-party announcements and notification read state.
create table if not exists public.announcements (
  id uuid primary key default gen_random_uuid(),
  title text not null check (char_length(btrim(title)) between 2 and 160),
  message text not null check (char_length(btrim(message)) between 2 and 600),
  image_url text,
  cta_label text,
  cta_url text,
  placement text not null default 'site-wide'
    check (placement in ('site-wide', 'home', 'account', 'library', 'project')),
  audience text not null default 'everyone'
    check (audience in ('everyone', 'logged-in', 'series-owner', 'collection-owner')),
  audience_target_id uuid,
  starts_at timestamptz,
  ends_at timestamptz,
  active boolean not null default true,
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_at is null or starts_at is null or ends_at > starts_at),
  check (
    (audience in ('series-owner', 'collection-owner') and audience_target_id is not null)
    or (audience in ('everyone', 'logged-in') and audience_target_id is null)
  )
);

create table if not exists public.notification_reads (
  user_id uuid not null references auth.users(id) on delete cascade,
  announcement_id uuid not null references public.announcements(id) on delete cascade,
  read_at timestamptz not null default now(),
  primary key (user_id, announcement_id)
);

create or replace function public.greyveil_announcement_visible(
  viewer_id uuid,
  announcement_audience text,
  target_id uuid,
  is_active boolean,
  starts_at timestamptz,
  ends_at timestamptz
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    is_active
    and (starts_at is null or starts_at <= now())
    and (ends_at is null or ends_at > now())
    and (
      announcement_audience = 'everyone'
      or (announcement_audience = 'logged-in' and viewer_id is not null)
      or (
        announcement_audience = 'series-owner'
        and viewer_id is not null
        and exists (
          select 1 from public.orders paid_order
          where paid_order.user_id = viewer_id
            and paid_order.status = 'paid'
            and (
              (paid_order.purchase_type = 'series' and paid_order.series_id = target_id)
              or (
                paid_order.purchase_type = 'collection'
                and exists (
                  select 1 from public.series series_item
                  left join public.volumes volume on volume.id = series_item.volume_id
                  where series_item.id = target_id
                    and paid_order.collection_id = coalesce(series_item.collection_id, volume.collection_id)
                )
              )
            )
        )
      )
      or (
        announcement_audience = 'collection-owner'
        and viewer_id is not null
        and exists (
          select 1 from public.orders paid_order
          where paid_order.user_id = viewer_id
            and paid_order.status = 'paid'
            and paid_order.purchase_type = 'collection'
            and paid_order.collection_id = target_id
        )
      )
    );
$$;

alter table public.announcements enable row level security;
alter table public.notification_reads enable row level security;

drop policy if exists "Visible announcements are readable" on public.announcements;
create policy "Visible announcements are readable"
on public.announcements for select to anon, authenticated
using (
  public.greyveil_is_admin()
  or public.greyveil_announcement_visible(
    auth.uid(), audience, audience_target_id, active, starts_at, ends_at
  )
);

drop policy if exists "Admins insert announcements" on public.announcements;
create policy "Admins insert announcements" on public.announcements for insert to authenticated
with check (public.greyveil_is_admin() and created_by = auth.uid());
drop policy if exists "Admins update announcements" on public.announcements;
create policy "Admins update announcements" on public.announcements for update to authenticated
using (public.greyveil_is_admin()) with check (public.greyveil_is_admin());
drop policy if exists "Admins delete announcements" on public.announcements;
create policy "Admins delete announcements" on public.announcements for delete to authenticated
using (public.greyveil_is_admin());

drop policy if exists "Users read notification state" on public.notification_reads;
create policy "Users read notification state" on public.notification_reads for select to authenticated
using (user_id = auth.uid());
drop policy if exists "Users mark notifications read" on public.notification_reads;
create policy "Users mark notifications read" on public.notification_reads for insert to authenticated
with check (user_id = auth.uid());
drop policy if exists "Users update notification state" on public.notification_reads;
create policy "Users update notification state" on public.notification_reads for update to authenticated
using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists "Users clear notification state" on public.notification_reads;
create policy "Users clear notification state" on public.notification_reads for delete to authenticated
using (user_id = auth.uid());

revoke all on function public.greyveil_prepare_book_review() from public;
revoke all on function public.greyveil_guard_profile_role() from public;
revoke all on function public.greyveil_validate_coupon_usage() from public;
revoke all on function public.greyveil_validate_coupon_product() from public;
revoke all on function public.greyveil_announcement_visible(uuid, text, uuid, boolean, timestamptz, timestamptz) from public;
grant execute on function public.greyveil_announcement_visible(uuid, text, uuid, boolean, timestamptz, timestamptz) to anon, authenticated;

grant select on public.book_reviews to anon, authenticated;
grant insert, update, delete on public.book_reviews to authenticated;
grant select, insert, update, delete on public.coupons to authenticated;
grant select, insert, update, delete on public.coupon_products to authenticated;
grant select on public.coupon_usages to authenticated;
grant select on public.announcements to anon, authenticated;
grant insert, update, delete on public.announcements to authenticated;
grant select, insert, update, delete on public.notification_reads to authenticated;

-- Public announcement artwork. Only authenticated Greyveil admins can manage files.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'announcement-images',
  'announcement-images',
  true,
  5242880,
  array['image/png', 'image/jpeg', 'image/webp']
)
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Public reads announcement images" on storage.objects;
create policy "Public reads announcement images"
on storage.objects for select to anon, authenticated
using (bucket_id = 'announcement-images');

drop policy if exists "Admins upload announcement images" on storage.objects;
create policy "Admins upload announcement images"
on storage.objects for insert to authenticated
with check (bucket_id = 'announcement-images' and public.greyveil_is_admin());

drop policy if exists "Admins update announcement images" on storage.objects;
create policy "Admins update announcement images"
on storage.objects for update to authenticated
using (bucket_id = 'announcement-images' and public.greyveil_is_admin())
with check (bucket_id = 'announcement-images' and public.greyveil_is_admin());

drop policy if exists "Admins delete announcement images" on storage.objects;
create policy "Admins delete announcement images"
on storage.objects for delete to authenticated
using (bucket_id = 'announcement-images' and public.greyveil_is_admin());

commit;

notify pgrst, 'reload schema';
