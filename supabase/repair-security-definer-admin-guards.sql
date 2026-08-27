-- Greyveil targeted SECURITY DEFINER repair for browser-facing Admin RPCs.
-- This migration replaces only authorization guards and resets function ACLs.

begin;

create or replace function public.greyveil_admin_create_generation_job(
  target_book_id bigint default null
)
returns public.book_generation_jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  job public.book_generation_jobs;
begin
  if public.greyveil_is_admin() is distinct from true then
    raise exception 'Admin access required.' using errcode = '42501';
  end if;

  if target_book_id is not null
     and not exists (select 1 from public.books where id = target_book_id) then
    raise exception 'Book was not found.';
  end if;

  insert into public.book_generation_jobs (requested_by, book_id, operation)
  values (
    auth.uid(),
    target_book_id,
    case when target_book_id is null then 'create' else 'regenerate' end
  )
  returning * into job;

  return job;
end;
$$;

create or replace function public.greyveil_admin_request_generation_detection(
  target_job_id uuid,
  target_manuscript_path text,
  target_cover_path text default null
)
returns public.book_generation_jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  job public.book_generation_jobs;
begin
  if public.greyveil_is_admin() is distinct from true then
    raise exception 'Admin access required.' using errcode = '42501';
  end if;

  if target_manuscript_path !~ '^jobs/[0-9a-f-]+/manuscript\.docx$' then
    raise exception 'Invalid manuscript input.';
  end if;

  update public.book_generation_jobs
  set manuscript_path = target_manuscript_path,
      cover_path = nullif(target_cover_path, ''),
      status = 'QUEUED',
      progress = 0,
      error = null,
      started_at = null,
      completed_at = null,
      worker_token = null,
      claimed_at = null,
      heartbeat_at = null
  where id = target_job_id
    and status = 'DRAFT'
  returning * into job;

  if not found then
    raise exception 'This job cannot be prepared for detection.' using errcode = '23514';
  end if;

  return job;
end;
$$;

create or replace function public.greyveil_admin_cancel_generation_job(
  target_job_id uuid
)
returns public.book_generation_jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  job public.book_generation_jobs;
begin
  if public.greyveil_is_admin() is distinct from true then
    raise exception 'Admin access required.' using errcode = '42501';
  end if;

  update public.book_generation_jobs
  set status = 'CANCELLED',
      completed_at = now()
  where id = target_job_id
    and status in ('DRAFT', 'QUEUED', 'AWAITING_REVIEW', 'FAILED')
  returning * into job;

  if not found then
    raise exception 'This job cannot be cancelled.' using errcode = '23514';
  end if;

  return job;
end;
$$;

create or replace function public.greyveil_admin_publish_generation_job(
  target_job_id uuid
)
returns public.book_generation_jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  job public.book_generation_jobs;
begin
  if public.greyveil_is_admin() is distinct from true then
    raise exception 'Admin access required.' using errcode = '42501';
  end if;

  select * into job
  from public.book_generation_jobs
  where id = target_job_id
  for update;

  if not found then
    raise exception 'Generation job was not found.';
  end if;

  if job.status <> 'READY_TO_PUBLISH'
     or coalesce((job.qa->>'ok')::boolean, false) is not true
     or job.book_id is null then
    raise exception 'Only a successful candidate with a book record can be published.' using errcode = '23514';
  end if;

  update public.book_generation_jobs
  set status = 'PUBLISH_REQUESTED',
      progress = 100
  where id = target_job_id
  returning * into job;

  return job;
end;
$$;

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
  if public.greyveil_is_admin() is distinct from true then
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
  if public.greyveil_is_admin() is distinct from true then
    raise exception 'Admin access required.' using errcode = '42501';
  end if;

  if normalized_visibility is null
      or normalized_visibility not in ('public', 'paid', 'private') then
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

create or replace function public.greyveil_admin_set_book_series(
  target_book_id bigint,
  target_series_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.greyveil_is_admin() is distinct from true then
    raise exception 'Admin access required.' using errcode = '42501';
  end if;

  update public.books
  set series_id = target_series_id
  where id = target_book_id;

  if not found then
    raise exception 'Book was not found.';
  end if;
end;
$$;

create or replace function public.greyveil_admin_set_series_collection(
  target_series_id uuid,
  target_collection_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.greyveil_is_admin() is distinct from true then
    raise exception 'Admin access required.' using errcode = '42501';
  end if;

  update public.series
  set collection_id = target_collection_id
  where id = target_series_id;

  if not found then
    raise exception 'Series was not found.';
  end if;
end;
$$;

create or replace function public.greyveil_admin_payment_customers()
returns table (
  id uuid,
  display_name text,
  email text
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if public.greyveil_is_admin() is distinct from true then
    raise exception 'Admin access required.' using errcode = '42501';
  end if;

  return query
  select distinct
    account.id,
    profile.display_name,
    account.email::text
  from auth.users account
  join public.orders payment_order on payment_order.user_id = account.id
  left join public.profiles profile on profile.id = account.id;
end;
$$;

revoke all on function public.greyveil_admin_create_generation_job(bigint) from public, anon, authenticated;
revoke all on function public.greyveil_admin_request_generation_detection(uuid, text, text) from public, anon, authenticated;
revoke all on function public.greyveil_admin_cancel_generation_job(uuid) from public, anon, authenticated;
revoke all on function public.greyveil_admin_publish_generation_job(uuid) from public, anon, authenticated;
revoke all on function public.greyveil_admin_update_catalog_price(text, text, integer) from public, anon, authenticated;
revoke all on function public.greyveil_admin_update_catalog_visibility(text, text, text) from public, anon, authenticated;
revoke all on function public.greyveil_admin_set_book_series(bigint, uuid) from public, anon, authenticated;
revoke all on function public.greyveil_admin_set_series_collection(uuid, uuid) from public, anon, authenticated;
revoke all on function public.greyveil_admin_payment_customers() from public, anon, authenticated;

grant execute on function public.greyveil_admin_create_generation_job(bigint) to authenticated;
grant execute on function public.greyveil_admin_request_generation_detection(uuid, text, text) to authenticated;
grant execute on function public.greyveil_admin_cancel_generation_job(uuid) to authenticated;
grant execute on function public.greyveil_admin_publish_generation_job(uuid) to authenticated;
grant execute on function public.greyveil_admin_update_catalog_price(text, text, integer) to authenticated;
grant execute on function public.greyveil_admin_update_catalog_visibility(text, text, text) to authenticated;
grant execute on function public.greyveil_admin_set_book_series(bigint, uuid) to authenticated;
grant execute on function public.greyveil_admin_set_series_collection(uuid, uuid) to authenticated;
grant execute on function public.greyveil_admin_payment_customers() to authenticated;

revoke all on function public.greyveil_current_role() from public, anon, authenticated;
revoke all on function public.greyveil_is_admin() from public, anon, authenticated;
revoke all on function public.greyveil_is_super_admin() from public, anon, authenticated;

grant execute on function public.greyveil_current_role() to authenticated;
grant execute on function public.greyveil_is_admin() to authenticated;
grant execute on function public.greyveil_is_super_admin() to authenticated;

commit;

notify pgrst, 'reload schema';
