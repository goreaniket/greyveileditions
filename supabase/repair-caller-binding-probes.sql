-- Greyveil targeted caller-binding repair for browser-visible access probes.
-- Entitlement resolution remains in the existing internal resolver; these
-- wrappers only decide which caller identity may be evaluated.

begin;

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
              (
                paid_order.purchase_type = 'book'
                and paid_order.book_id = target_book_id
              )
              or (
                paid_order.purchase_type = 'series'
                and paid_order.series_id = hierarchy.series_id
              )
              or (
                paid_order.purchase_type = 'collection'
                and paid_order.collection_id = hierarchy.collection_id
              )
            )
        )
      )
  );
$$;

create or replace function public.greyveil_effective_book_access(
  target_user_id uuid,
  target_book_id bigint
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when auth.role() = 'service_role'
      or (
        auth.uid() is not null
        and target_user_id is not distinct from auth.uid()
      )
    then public.greyveil_effective_book_access_internal(
      target_user_id,
      target_book_id
    )
    else false
  end;
$$;

-- Review RLS already calls the browser wrapper with auth.uid(). The trigger
-- needs the internal resolver only for explicitly privileged Admin/service
-- operations that legitimately act on a review owned by another user.
create or replace function public.greyveil_prepare_book_review()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  has_access boolean := false;
begin
  if tg_op = 'INSERT' then
    if auth.role() = 'service_role'
       or (
         new.user_id is distinct from auth.uid()
         and public.greyveil_is_admin() is true
       ) then
      has_access := public.greyveil_effective_book_access_internal(
        new.user_id,
        new.book_id
      );
    else
      if new.user_id is distinct from auth.uid() then
        raise exception 'A review may only be created for the signed-in user.';
      end if;

      has_access := public.greyveil_effective_book_access(new.user_id, new.book_id);
    end if;

    if has_access is distinct from true then
      raise exception 'Valid book access is required to review this book.';
    end if;

    new.moderation_status = 'pending';
    new.moderated_by = null;
    new.moderated_at = null;
  elsif auth.role() is distinct from 'service_role'
        and public.greyveil_is_admin() is distinct from true then
    if new.user_id is distinct from old.user_id
       or new.book_id is distinct from old.book_id then
      raise exception 'Review ownership and book cannot be changed.';
    end if;

    if public.greyveil_effective_book_access(old.user_id, old.book_id) is distinct from true then
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
set search_path = ''
as $$
  select case
    when auth.role() = 'service_role'
      or viewer_id is not distinct from auth.uid()
    then
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
            select 1
            from public.orders paid_order
            where paid_order.user_id = viewer_id
              and paid_order.status = 'paid'
              and (
                (paid_order.purchase_type = 'series' and paid_order.series_id = target_id)
                or (
                  paid_order.purchase_type = 'collection'
                  and exists (
                    select 1
                    from public.series series_item
                    left join public.volumes volume on volume.id = series_item.volume_id
                    where series_item.id = target_id
                      and paid_order.collection_id = coalesce(
                        series_item.collection_id,
                        volume.collection_id
                      )
                  )
                )
              )
          )
        )
        or (
          announcement_audience = 'collection-owner'
          and viewer_id is not null
          and exists (
            select 1
            from public.orders paid_order
            where paid_order.user_id = viewer_id
              and paid_order.status = 'paid'
              and paid_order.purchase_type = 'collection'
              and paid_order.collection_id = target_id
          )
        )
      )
    else false
  end;
$$;

revoke all on function public.greyveil_effective_book_access(uuid, bigint)
  from public, anon, authenticated, service_role;
grant execute on function public.greyveil_effective_book_access(uuid, bigint)
  to authenticated, service_role;

revoke all on function public.greyveil_effective_book_access_internal(uuid, bigint)
  from public, anon, authenticated, service_role;
grant execute on function public.greyveil_effective_book_access_internal(uuid, bigint)
  to service_role;

revoke all on function public.greyveil_announcement_visible(
  uuid, text, uuid, boolean, timestamptz, timestamptz
) from public, anon, authenticated, service_role;
grant execute on function public.greyveil_announcement_visible(
  uuid, text, uuid, boolean, timestamptz, timestamptz
) to anon, authenticated, service_role;

commit;

notify pgrst, 'reload schema';
