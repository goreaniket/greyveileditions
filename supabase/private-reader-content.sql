-- Greyveil Editions private reader-content delivery.
-- Apply after platform-architecture-upgrade.sql.

begin;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'reader-content',
  'reader-content',
  false,
  2097152,
  array['application/json']::text[]
)
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

-- No storage.objects policy is created for reader-content. Browser clients must
-- use the reader-content Edge Function, which reads through the service role
-- only after this database resolver authorizes the request.
create or replace function public.greyveil_reader_content_authorization(
  target_user_id uuid,
  target_book_slug text
)
returns table (
  book_id bigint,
  book_slug text,
  book_title text,
  effective_visibility text,
  allowed boolean,
  reason text
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  hierarchy record;
  viewer_role text;
  viewer_has_access boolean := false;
begin
  select
    book.id as resolved_book_id,
    book.slug as resolved_book_slug,
    book.title as resolved_book_title,
    coalesce(book.is_active, true)
      and coalesce(series_item.is_active, true)
      and coalesce(volume.is_active, true)
      and coalesce(collection_item.is_active, true) as hierarchy_active,
    case
      when lower(coalesce(book.visibility, '')) = 'private'
        then 'private'
      when coalesce(book.is_public, false)
        or lower(coalesce(book.visibility, '')) = 'public'
        then 'public'
      when lower(coalesce(series_item.visibility, 'public')) = 'private'
        or lower(coalesce(volume.visibility, 'public')) = 'private'
        or lower(coalesce(collection_item.visibility, 'public')) = 'private'
        then 'private'
      else 'paid'
    end as resolved_visibility
  into hierarchy
  from public.books book
  join public.series series_item on series_item.id = book.series_id
  join public.volumes volume on volume.id = series_item.volume_id
  join public.collections collection_item
    on collection_item.id = coalesce(series_item.collection_id, volume.collection_id)
  where book.slug = lower(btrim(target_book_slug))
  limit 1;

  if not found then
    return;
  end if;

  book_id := hierarchy.resolved_book_id;
  book_slug := hierarchy.resolved_book_slug;
  book_title := hierarchy.resolved_book_title;
  effective_visibility := hierarchy.resolved_visibility;

  if not hierarchy.hierarchy_active then
    allowed := false;
    reason := 'unavailable';
    return next;
    return;
  end if;

  if target_user_id is not null then
    select profile.role
    into viewer_role
    from public.profiles profile
    where profile.id = target_user_id
    limit 1;
  end if;

  if viewer_role in ('admin', 'super_admin') then
    allowed := true;
    reason := 'admin';
    return next;
    return;
  end if;

  if effective_visibility = 'public' then
    allowed := true;
    reason := 'public';
    return next;
    return;
  end if;

  if effective_visibility = 'private' then
    allowed := false;
    reason := 'unavailable';
    return next;
    return;
  end if;

  if target_user_id is null then
    allowed := false;
    reason := 'login_required';
    return next;
    return;
  end if;

  select exists (
    select 1
    from public.book_access access
    where access.user_id = target_user_id
      and access.book_id = hierarchy.resolved_book_id
      and access.is_visible = true
      and access.can_read = true
      and (access.expires_at is null or access.expires_at > now())
  ) into viewer_has_access;

  allowed := viewer_has_access;
  reason := case when viewer_has_access then 'entitled' else 'access_required' end;
  return next;
end;
$$;

revoke all on function public.greyveil_reader_content_authorization(uuid, text) from public;
revoke all on function public.greyveil_reader_content_authorization(uuid, text) from anon;
revoke all on function public.greyveil_reader_content_authorization(uuid, text) from authenticated;
grant execute on function public.greyveil_reader_content_authorization(uuid, text) to service_role;

commit;

notify pgrst, 'reload schema';
