-- Greyveil Editions manual sales invoice register.
-- Apply this SQL in Supabase SQL Editor before using /admin/billing/.
create extension if not exists pgcrypto;

create sequence if not exists public.greyveil_sales_invoice_number_seq;

create table if not exists public.sales_invoices (
  id uuid primary key default gen_random_uuid(),
  invoice_number text not null unique,
  invoice_date date not null default current_date,
  customer_name text not null,
  customer_email text,
  customer_phone text,
  customer_address text,
  items jsonb not null default '[]'::jsonb,
  subtotal_paise bigint not null default 0 check (subtotal_paise >= 0),
  shipping_paise bigint not null default 0 check (shipping_paise >= 0),
  discount_paise bigint not null default 0 check (discount_paise >= 0),
  total_paise bigint not null check (total_paise >= 0),
  payment_status text not null default 'paid' check (payment_status in ('paid','pending','partial','refunded')),
  payment_method text,
  notes text,
  status text not null default 'issued' check (status in ('issued','void')),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists sales_invoices_date_idx on public.sales_invoices(invoice_date desc, created_at desc);
create index if not exists sales_invoices_customer_idx on public.sales_invoices using gin (to_tsvector('simple', customer_name));

-- Match the admin roles used by the existing Greyveil admin dashboard.
create or replace function public.greyveil_is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as 'select exists (
  select 1
  from public.profiles
  where id = auth.uid()
    and role in (''admin'', ''super_admin'')
)';
revoke all on function public.greyveil_is_admin() from public;
grant execute on function public.greyveil_is_admin() to authenticated;

alter table public.sales_invoices enable row level security;

drop policy if exists "Admins can read sales invoices" on public.sales_invoices;
create policy "Admins can read sales invoices"
on public.sales_invoices for select to authenticated
using (public.greyveil_is_admin());

drop policy if exists "Admins can create sales invoices" on public.sales_invoices;
create policy "Admins can create sales invoices"
on public.sales_invoices for insert to authenticated
with check (public.greyveil_is_admin() and created_by = auth.uid());

drop policy if exists "Admins can update sales invoices" on public.sales_invoices;
create policy "Admins can update sales invoices"
on public.sales_invoices for update to authenticated
using (public.greyveil_is_admin())
with check (public.greyveil_is_admin());

grant select, insert, update on public.sales_invoices to authenticated;

create or replace function public.greyveil_next_sales_invoice_number()
returns text
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.greyveil_is_admin() then
    raise exception 'Admin access required.' using errcode = '42501';
  end if;
  return 'GV-' || to_char(current_date, 'YYYY') || '-' ||
    lpad(nextval('public.greyveil_sales_invoice_number_seq')::text, 5, '0');
end;
$$;

revoke all on function public.greyveil_next_sales_invoice_number() from public;
grant execute on function public.greyveil_next_sales_invoice_number() to authenticated;

create or replace function public.greyveil_touch_sales_invoice_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists touch_sales_invoice_updated_at on public.sales_invoices;
create trigger touch_sales_invoice_updated_at
before update on public.sales_invoices
for each row execute function public.greyveil_touch_sales_invoice_updated_at();

revoke all on function public.greyveil_touch_sales_invoice_updated_at() from public;
notify pgrst, 'reload schema';
