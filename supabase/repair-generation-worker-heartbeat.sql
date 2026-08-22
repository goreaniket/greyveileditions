begin;

-- Step 13B3 targeted repair: renew only a currently active claim owned by the
-- exact service-role worker token. Returning false distinguishes claim loss
-- from a transport failure without granting direct table access.
create or replace function public.greyveil_worker_heartbeat_generation_job(
  target_job_id uuid,
  claim_token uuid
)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  if auth.role() <> 'service_role' then
    raise exception 'Trusted worker access required.' using errcode = '42501';
  end if;

  update public.book_generation_jobs
  set heartbeat_at = now()
  where id = target_job_id
    and worker_token = claim_token
    and status in (
      'IMPORTING',
      'NORMALIZING',
      'VALIDATING_SOURCE',
      'GENERATING_PDF',
      'GENERATING_EPUB',
      'GENERATING_DOCX',
      'VALIDATING_OUTPUTS',
      'PUBLISH_REQUESTED'
    );

  return found;
end;
$$;

revoke all on function public.greyveil_worker_heartbeat_generation_job(uuid, uuid) from public;
revoke all on function public.greyveil_worker_heartbeat_generation_job(uuid, uuid) from anon;
revoke all on function public.greyveil_worker_heartbeat_generation_job(uuid, uuid) from authenticated;
grant execute on function public.greyveil_worker_heartbeat_generation_job(uuid, uuid) to service_role;

commit;

notify pgrst, 'reload schema';
