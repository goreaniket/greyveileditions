begin;

-- Step 13B1 targeted repair: keep the existing RPC signature and privileges,
-- but prevent an Admin retry from rewinding an active or publishable job.
create or replace function public.greyveil_admin_queue_generation_job(
  target_job_id uuid, target_manuscript_path text, target_cover_path text,
  target_metadata jsonb, target_design_source_slug text, target_series_id uuid,
  target_collection_id uuid, target_book_number integer, target_visibility text, target_price_amount integer
)
returns public.book_generation_jobs language plpgsql security definer set search_path = public as $$
declare
  job public.book_generation_jobs;
  clean_cover_path text;
  clean_design_source_slug text;
  clean_slug text;
  expected_manuscript_path text;
begin
  if not public.greyveil_is_admin() then
    raise exception 'Admin access required.' using errcode = '42501';
  end if;

  select * into job
  from public.book_generation_jobs
  where id = target_job_id
  for update;

  if not found then
    raise exception 'Generation job was not found.';
  end if;

  if job.status not in ('DRAFT', 'AWAITING_REVIEW', 'FAILED', 'CANCELLED') or job.worker_token is not null then
    raise exception 'This generation job cannot be queued from its current state.' using errcode = '23514';
  end if;

  expected_manuscript_path := format('jobs/%s/manuscript.docx', target_job_id::text);
  if target_manuscript_path is distinct from expected_manuscript_path then
    raise exception 'Manuscript input is not bound to this generation job.' using errcode = '23514';
  end if;

  clean_cover_path := nullif(btrim(target_cover_path), '');
  if clean_cover_path is not null
     and clean_cover_path !~ ('^jobs/' || target_job_id::text || '/cover[.](png|jpe?g|webp)$') then
    raise exception 'Cover input is not bound to this generation job.' using errcode = '23514';
  end if;

  clean_design_source_slug := coalesce(nullif(lower(btrim(target_design_source_slug)), ''), 'the-last-shift');
  if clean_design_source_slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$' then
    raise exception 'Design-source slug is unsafe.' using errcode = '23514';
  end if;

  if job.book_id is not null then
    select lower(btrim(books.slug)) into clean_slug
    from public.books
    where books.id = job.book_id;
    if not found then
      raise exception 'Existing Book canonical slug could not be resolved.';
    end if;
  else
    clean_slug := lower(btrim(coalesce(target_metadata->>'slug', '')));
  end if;

  if clean_slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$' then
    raise exception 'The authoritative generation slug is missing or unsafe.' using errcode = '23514';
  end if;
  if coalesce(nullif(btrim(target_metadata->>'title'), ''), '') = '' then
    raise exception 'Title is required.' using errcode = '23514';
  end if;
  if target_visibility not in ('public', 'paid', 'private') then
    raise exception 'Unsupported visibility.';
  end if;
  if target_visibility = 'paid' and coalesce(target_price_amount, 0) <= 0 then
    raise exception 'Paid books require a positive price.';
  end if;

  update public.book_generation_jobs
  set manuscript_path = expected_manuscript_path,
      cover_path = clean_cover_path,
      metadata = jsonb_set(coalesce(target_metadata, '{}'::jsonb), '{slug}', to_jsonb(clean_slug), true),
      design_source_slug = clean_design_source_slug,
      series_id = target_series_id,
      collection_id = target_collection_id,
      book_number = target_book_number,
      visibility = target_visibility,
      price_amount = target_price_amount,
      status = 'QUEUED',
      progress = 0,
      error = null,
      warnings = '[]'::jsonb,
      qa = '{}'::jsonb,
      candidate = '{}'::jsonb,
      stage_history = '[]'::jsonb,
      started_at = null,
      completed_at = null,
      worker_token = null,
      claimed_at = null,
      heartbeat_at = null
  where id = target_job_id
    and status in ('DRAFT', 'AWAITING_REVIEW', 'FAILED', 'CANCELLED')
    and worker_token is null
  returning * into job;

  if not found then
    raise exception 'This generation job cannot be queued from its current state.' using errcode = '23514';
  end if;
  return job;
end;
$$;

commit;
