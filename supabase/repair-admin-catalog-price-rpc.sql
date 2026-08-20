-- Targeted production repair for the Admin Catalog Pricing RPC.
-- This intentionally does not alter catalog data or direct table permissions.

begin;

create or replace function public.greyveil_admin_update_catalog_price(
  target_type text,
  target_id text,
  new_price_amount integer
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  normalized_target_type text := lower(btrim(target_type));
begin
  if not public.greyveil_is_admin() then
    raise exception 'Admin access required.' using errcode = '42501';
  end if;

  if new_price_amount is null or new_price_amount <= 0 then
    raise exception 'Price must be positive.';
  end if;

  if normalized_target_type = 'book' then
    update public.books
    set price_amount = new_price_amount
    where id = target_id::bigint;
  elsif normalized_target_type = 'series' then
    update public.series
    set price_amount = new_price_amount
    where id = target_id::uuid;
  elsif normalized_target_type = 'collection' then
    update public.collections
    set price_amount = new_price_amount
    where id = target_id::uuid;
  else
    raise exception 'Unsupported catalog target.';
  end if;

  if not found then
    raise exception 'Catalog target was not found.';
  end if;
end;
$$;

revoke all on function public.greyveil_admin_update_catalog_price(text, text, integer) from public;
revoke all on function public.greyveil_admin_update_catalog_price(text, text, integer) from anon;
revoke all on function public.greyveil_admin_update_catalog_price(text, text, integer) from authenticated;
grant execute on function public.greyveil_admin_update_catalog_price(text, text, integer) to authenticated;

commit;

notify pgrst, 'reload schema';
