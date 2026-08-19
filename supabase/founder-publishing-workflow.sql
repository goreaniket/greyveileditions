-- Founder publishing workflow. Apply after hierarchical-commerce-access.sql.
-- Jobs are durable; a separately deployed worker, never a browser request,
-- performs DOCX import and format generation.
begin;

create table if not exists public.book_generation_jobs (
  id uuid primary key default gen_random_uuid(),
  requested_by uuid not null references auth.users(id) on delete restrict,
  book_id bigint references public.books(id) on delete set null,
  operation text not null default 'create' check (operation in ('create', 'regenerate')),
  status text not null default 'DRAFT' check (status in ('DRAFT', 'QUEUED', 'DETECTING', 'AWAITING_REVIEW', 'IMPORTING', 'NORMALIZING', 'VALIDATING_SOURCE', 'GENERATING_PDF', 'GENERATING_EPUB', 'GENERATING_DOCX', 'VALIDATING_OUTPUTS', 'READY_TO_PUBLISH', 'PUBLISH_REQUESTED', 'PUBLISHED', 'CANCELLED', 'FAILED')),
  progress smallint not null default 0 check (progress between 0 and 100),
  manuscript_path text,
  cover_path text,
  design_source_slug text not null default 'the-last-shift',
  metadata jsonb not null default '{}'::jsonb,
  series_id uuid references public.series(id) on delete restrict,
  collection_id uuid references public.collections(id) on delete restrict,
  book_number integer,
  visibility text not null default 'paid' check (visibility in ('public', 'paid', 'private')),
  price_amount integer check (price_amount is null or price_amount > 0),
  qa jsonb not null default '{}'::jsonb,
  candidate jsonb not null default '{}'::jsonb,
  stage_history jsonb not null default '[]'::jsonb,
  error text,
  warnings jsonb not null default '[]'::jsonb,
  retry_count integer not null default 0 check (retry_count >= 0),
  started_at timestamptz,
  completed_at timestamptz,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists book_generation_jobs_recent_idx on public.book_generation_jobs (created_at desc);
create index if not exists book_generation_jobs_status_idx on public.book_generation_jobs (status, created_at);
alter table public.book_generation_jobs add column if not exists worker_token uuid;
alter table public.book_generation_jobs add column if not exists claimed_at timestamptz;
alter table public.book_generation_jobs add column if not exists heartbeat_at timestamptz;
create index if not exists book_generation_jobs_claim_idx on public.book_generation_jobs (status, heartbeat_at, created_at);

create or replace function public.greyveil_touch_generation_job()
returns trigger language plpgsql as $$ begin new.updated_at = now(); return new; end; $$;
drop trigger if exists touch_book_generation_jobs on public.book_generation_jobs;
create trigger touch_book_generation_jobs before update on public.book_generation_jobs
for each row execute function public.greyveil_touch_generation_job();

alter table public.book_generation_jobs enable row level security;
drop policy if exists "Admins read generation jobs" on public.book_generation_jobs;
create policy "Admins read generation jobs" on public.book_generation_jobs for select to authenticated using (public.greyveil_is_admin());

-- The worker functions are intentionally service-role only.  The claim uses
-- SKIP LOCKED so separate worker processes cannot process the same job.
create or replace function public.greyveil_worker_claim_generation_job(claim_token uuid, target_job_id uuid default null)
returns setof public.book_generation_jobs language plpgsql security definer set search_path = public as $$
declare claimed public.book_generation_jobs;
begin
  if auth.role() <> 'service_role' then raise exception 'Trusted worker access required.' using errcode = '42501'; end if;
  with next_job as (
    select id from public.book_generation_jobs
    where (target_job_id is null or id = target_job_id)
      and (
        (worker_token is null and status in ('QUEUED', 'PUBLISH_REQUESTED'))
        or (heartbeat_at < now() - interval '30 minutes' and status in ('IMPORTING', 'NORMALIZING', 'VALIDATING_SOURCE', 'GENERATING_PDF', 'GENERATING_EPUB', 'GENERATING_DOCX', 'VALIDATING_OUTPUTS', 'PUBLISH_REQUESTED'))
      )
    order by created_at asc
    for update skip locked limit 1
  )
  update public.book_generation_jobs job
  set worker_token = claim_token, claimed_at = now(), heartbeat_at = now(),
      status = case when job.status = 'QUEUED' then 'IMPORTING' else job.status end,
      started_at = coalesce(job.started_at, now()), completed_at = null
  from next_job where job.id = next_job.id returning job.* into claimed;
  if found then return next claimed; end if;
end;
$$;

-- Storage copies are completed by the worker before this transaction.  This
-- function is the sole canonical-reference switch, so a failed candidate can
-- never replace existing live file or cover records.
create or replace function public.greyveil_worker_finalize_generation_publication(
  target_job_id uuid, claim_token uuid, published_artifacts jsonb
)
returns public.book_generation_jobs language plpgsql security definer set search_path = public as $$
declare job public.book_generation_jobs; item jsonb; artifact_type text;
begin
  if auth.role() <> 'service_role' then raise exception 'Trusted worker access required.' using errcode = '42501'; end if;
  select * into job from public.book_generation_jobs where id = target_job_id for update;
  if not found or job.worker_token is distinct from claim_token then raise exception 'Generation job claim is no longer valid.' using errcode = '42501'; end if;
  if job.status <> 'PUBLISH_REQUESTED' or coalesce((job.qa->>'ok')::boolean, false) is not true or job.book_id is null then
    raise exception 'Only QA-approved candidates can be published.' using errcode = '23514';
  end if;
  foreach artifact_type in array array['pdf', 'epub', 'docx', 'source', 'cover'] loop
    item := published_artifacts -> artifact_type;
    if item is null
      or item->>'path' !~ ('^published/[a-z0-9-]+/' || target_job_id::text || '/' || artifact_type || '/')
      or nullif(item->>'file_name', '') is null
      or coalesce((item->>'file_size')::bigint, -1) < 0 then
      raise exception 'Published artifact % is incomplete or unsafe.', artifact_type using errcode = '23514';
    end if;
  end loop;
  if job.candidate->'qa' is null or job.candidate->'qa'->>'path' !~ ('^jobs/' || target_job_id::text || '/qa/') then
    raise exception 'Candidate QA evidence is missing or unsafe.' using errcode = '23514';
  end if;
  insert into public.book_files (book_id, file_type, storage_path, file_name, mime_type, file_size)
  select job.book_id, entry.key, entry.value->>'path', entry.value->>'file_name', entry.value->>'mime_type', (entry.value->>'file_size')::bigint
  from jsonb_each(published_artifacts) entry where entry.key in ('pdf', 'epub', 'docx', 'source')
  on conflict (book_id, file_type) do update set storage_path = excluded.storage_path, file_name = excluded.file_name,
    mime_type = excluded.mime_type, file_size = excluded.file_size, updated_at = now();
  insert into public.book_covers (book_id, cover_type, storage_path, file_name, mime_type, file_size)
  values (job.book_id, 'front_cover', published_artifacts->'cover'->>'path', published_artifacts->'cover'->>'file_name',
    published_artifacts->'cover'->>'mime_type', (published_artifacts->'cover'->>'file_size')::bigint)
  on conflict (book_id, cover_type) do update set storage_path = excluded.storage_path, file_name = excluded.file_name,
    mime_type = excluded.mime_type, file_size = excluded.file_size, updated_at = now();
  update public.books set visibility = job.visibility, is_public = job.visibility = 'public', is_active = true,
    price_amount = job.price_amount, series_id = coalesce(job.series_id, series_id), book_number = coalesce(job.book_number, book_number)
  where id = job.book_id;
  update public.book_generation_jobs set status = 'PUBLISHED', progress = 100, published_at = now(), completed_at = now(),
    heartbeat_at = now(), worker_token = null,
    candidate = job.candidate || jsonb_build_object('published', published_artifacts)
  where id = target_job_id returning * into job;
  return job;
end;
$$;

-- Browser mutations are narrow admin RPCs. The service-role worker alone can
-- write runtime, candidate, warning, and QA fields.
create or replace function public.greyveil_admin_create_generation_job(target_book_id bigint default null)
returns public.book_generation_jobs language plpgsql security definer set search_path = public as $$
declare job public.book_generation_jobs;
begin
  if not public.greyveil_is_admin() then raise exception 'Admin access required.' using errcode = '42501'; end if;
  if target_book_id is not null and not exists (select 1 from public.books where id = target_book_id) then raise exception 'Book was not found.'; end if;
  insert into public.book_generation_jobs (requested_by, book_id, operation)
  values (auth.uid(), target_book_id, case when target_book_id is null then 'create' else 'regenerate' end)
  returning * into job;
  return job;
end;
$$;

create or replace function public.greyveil_admin_queue_generation_job(
  target_job_id uuid, target_manuscript_path text, target_cover_path text,
  target_metadata jsonb, target_design_source_slug text, target_series_id uuid,
  target_collection_id uuid, target_book_number integer, target_visibility text, target_price_amount integer
)
returns public.book_generation_jobs language plpgsql security definer set search_path = public as $$
declare job public.book_generation_jobs; clean_slug text;
begin
  if not public.greyveil_is_admin() then raise exception 'Admin access required.' using errcode = '42501'; end if;
  clean_slug := lower(btrim(coalesce(target_metadata->>'slug', '')));
  if target_manuscript_path !~ '^jobs/[0-9a-f-]+/manuscript\.docx$' then raise exception 'Invalid manuscript input.'; end if;
  if clean_slug = '' or coalesce(nullif(btrim(target_metadata->>'title'), ''), '') = '' then raise exception 'Title and slug are required.'; end if;
  if target_visibility not in ('public', 'paid', 'private') then raise exception 'Unsupported visibility.'; end if;
  if target_visibility = 'paid' and coalesce(target_price_amount, 0) <= 0 then raise exception 'Paid books require a positive price.'; end if;
  update public.book_generation_jobs set manuscript_path = target_manuscript_path, cover_path = nullif(target_cover_path, ''),
    metadata = target_metadata, design_source_slug = coalesce(nullif(target_design_source_slug, ''), 'the-last-shift'),
    series_id = target_series_id, collection_id = target_collection_id, book_number = target_book_number,
    visibility = target_visibility, price_amount = target_price_amount, status = 'QUEUED', progress = 0,
    error = null, warnings = '[]'::jsonb, qa = '{}'::jsonb, candidate = '{}'::jsonb, stage_history = '[]'::jsonb,
    started_at = null, completed_at = null, worker_token = null, claimed_at = null, heartbeat_at = null
  where id = target_job_id returning * into job;
  if not found then raise exception 'Generation job was not found.'; end if;
  return job;
end;
$$;

create or replace function public.greyveil_admin_request_generation_detection(target_job_id uuid, target_manuscript_path text, target_cover_path text default null)
returns public.book_generation_jobs language plpgsql security definer set search_path = public as $$
declare job public.book_generation_jobs;
begin
  if not public.greyveil_is_admin() then raise exception 'Admin access required.' using errcode = '42501'; end if;
  if target_manuscript_path !~ '^jobs/[0-9a-f-]+/manuscript\.docx$' then raise exception 'Invalid manuscript input.'; end if;
  update public.book_generation_jobs set manuscript_path = target_manuscript_path, cover_path = nullif(target_cover_path, ''),
    status = 'QUEUED', progress = 0, error = null, started_at = null, completed_at = null,
    worker_token = null, claimed_at = null, heartbeat_at = null
  where id = target_job_id and status = 'DRAFT' returning * into job;
  if not found then raise exception 'This job cannot be prepared for detection.' using errcode = '23514'; end if;
  return job;
end;
$$;

create or replace function public.greyveil_admin_cancel_generation_job(target_job_id uuid)
returns public.book_generation_jobs language plpgsql security definer set search_path = public as $$
declare job public.book_generation_jobs;
begin
  if not public.greyveil_is_admin() then raise exception 'Admin access required.' using errcode = '42501'; end if;
  update public.book_generation_jobs set status = 'CANCELLED', completed_at = now()
  where id = target_job_id and status in ('DRAFT', 'QUEUED', 'AWAITING_REVIEW', 'FAILED') returning * into job;
  if not found then raise exception 'This job cannot be cancelled.' using errcode = '23514'; end if;
  return job;
end;
$$;

create or replace function public.greyveil_admin_publish_generation_job(target_job_id uuid)
returns public.book_generation_jobs language plpgsql security definer set search_path = public as $$
declare job public.book_generation_jobs;
begin
  if not public.greyveil_is_admin() then raise exception 'Admin access required.' using errcode = '42501'; end if;
  select * into job from public.book_generation_jobs where id = target_job_id for update;
  if not found then raise exception 'Generation job was not found.'; end if;
  if job.status <> 'READY_TO_PUBLISH' or coalesce((job.qa->>'ok')::boolean, false) is not true or job.book_id is null then
    raise exception 'Only a successful candidate with a book record can be published.' using errcode = '23514';
  end if;
  -- This only authorizes a publish request. The trusted worker verifies and
  -- copies private candidate artifacts before atomically switching live records.
  update public.book_generation_jobs set status = 'PUBLISH_REQUESTED', progress = 100
  where id = target_job_id returning * into job;
  return job;
end;
$$;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('generation-inputs', 'generation-inputs', false, 83886080,
  array['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'image/png', 'image/jpeg', 'image/webp']::text[])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;
drop policy if exists "Admins manage generation inputs" on storage.objects;
create policy "Admins manage generation inputs" on storage.objects for all to authenticated
using (bucket_id = 'generation-inputs' and public.greyveil_is_admin())
with check (bucket_id = 'generation-inputs' and public.greyveil_is_admin());

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('generation-candidates', 'generation-candidates', false, 125829120,
  array['application/pdf', 'application/epub+zip', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/zip', 'application/json', 'image/png', 'image/jpeg', 'image/webp']::text[])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;
drop policy if exists "Admins read generation candidates" on storage.objects;
create policy "Admins read generation candidates" on storage.objects for select to authenticated
using (bucket_id = 'generation-candidates' and public.greyveil_is_admin());

revoke all on function public.greyveil_admin_create_generation_job(bigint) from public;
revoke all on function public.greyveil_admin_queue_generation_job(uuid, text, text, jsonb, text, uuid, uuid, integer, text, integer) from public;
revoke all on function public.greyveil_admin_request_generation_detection(uuid, text, text) from public;
revoke all on function public.greyveil_admin_cancel_generation_job(uuid) from public;
revoke all on function public.greyveil_admin_publish_generation_job(uuid) from public;
revoke all on function public.greyveil_worker_claim_generation_job(uuid, uuid) from public;
revoke all on function public.greyveil_worker_claim_generation_job(uuid, uuid) from anon;
revoke all on function public.greyveil_worker_claim_generation_job(uuid, uuid) from authenticated;
revoke all on function public.greyveil_worker_finalize_generation_publication(uuid, uuid, jsonb) from public;
revoke all on function public.greyveil_worker_finalize_generation_publication(uuid, uuid, jsonb) from anon;
revoke all on function public.greyveil_worker_finalize_generation_publication(uuid, uuid, jsonb) from authenticated;
grant execute on function public.greyveil_admin_create_generation_job(bigint) to authenticated;
grant execute on function public.greyveil_admin_queue_generation_job(uuid, text, text, jsonb, text, uuid, uuid, integer, text, integer) to authenticated;
grant execute on function public.greyveil_admin_request_generation_detection(uuid, text, text) to authenticated;
grant execute on function public.greyveil_admin_cancel_generation_job(uuid) to authenticated;
grant execute on function public.greyveil_admin_publish_generation_job(uuid) to authenticated;
grant execute on function public.greyveil_worker_claim_generation_job(uuid, uuid) to service_role;
grant execute on function public.greyveil_worker_finalize_generation_publication(uuid, uuid, jsonb) to service_role;
commit;
notify pgrst, 'reload schema';
