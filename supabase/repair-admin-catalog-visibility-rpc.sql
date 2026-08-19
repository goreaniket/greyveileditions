-- Targeted production repair for the Admin Catalog Visibility RPC.
-- This intentionally does not alter catalog data, pricing, or direct table permissions.

begin;

create or replace function public.greyveil_admin_update_catalog_visibility(
  target_type text,
  target_id text,
  new_visibility text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  normalized_visibility text := lower(btrim(new_visibility));
begin
  if not public.greyveil_is_admin() then
    raise exception 'Admin access required.' using errcode = '42501';
  end if;

  if normalized_visibility not in ('public', 'paid', 'private') then
    raise exception 'Unsupported visibility.';
  end if;

  if target_type = 'book' then
    update public.books
    set visibility = normalized_visibility,
        is_public = normalized_visibility = 'public'
    where id = target_id::bigint;
  elsif target_type = 'series' then
    update public.series
    set visibility = normalized_visibility
    where id = target_id::uuid;
  elsif target_type = 'collection' then
    update public.collections
    set visibility = normalized_visibility
    where id = target_id::uuid;
  else
    raise exception 'Unsupported catalog target.';
  end if;

  if not found then
    raise exception 'Catalog target was not found.';
  end if;
end;
$$;

revoke all on function public.greyveil_admin_update_catalog_visibility(text, text, text) from public;
revoke all on function public.greyveil_admin_update_catalog_visibility(text, text, text) from anon;
revoke all on function public.greyveil_admin_update_catalog_visibility(text, text, text) from authenticated;
grant execute on function public.greyveil_admin_update_catalog_visibility(text, text, text) to authenticated;

commit;

notify pgrst, 'reload schema';
