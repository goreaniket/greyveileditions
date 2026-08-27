-- Greyveil Editions Phase 1B4: monotonic payment state and duplicate-order repair.
-- Apply after the canonical Razorpay checkout schema. This file does not alter data.

begin;

create or replace function public.greyveil_enforce_order_status_transition()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.status := lower(coalesce(new.status, old.status, 'pending'));

  if lower(coalesce(old.status, 'pending')) = 'refunded' then
    new.status := 'refunded';
  elsif lower(coalesce(old.status, 'pending')) = 'paid'
        and new.status not in ('paid', 'refunded') then
    new.status := 'paid';
  elsif lower(coalesce(old.status, 'pending')) in ('failed', 'cancelled')
        and new.status = 'pending' then
    new.status := lower(old.status);
  end if;

  return new;
end;
$$;

drop trigger if exists greyveil_enforce_order_status_transition on public.orders;
create trigger greyveil_enforce_order_status_transition
before update of status on public.orders
for each row execute function public.greyveil_enforce_order_status_transition();

create or replace function public.greyveil_enforce_payment_status_transition()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.status := lower(coalesce(new.status, old.status, 'created'));
  new.captured := coalesce(old.captured, false) or coalesce(new.captured, false);

  if lower(coalesce(old.status, 'created')) = 'refunded' then
    new.status := 'refunded';
  elsif (lower(coalesce(old.status, 'created')) = 'captured' or coalesce(old.captured, false))
        and new.status <> 'refunded' then
    new.status := 'captured';
    new.captured := true;
  elsif lower(coalesce(old.status, 'created')) = 'failed'
        and new.status not in ('failed', 'refunded') then
    new.status := 'failed';
    new.captured := coalesce(old.captured, false);
  end if;

  return new;
end;
$$;

drop trigger if exists greyveil_enforce_payment_status_transition on public.payments;
create trigger greyveil_enforce_payment_status_transition
before update of status, captured on public.payments
for each row execute function public.greyveil_enforce_payment_status_transition();

create or replace function public.greyveil_prevent_duplicate_payable_order()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  entitlement_key text;
begin
  if lower(coalesce(new.status, 'pending')) <> 'pending' or new.user_id is null then
    return new;
  end if;

  entitlement_key := case lower(coalesce(new.purchase_type, ''))
    when 'book' then 'book:' || coalesce(new.book_id::text, '')
    when 'series' then 'series:' || coalesce(new.series_id::text, '')
    when 'collection' then 'collection:' || coalesce(new.collection_id::text, '')
    when 'pass' then 'pass:' || coalesce(new.temporary_access_pass_id::text, '')
    else null
  end;

  if entitlement_key is null or right(entitlement_key, 1) = ':' then
    return new;
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(new.user_id::text || '|' || entitlement_key, 0)
  );

  if exists (
    select 1
    from public.orders existing_order
    where existing_order.user_id = new.user_id
      and lower(coalesce(existing_order.status, 'pending')) = 'pending'
      and lower(coalesce(existing_order.purchase_type, '')) = lower(new.purchase_type)
      and (
        (lower(new.purchase_type) = 'book' and existing_order.book_id = new.book_id)
        or (lower(new.purchase_type) = 'series' and existing_order.series_id = new.series_id)
        or (lower(new.purchase_type) = 'collection' and existing_order.collection_id = new.collection_id)
        or (lower(new.purchase_type) = 'pass' and existing_order.temporary_access_pass_id = new.temporary_access_pass_id)
      )
      and existing_order.id is distinct from new.id
  ) then
    raise exception 'An active payable order already exists for this entitlement.'
      using errcode = '23505',
            constraint = 'orders_one_active_payable_entitlement';
  end if;

  return new;
end;
$$;

drop trigger if exists greyveil_prevent_duplicate_payable_order on public.orders;
create trigger greyveil_prevent_duplicate_payable_order
before insert or update of status, user_id, purchase_type, book_id, series_id, collection_id, temporary_access_pass_id
on public.orders
for each row execute function public.greyveil_prevent_duplicate_payable_order();

