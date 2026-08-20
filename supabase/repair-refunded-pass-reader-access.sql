-- Targeted production repair: an unexpired temporary Pass activation grants
-- Reader access only while its source Pass order remains paid.
-- This preserves the existing function signature, SECURITY DEFINER boundary,
-- search_path, and service-only ACL of the deployed function.

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
    join public.orders activation_order on activation_order.id = activation.order_id
    where activation.user_id = target_user_id and activation.expires_at > now()
      and activation_order.user_id = target_user_id and activation_order.status = 'paid'
      and activation_order.purchase_type = 'pass' and activation_order.temporary_access_pass_id = activation.pass_id
      and (pass_row.scope_type = 'library' or (pass_row.scope_type = 'collection' and pass_row.collection_id = hierarchy.resolved_collection_id))
  ) into viewer_has_access;
  allowed := viewer_has_access; reason := case when viewer_has_access then 'entitled' else 'access_required' end;
  return next;
end;
$$;
