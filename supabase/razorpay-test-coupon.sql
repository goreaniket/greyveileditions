-- Greyveil Editions server-owned test coupon audit fields.
-- Apply after supabase/razorpay-standard-checkout.sql.

begin;

alter table public.orders
  add column if not exists original_amount integer,
  add column if not exists coupon_code text,
  add column if not exists discount_amount integer;

alter table public.payments
  add column if not exists original_amount integer,
  add column if not exists coupon_code text,
  add column if not exists discount_amount integer;

update public.orders
set original_amount = amount
where original_amount is null
  and amount is not null;

update public.payments
set original_amount = amount
where original_amount is null
  and amount is not null;

update public.orders
set discount_amount = greatest(coalesce(original_amount, amount, 0) - coalesce(amount, 0), 0)
where discount_amount is null;

update public.payments
set discount_amount = greatest(coalesce(original_amount, amount, 0) - coalesce(amount, 0), 0)
where discount_amount is null;

alter table public.orders
  alter column discount_amount set default 0,
  alter column discount_amount set not null;

alter table public.payments
  alter column discount_amount set default 0,
  alter column discount_amount set not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.orders'::regclass
      and conname = 'orders_original_amount_positive'
  ) then
    alter table public.orders
      add constraint orders_original_amount_positive
      check (original_amount is null or original_amount > 0)
      not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.orders'::regclass
      and conname = 'orders_discount_amount_valid'
  ) then
    alter table public.orders
      add constraint orders_discount_amount_valid
      check (
        discount_amount >= 0
        and (
          original_amount is null
          or amount is null
          or (original_amount >= amount and discount_amount = original_amount - amount)
        )
      )
      not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.payments'::regclass
      and conname = 'payments_original_amount_positive'
  ) then
    alter table public.payments
      add constraint payments_original_amount_positive
      check (original_amount is null or original_amount > 0)
      not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.payments'::regclass
      and conname = 'payments_discount_amount_valid'
  ) then
    alter table public.payments
      add constraint payments_discount_amount_valid
      check (discount_amount >= 0)
      not valid;
  end if;
end;
$$;

revoke select on public.orders from authenticated;
grant select (
  id, user_id, purchase_type, book_id, series_id, collection_id, item_name,
  original_amount, amount, coupon_code, discount_amount, currency, status,
  razorpay_order_id, created_at, updated_at, paid_at, verified_at
) on public.orders to authenticated;

revoke select on public.payments from authenticated;
grant select (
  id, order_id, user_id, razorpay_payment_id, razorpay_order_id,
  original_amount, amount, coupon_code, discount_amount, currency,
  status, method, captured, created_at, updated_at, verified_at, razorpay_created_at
) on public.payments to authenticated;

commit;

NOTIFY pgrst, 'reload schema';