create or replace function public.greyveil_record_payment_transition(
  p_order_id uuid,
  p_payment jsonb,
  p_next_order_status text default null,
  p_signature text default null,
  p_webhook_event_id text default null,
  p_verified boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  order_row public.orders%rowtype;
  payment_row public.payments%rowtype;
  existing_payment public.payments%rowtype;
  payment_id text := nullif(btrim(p_payment ->> 'id'), '');
  incoming_payment_status text := lower(coalesce(nullif(btrim(p_payment ->> 'status'), ''), 'unknown'));
  incoming_captured boolean := case
    when jsonb_typeof(p_payment -> 'captured') = 'boolean' then (p_payment ->> 'captured')::boolean
    else false
  end;
  requested_status text := nullif(lower(btrim(p_next_order_status)), '');
  effective_order_status text;
  payment_matches boolean := false;
  payment_created_at timestamptz;
  transition_changed boolean := false;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Service-role payment access required.' using errcode = '42501';
  end if;

  if payment_id is null then
    raise exception 'Payment id is required.' using errcode = '22023';
  end if;

  if requested_status is not null
     and requested_status not in ('pending', 'failed', 'paid', 'refunded', 'cancelled') then
    raise exception 'Unsupported order status transition.' using errcode = '22023';
  end if;

  if p_order_id is not null then
    select * into order_row
    from public.orders
    where id = p_order_id
    for update;

    if not found then
      raise exception 'Order was not found.' using errcode = 'P0002';
    end if;

    payment_matches := coalesce(p_payment ->> 'order_id', '') = coalesce(order_row.razorpay_order_id, '')
      and (p_payment ->> 'amount')::integer = order_row.amount
      and upper(coalesce(p_payment ->> 'currency', '')) = upper(coalesce(order_row.currency, 'INR'));
  end if;

  select * into existing_payment
  from public.payments
  where razorpay_payment_id = payment_id
  for update;

  if found
     and existing_payment.order_id is not null
     and p_order_id is not null
     and existing_payment.order_id is distinct from p_order_id then
    raise exception 'Payment is already bound to another order.' using errcode = '23505';
  end if;

  if requested_status = 'paid'
     and (payment_matches is distinct from true or incoming_payment_status <> 'captured' or incoming_captured is distinct from true) then
    raise exception 'Captured payment does not match the order.' using errcode = '22023';
  end if;

  if requested_status = 'refunded' and incoming_payment_status <> 'refunded' then
    raise exception 'Refund transition requires refunded payment state.' using errcode = '22023';
  end if;

  if nullif(p_payment ->> 'created_at', '') is not null then
    payment_created_at := to_timestamp((p_payment ->> 'created_at')::double precision);
  end if;

  insert into public.payments (
    order_id,
    user_id,
    razorpay_payment_id,
    razorpay_order_id,
    razorpay_signature,
    original_amount,
    amount,
    coupon_code,
    coupon_id,
    discount_amount,
    currency,
    status,
    method,
    captured,
    raw_payload,
    webhook_event_id,
    razorpay_created_at,
    verified_at,
    created_at,
    updated_at
  ) values (
    p_order_id,
    case when p_order_id is null then null else order_row.user_id end,
    payment_id,
    coalesce(nullif(p_payment ->> 'order_id', ''), order_row.razorpay_order_id),
    nullif(p_signature, ''),
    case when p_order_id is null then null else coalesce(order_row.original_amount, order_row.amount) end,
    coalesce((p_payment ->> 'amount')::integer, order_row.amount),
    case when p_order_id is null then null else order_row.coupon_code end,
    case when p_order_id is null then null else order_row.coupon_id end,
    case when p_order_id is null then 0 else coalesce(order_row.discount_amount, 0) end,
    upper(coalesce(nullif(p_payment ->> 'currency', ''), order_row.currency, 'INR')),
    case when requested_status = 'refunded' then 'refunded' else incoming_payment_status end,
    nullif(p_payment ->> 'method', ''),
    incoming_captured,
    p_payment,
    nullif(p_webhook_event_id, ''),
    payment_created_at,
    case when p_verified and payment_matches and incoming_captured then now() else null end,
    now(),
    now()
  )
  on conflict (razorpay_payment_id) where razorpay_payment_id is not null
  do update set
    order_id = coalesce(public.payments.order_id, excluded.order_id),
    user_id = coalesce(public.payments.user_id, excluded.user_id),
    razorpay_order_id = coalesce(public.payments.razorpay_order_id, excluded.razorpay_order_id),
    razorpay_signature = coalesce(excluded.razorpay_signature, public.payments.razorpay_signature),
    original_amount = coalesce(public.payments.original_amount, excluded.original_amount),
    amount = excluded.amount,
    coupon_code = coalesce(public.payments.coupon_code, excluded.coupon_code),
    coupon_id = coalesce(public.payments.coupon_id, excluded.coupon_id),
    discount_amount = excluded.discount_amount,
    currency = excluded.currency,
    status = excluded.status,
    method = coalesce(excluded.method, public.payments.method),
    captured = public.payments.captured or excluded.captured,
    raw_payload = case
      when lower(public.payments.status) = 'refunded' and lower(excluded.status) <> 'refunded'
        then public.payments.raw_payload
      else excluded.raw_payload
    end,
    webhook_event_id = case
      when lower(public.payments.status) = 'refunded' and lower(excluded.status) <> 'refunded'
        then public.payments.webhook_event_id
      else coalesce(excluded.webhook_event_id, public.payments.webhook_event_id)
    end,
    razorpay_created_at = coalesce(public.payments.razorpay_created_at, excluded.razorpay_created_at),
    verified_at = coalesce(public.payments.verified_at, excluded.verified_at),
    updated_at = now()
  returning * into payment_row;

  if requested_status = 'paid'
     and lower(coalesce(order_row.status, 'pending')) <> 'refunded'
     and (lower(payment_row.status) <> 'captured' or payment_row.captured is distinct from true) then
    raise exception 'A failed or non-captured payment cannot settle an order.' using errcode = '22023';
  end if;

  if p_order_id is not null and requested_status is not null then
    effective_order_status := case
      when requested_status = 'refunded' then 'refunded'
      when lower(coalesce(order_row.status, 'pending')) = 'refunded' then 'refunded'
      when lower(coalesce(order_row.status, 'pending')) = 'paid' then 'paid'
      when requested_status = 'paid' then 'paid'
      when lower(coalesce(order_row.status, 'pending')) in ('failed', 'cancelled')
        then lower(order_row.status)
      when requested_status in ('failed', 'cancelled') then requested_status
      else 'pending'
    end;

    transition_changed := effective_order_status is distinct from order_row.status;

    if transition_changed or (
      effective_order_status = 'paid'
      and (order_row.paid_at is null or (p_verified and order_row.verified_at is null))
    ) then
      update public.orders
      set status = effective_order_status,
          paid_at = case
            when effective_order_status = 'paid' then coalesce(order_row.paid_at, now())
            else order_row.paid_at
          end,
          verified_at = case
            when effective_order_status = 'paid' and p_verified then coalesce(order_row.verified_at, now())
            else order_row.verified_at
          end,
          updated_at = now()
      where id = order_row.id
      returning * into order_row;
    end if;

    if order_row.coupon_id is not null then
      update public.coupon_usages
      set status = case effective_order_status
            when 'paid' then 'redeemed'
            when 'refunded' then 'refunded'
            when 'failed' then 'void'
            when 'cancelled' then 'void'
            else status
          end,
          redeemed_at = case
            when effective_order_status = 'paid' then coalesce(redeemed_at, now())
            when effective_order_status in ('refunded', 'failed', 'cancelled') then null
            else redeemed_at
          end,
          updated_at = now()
      where order_id = order_row.id
        and status is distinct from case effective_order_status
          when 'paid' then 'redeemed'
          when 'refunded' then 'refunded'
          when 'failed' then 'void'
          when 'cancelled' then 'void'
          else status
        end;
    end if;
  end if;

  return jsonb_build_object(
    'order', case when p_order_id is null then null else to_jsonb(order_row) end,
    'payment', to_jsonb(payment_row),
    'transition_changed', transition_changed
  );
end;
$$;

revoke all on function public.greyveil_enforce_order_status_transition() from public, anon, authenticated, service_role;
revoke all on function public.greyveil_enforce_payment_status_transition() from public, anon, authenticated, service_role;
revoke all on function public.greyveil_prevent_duplicate_payable_order() from public, anon, authenticated, service_role;
revoke all on function public.greyveil_record_payment_transition(uuid, jsonb, text, text, text, boolean) from public, anon, authenticated, service_role;
grant execute on function public.greyveil_record_payment_transition(uuid, jsonb, text, text, text, boolean) to service_role;

notify pgrst, 'reload schema';

commit;
