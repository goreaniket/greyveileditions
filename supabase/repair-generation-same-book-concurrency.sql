-- Greyveil targeted repair: one non-terminal generation job per existing Book.
-- New-Book jobs retain a NULL book_id until the private candidate Book exists.

begin;

do $$
begin
  if exists (
    select 1
    from public.book_generation_jobs
    where book_id is not null
      and status not in ('PUBLISHED', 'CANCELLED', 'FAILED')
    group by book_id
    having count(*) > 1
  ) then
    raise exception 'Existing Books have multiple active generation jobs; resolve them before applying this repair.'
      using errcode = '23505';
  end if;
end;
$$;

create unique index if not exists book_generation_jobs_one_active_per_book_idx
on public.book_generation_jobs (book_id)
where book_id is not null
  and status not in ('PUBLISHED', 'CANCELLED', 'FAILED');

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

  if target_book_id is not null then
    perform 1
    from public.books
    where id = target_book_id
    for key share;

    if not found then
      raise exception 'Book was not found.';
    end if;
  end if;

  begin
    insert into public.book_generation_jobs (requested_by, book_id, operation)
    values (
      auth.uid(),
      target_book_id,
      case when target_book_id is null then 'create' else 'regenerate' end
    )
    returning * into job;
  exception
    when unique_violation then
      raise exception 'A generation job is already active for this Book.' using errcode = '23505';
  end;

  return job;
end;
$$;

revoke all on function public.greyveil_admin_create_generation_job(bigint) from public, anon, authenticated;
grant execute on function public.greyveil_admin_create_generation_job(bigint) to authenticated;

commit;
notify pgrst, 'reload schema';
