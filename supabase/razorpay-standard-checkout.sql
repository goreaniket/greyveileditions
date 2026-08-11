-- Greyveil Editions Razorpay Standard Checkout payment extension.
-- Apply after the existing Greyveil base schema and admin role helpers.
-- Existing orders, payments, and book/series access behavior are preserved.

create extension if not exists pgcrypto;

alter table public.orders
  add column if not exists purchase_type text,
  add column if not exists book_id bigint references public.books(id) on delete restrict,
  add column if not exists series_id uuid references public.series(id) on delete restrict,
  add column if not exists collection_id uuid references public.collections(id) on delete restrict,
  add column if not exists item_name text,
  add column if not exists amount integer,
  add column if not exists currency text not null default 'INR',
  add column if not exists status text not null default 'pending',
  add column if not exists razorpay_order_id text,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now(),
  add column if not exists paid_at timestamptz,
  add column if not exists verified_at timestamptz;

alter table public.payments
  add column if not exists order_id uuid references public.orders(id) on delete set null,
  add column if not exists user_id uuid references auth.users(id) on delete set null,
  add column if not exists razorpay_payment_id text,
  add column if not exists razorpay_order_id text,
  add column if not exists razorpay_signature text,
  add column if not exists amount integer,
  add column if not exists currency text not null default 'INR',
  add column if not exists status text not null default 'created',
  add column if not exists method text,
  add column if not exists captured boolean not null default false,
  add column if not exists raw_payload jsonb not null default '{}'::jsonb,
  add column if not exists webhook_event_id text,
  add column if not exists razorpay_created_at timestamptz,
  add column if not exists verified_at timestamptz,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

create unique index if not exists orders_razorpay_order_id_uidx
  on public.orders (razorpay_order_id)
  where razorpay_order_id is not null;

create unique index if not exists payments_razorpay_payment_id_uidx
  on public.payments (razorpay_payment_id)
  where razorpay_payment_id is not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.orders'::regclass
      and conname = 'orders_purchase_type_valid'
  ) then
    alter table public.orders
      add constraint orders_purchase_type_valid
      check (purchase_type is null or purchase_type in ('book', 'series', 'collection'))
      not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.orders'::regclass
      and conname = 'orders_purchase_target_matches_type'
  ) then
    alter table public.orders
      add constraint orders_purchase_target_matches_type
      check (
        purchase_type is null
        or (purchase_type = 'book' and book_id is not null and series_id is null and collection_id is null)
        or (purchase_type = 'series' and book_id is null and series_id is not null and collection_id is null)
        or (purchase_type = 'collection' and book_id is null and series_id is null and collection_id is not null)
      )
      not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.orders'::regclass
      and conname = 'orders_amount_positive'
  ) then
    alter table public.orders
      add constraint orders_amount_positive check (amount is null or amount > 0) not valid;
  end if;
end;
$$;

create or replace function public.greyveil_touch_payment_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists touch_orders_payment_updated_at on public.orders;
create trigger touch_orders_payment_updated_at
before update on public.orders
for each row execute function public.greyveil_touch_payment_updated_at();

drop trigger if exists touch_payments_updated_at on public.payments;
create trigger touch_payments_updated_at
before update on public.payments
for each row execute function public.greyveil_touch_payment_updated_at();

create or replace function public.greyveil_grant_collection_order_access()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.purchase_type <> 'collection'
     or new.collection_id is null
     or new.user_id is null
     or new.status <> 'paid' then
    return new;
  end if;

  update public.book_access access
  set access_type = 'purchase',
      granted_by = new.user_id,
      granted_at = coalesce(new.paid_at, now()),
      expires_at = null,
      is_visible = true,
      can_read = true
  from public.books book
  join public.series series_item on series_item.id = book.series_id
  left join public.volumes volume on volume.id = series_item.volume_id
  join public.collections collection_item
    on collection_item.id = coalesce(series_item.collection_id, volume.collection_id)
  where access.user_id = new.user_id
    and access.book_id = book.id
    and collection_item.id = new.collection_id
    and coalesce(collection_item.is_active, true)
    and coalesce(volume.is_active, true)
    and coalesce(series_item.is_active, true)
    and coalesce(book.is_active, true)
    and coalesce(collection_item.visibility, 'public') <> 'private'
    and coalesce(volume.visibility, 'public') <> 'private'
    and coalesce(series_item.visibility, 'public') <> 'private'
    and coalesce(book.visibility, case when book.is_public then 'public' else 'paid' end) <> 'private';

  insert into public.book_access (
    user_id,
    book_id,
    granted_by,
    access_type,
    granted_at,
    expires_at,
    is_visible,
    can_read
  )
  select
    new.user_id,
    book.id,
    new.user_id,
    'purchase',
    coalesce(new.paid_at, now()),
    null,
    true,
    true
  from public.books book
  join public.series series_item on series_item.id = book.series_id
  left join public.volumes volume on volume.id = series_item.volume_id
  join public.collections collection_item
    on collection_item.id = coalesce(series_item.collection_id, volume.collection_id)
  where collection_item.id = new.collection_id
    and coalesce(collection_item.is_active, true)
    and coalesce(volume.is_active, true)
    and coalesce(series_item.is_active, true)
    and coalesce(book.is_active, true)
    and coalesce(collection_item.visibility, 'public') <> 'private'
    and coalesce(volume.visibility, 'public') <> 'private'
    and coalesce(series_item.visibility, 'public') <> 'private'
    and coalesce(book.visibility, case when book.is_public then 'public' else 'paid' end) <> 'private'
    and not exists (
      select 1
      from public.book_access existing_access
      where existing_access.user_id = new.user_id
        and existing_access.book_id = book.id
    );

  return new;
end;
$$;

drop trigger if exists greyveil_collection_order_access on public.orders;
create trigger greyveil_collection_order_access
after insert or update of status, collection_id on public.orders
for each row execute function public.greyveil_grant_collection_order_access();

alter table public.orders enable row level security;
alter table public.payments enable row level security;

drop policy if exists "Customers and admins can read orders" on public.orders;
create policy "Customers and admins can read orders"
on public.orders
for select
to authenticated
using (user_id = auth.uid() or public.greyveil_is_admin());

drop policy if exists "Customers and admins can read payments" on public.payments;
create policy "Customers and admins can read payments"
on public.payments
for select
to authenticated
using (user_id = auth.uid() or public.greyveil_is_admin());

revoke select on public.orders from authenticated;
grant select (
  id, user_id, purchase_type, book_id, series_id, collection_id, item_name,
  amount, currency, status, razorpay_order_id, created_at, updated_at, paid_at, verified_at
) on public.orders to authenticated;

revoke select on public.payments from authenticated;
grant select (
  id, order_id, user_id, razorpay_payment_id, razorpay_order_id, amount, currency,
  status, method, captured, created_at, updated_at, verified_at, razorpay_created_at
) on public.payments to authenticated;

revoke all on function public.greyveil_grant_collection_order_access() from public;
revoke all on function public.greyveil_touch_payment_updated_at() from public;
