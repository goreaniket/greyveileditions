-- Greyveil targeted repair: a purchase-sourced book_access row remains valid
-- only while a matching direct-Book order is still paid. Manual and other
-- non-purchase grants retain their existing behavior.

begin;

create or replace function public.greyveil_valid_book_access_grant(
  target_user_id uuid,
  target_book_id bigint
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.book_access access
    where access.user_id = target_user_id
      and access.book_id = target_book_id
      and access.is_visible = true
      and access.can_read = true
      and (access.expires_at is null or access.expires_at > now())
      and (
        lower(access.access_type) is distinct from 'purchase'
        or exists (
          select 1
          from public.orders source_order
          where source_order.user_id = access.user_id
            and source_order.status = 'paid'
            and coalesce(
              lower(source_order.purchase_type),
              case
                when source_order.book_id is not null
                  and source_order.series_id is null
                  and source_order.collection_id is null
                then 'book'
              end
            ) = 'book'
            and source_order.book_id = access.book_id
        )
      )
  );
$$;

-- Phase 1B2's internal effective-access implementation remains the canonical
-- browser/review dependency. Only its book_access branch is centralized here.
create or replace function public.greyveil_effective_book_access_internal(
  target_user_id uuid,
  target_book_id bigint
)
returns boolean
language sql
stable
security definer
set search_path = ''
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
      coalesce(
        book.visibility,
        case when book.is_public then 'public' else 'paid' end
      ) as book_visibility,
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
          select 1
          from public.profiles profile
          where profile.id = target_user_id
            and profile.role in ('admin', 'super_admin')
        )
        or (
          hierarchy.book_visibility = 'public'
          and hierarchy.series_visibility = 'public'
          and hierarchy.volume_visibility = 'public'
          and hierarchy.collection_visibility = 'public'
        )
        or public.greyveil_valid_book_access_grant(
          target_user_id,
          target_book_id
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

-- Preserve the currently deployed Reader resolver, including the earlier
-- paid-source validation for temporary Pass activations.
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
    series_item.id as resolved_series_id,
    coalesce(series_item.collection_id, volume.collection_id) as resolved_collection_id,
    coalesce(book.is_active, true)
      and coalesce(series_item.is_active, true)
      and coalesce(volume.is_active, true)
      and coalesce(collection_item.is_active, true) as hierarchy_active,
    case
      when lower(coalesce(book.visibility, '')) = 'private' then 'private'
      when coalesce(book.is_public, false)
        or lower(coalesce(book.visibility, '')) = 'public' then 'public'
      when lower(coalesce(series_item.visibility, 'public')) = 'private'
        or lower(coalesce(volume.visibility, 'public')) = 'private'
        or lower(coalesce(collection_item.visibility, 'public')) = 'private' then 'private'
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

  select
    public.greyveil_valid_book_access_grant(
      target_user_id,
      hierarchy.resolved_book_id
    )
    or exists (
      select 1
      from public.orders paid_order
      where paid_order.user_id = target_user_id
        and paid_order.status = 'paid'
        and (
          (
            paid_order.purchase_type = 'book'
            and paid_order.book_id = hierarchy.resolved_book_id
          )
          or (
            paid_order.purchase_type = 'series'
            and paid_order.series_id = hierarchy.resolved_series_id
          )
          or (
            paid_order.purchase_type = 'collection'
            and paid_order.collection_id = hierarchy.resolved_collection_id
          )
        )
    )
    or exists (
      select 1
      from public.temporary_access_pass_activations activation
      join public.temporary_access_passes pass_row on pass_row.id = activation.pass_id
      join public.orders activation_order on activation_order.id = activation.order_id
      where activation.user_id = target_user_id
        and activation.expires_at > now()
        and activation_order.user_id = target_user_id
        and activation_order.status = 'paid'
        and activation_order.purchase_type = 'pass'
        and activation_order.temporary_access_pass_id = activation.pass_id
        and (
          pass_row.scope_type = 'library'
          or (
            pass_row.scope_type = 'collection'
            and pass_row.collection_id = hierarchy.resolved_collection_id
          )
        )
    )
  into viewer_has_access;

  allowed := viewer_has_access;
  reason := case when viewer_has_access then 'entitled' else 'access_required' end;
  return next;
end;
$$;

-- Some environments include the later hierarchical resolver and some do not.
-- Patch it only where already installed; this does not install its migration.
do $repair$
begin
  if to_regprocedure('public.greyveil_resolve_book_access(uuid,bigint)') is not null then
    execute $function$
      create or replace function public.greyveil_resolve_book_access(
        target_user_id uuid,
        target_book_id bigint
      )
      returns table (allowed boolean, access_state text)
      language plpgsql
      stable
      security definer
      set search_path = public
      as $body$
      declare
        hierarchy record;
        viewer_role text;
      begin
        select
          book.id as book_id,
          book.series_id,
          coalesce(series_item.collection_id, volume.collection_id) as collection_id,
          coalesce(book.is_active, true) as book_active,
          coalesce(series_item.is_active, true) as series_active,
          coalesce(volume.is_active, true) as volume_active,
          coalesce(collection_item.is_active, true) as collection_active,
          case
            when lower(coalesce(book.visibility, '')) = 'private' then 'private'
            when coalesce(book.is_public, false)
              or lower(coalesce(book.visibility, '')) = 'public' then 'public'
            when lower(coalesce(series_item.visibility, 'public')) = 'private'
              or lower(coalesce(volume.visibility, 'public')) = 'private'
              or lower(coalesce(collection_item.visibility, 'public')) = 'private' then 'private'
            else 'paid'
          end as visibility
        into hierarchy
        from public.books book
        left join public.series series_item on series_item.id = book.series_id
        left join public.volumes volume on volume.id = series_item.volume_id
        left join public.collections collection_item
          on collection_item.id = coalesce(series_item.collection_id, volume.collection_id)
        where book.id = target_book_id;

        if not found
           or not hierarchy.book_active
           or not hierarchy.series_active
           or not hierarchy.volume_active
           or not hierarchy.collection_active then
          allowed := false;
          access_state := 'NO_ACCESS';
          return next;
          return;
        end if;

        if target_user_id is not null then
          select role into viewer_role
          from public.profiles
          where id = target_user_id;
        end if;

        if viewer_role in ('admin', 'super_admin') then
          allowed := true;
          access_state := 'ADMIN_ACCESS';
          return next;
          return;
        end if;

        if hierarchy.visibility = 'public' then
          allowed := true;
          access_state := 'PUBLIC';
          return next;
          return;
        end if;

        if hierarchy.visibility = 'private' or target_user_id is null then
          allowed := false;
          access_state := 'NO_ACCESS';
          return next;
          return;
        end if;

        if exists (
          select 1
          from public.orders order_row
          where order_row.user_id = target_user_id
            and order_row.status = 'paid'
            and coalesce(
              lower(order_row.purchase_type),
              case
                when order_row.book_id is not null then 'book'
                when order_row.series_id is not null then 'series'
                when order_row.collection_id is not null then 'collection'
              end
            ) = 'book'
            and order_row.book_id = hierarchy.book_id
        ) then
          allowed := true;
          access_state := 'DIRECTLY_OWNED';
          return next;
          return;
        end if;

        if exists (
          select 1
          from public.orders order_row
          where order_row.user_id = target_user_id
            and order_row.status = 'paid'
            and coalesce(
              lower(order_row.purchase_type),
              case
                when order_row.book_id is not null then 'book'
                when order_row.series_id is not null then 'series'
                when order_row.collection_id is not null then 'collection'
              end
            ) = 'series'
            and order_row.series_id = hierarchy.series_id
        ) then
          allowed := true;
          access_state := 'SERIES_OWNED';
          return next;
          return;
        end if;

        if hierarchy.collection_id is not null and exists (
          select 1
          from public.orders order_row
          where order_row.user_id = target_user_id
            and order_row.status = 'paid'
            and coalesce(
              lower(order_row.purchase_type),
              case
                when order_row.book_id is not null then 'book'
                when order_row.series_id is not null then 'series'
                when order_row.collection_id is not null then 'collection'
              end
            ) = 'collection'
            and order_row.collection_id = hierarchy.collection_id
        ) then
          allowed := true;
          access_state := 'COLLECTION_OWNED';
          return next;
          return;
        end if;

        if public.greyveil_valid_book_access_grant(target_user_id, hierarchy.book_id) then
          allowed := true;
          access_state := 'MANUAL_GRANT';
          return next;
          return;
        end if;

        if exists (
          select 1
          from public.catalog_access_grants grant_row
          where grant_row.user_id = target_user_id
            and grant_row.is_visible
            and grant_row.can_read
            and (grant_row.expires_at is null or grant_row.expires_at > now())
            and (
              (grant_row.target_type = 'book' and grant_row.book_id = hierarchy.book_id)
              or (grant_row.target_type = 'series' and grant_row.series_id = hierarchy.series_id)
              or (grant_row.target_type = 'collection' and grant_row.collection_id = hierarchy.collection_id)
            )
        ) then
          allowed := true;
          access_state := 'MANUAL_GRANT';
          return next;
          return;
        end if;

        if exists (
          select 1
          from public.temporary_access_pass_activations activation
          join public.temporary_access_passes pass_row on pass_row.id = activation.pass_id
          where activation.user_id = target_user_id
            and activation.expires_at > now()
            and (
              pass_row.scope_type = 'library'
              or (
                pass_row.scope_type = 'collection'
                and pass_row.collection_id = hierarchy.collection_id
              )
            )
        ) then
          allowed := true;
          access_state := 'TEMPORARY_PASS';
          return next;
          return;
        end if;

        allowed := false;
        access_state := 'NO_ACCESS';
        return next;
      end;
      $body$;
    $function$;

    execute 'revoke all on function public.greyveil_resolve_book_access(uuid, bigint) from public, anon, authenticated, service_role';
    execute 'grant execute on function public.greyveil_resolve_book_access(uuid, bigint) to service_role';
  end if;
end;
$repair$;

revoke all on function public.greyveil_valid_book_access_grant(uuid, bigint)
  from public, anon, authenticated, service_role;
grant execute on function public.greyveil_valid_book_access_grant(uuid, bigint)
  to service_role;

revoke all on function public.greyveil_effective_book_access_internal(uuid, bigint)
  from public, anon, authenticated, service_role;
grant execute on function public.greyveil_effective_book_access_internal(uuid, bigint)
  to service_role;

revoke all on function public.greyveil_reader_content_authorization(uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.greyveil_reader_content_authorization(uuid, text)
  to service_role;

commit;

notify pgrst, 'reload schema';
