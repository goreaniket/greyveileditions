-- Private reader stories for the Greyveil 2.0 experience.
-- Apply only after the existing Greyveil auth schema and admin helper.

begin;

do $$
begin
  if to_regprocedure('public.greyveil_is_admin()') is null then
    raise exception 'Greyveil 2.0 stories require the existing public.greyveil_is_admin() helper.';
  end if;
end
$$;

create table if not exists public.story_submissions (
  id uuid primary key default gen_random_uuid(),
  author_id uuid not null references auth.users(id) on delete cascade,
  title text not null check (char_length(btrim(title)) between 1 and 120),
  story text not null check (char_length(btrim(story)) between 40 and 6000),
  author_display_name text check (author_display_name is null or char_length(btrim(author_display_name)) <= 80),
  is_anonymous boolean not null default false,
  response_request text not null default 'listening'
    check (response_request in ('listening', 'understanding', 'perspective', 'reflection', 'reading_guidance', 'support_resources')),
  private_consent boolean not null default false check (private_consent),
  private_consent_at timestamptz,
  public_consent boolean not null default false,
  public_consent_at timestamptz,
  status text not null default 'pending' check (status in ('pending', 'in_review', 'responded', 'published', 'declined')),
  moderation_response text check (moderation_response is null or char_length(moderation_response) <= 2000),
  created_at timestamptz not null default now(),
  reviewed_at timestamptz,
  published_at timestamptz,
  constraint story_publication_requires_consent check (status <> 'published' or (public_consent and public_consent_at is not null)),
  constraint story_public_consent_timestamp check (public_consent = (public_consent_at is not null)),
  constraint story_private_consent_timestamp check (private_consent = (private_consent_at is not null))
);

alter table public.story_submissions
  add column if not exists is_anonymous boolean not null default false,
  add column if not exists response_request text not null default 'listening',
  add column if not exists private_consent_at timestamptz,
  add column if not exists public_consent_at timestamptz;

alter table public.story_submissions
  drop constraint if exists story_submissions_status_check,
  drop constraint if exists story_publication_requires_consent,
  drop constraint if exists story_public_consent_timestamp,
  drop constraint if exists story_private_consent_timestamp,
  drop constraint if exists story_published_at_matches_status,
  drop constraint if exists story_response_request_check;

update public.story_submissions
set public_consent_at = case
      when public_consent then coalesce(public_consent_at, reviewed_at, created_at)
      else null
    end,
    private_consent_at = case
      when private_consent then coalesce(private_consent_at, created_at)
      else null
    end,
    published_at = case
      when status = 'published' then coalesce(published_at, reviewed_at, created_at)
      else null
    end;

alter table public.story_submissions
  add constraint story_submissions_status_check
    check (status in ('pending', 'in_review', 'responded', 'published', 'declined')),
  add constraint story_publication_requires_consent
    check (status <> 'published' or (public_consent and public_consent_at is not null)),
  add constraint story_public_consent_timestamp
    check (public_consent = (public_consent_at is not null)),
  add constraint story_private_consent_timestamp
    check (private_consent = (private_consent_at is not null)),
  add constraint story_published_at_matches_status
    check ((status = 'published') = (published_at is not null)),
  add constraint story_response_request_check
    check (response_request in ('listening', 'understanding', 'perspective', 'reflection', 'reading_guidance', 'support_resources'));

create or replace function public.greyveil_record_story_consent()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    if new.private_consent is not true then
      raise exception 'Private review consent is required.';
    end if;
    new.private_consent_at := now();
    new.public_consent_at := case when new.public_consent then now() else null end;
  else
    if new.private_consent is distinct from old.private_consent
      or new.public_consent is distinct from old.public_consent
      or new.is_anonymous is distinct from old.is_anonymous then
      raise exception 'Submission consent and anonymity choices cannot be changed by an editor.';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists greyveil_record_story_consent on public.story_submissions;
create trigger greyveil_record_story_consent
  before insert or update on public.story_submissions
  for each row execute function public.greyveil_record_story_consent();

create table if not exists public.story_publication_withdrawals (
  story_id uuid primary key references public.story_submissions(id) on delete cascade,
  author_id uuid not null references auth.users(id) on delete cascade,
  withdrawn_at timestamptz not null default now()
);

alter table public.story_publication_withdrawals enable row level security;

drop policy if exists "Authors and admins read story publication withdrawals" on public.story_publication_withdrawals;
create policy "Authors and admins read story publication withdrawals"
  on public.story_publication_withdrawals for select to authenticated
  using (author_id = (select auth.uid()) or (select public.greyveil_is_admin()));

drop policy if exists "Authors withdraw story publication consent" on public.story_publication_withdrawals;
create policy "Authors withdraw story publication consent"
  on public.story_publication_withdrawals for insert to authenticated
  with check (
    author_id = (select auth.uid())
    and exists (
      select 1 from public.story_submissions s
      where s.id = story_id
        and s.author_id = (select auth.uid())
        and s.public_consent
    )
  );

revoke all on public.story_publication_withdrawals from public, anon;
grant select, insert on public.story_publication_withdrawals to authenticated;

create or replace function public.greyveil_withdraw_story_publication(p_story_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    raise exception 'Sign in to manage your story.' using errcode = '42501';
  end if;
  insert into public.story_publication_withdrawals (story_id, author_id)
  select s.id, s.author_id
  from public.story_submissions s
  where s.id = p_story_id
    and s.author_id = auth.uid()
    and s.public_consent
  on conflict (story_id) do nothing;
  if not found then
    raise exception 'This story does not have active public-sharing permission.' using errcode = 'P0002';
  end if;
end;
$$;

revoke all on function public.greyveil_withdraw_story_publication(uuid) from public, anon;
grant execute on function public.greyveil_withdraw_story_publication(uuid) to authenticated;

create index if not exists story_submissions_author_created_idx
  on public.story_submissions (author_id, created_at desc);
create index if not exists story_submissions_publication_idx
  on public.story_submissions (published_at desc)
  where status = 'published' and public_consent;

create or replace function public.greyveil_submit_story(
  p_title text,
  p_story text,
  p_author_display_name text default null,
  p_is_anonymous boolean default true,
  p_response_request text default 'listening',
  p_public_consent boolean default false
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  submission_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Sign in to submit a story privately.' using errcode = '42501';
  end if;
  if p_title is null or char_length(btrim(p_title)) not between 1 and 120 then
    raise exception 'A story title must contain between 1 and 120 characters.' using errcode = '22023';
  end if;
  if p_story is null or char_length(btrim(p_story)) not between 40 and 6000 then
    raise exception 'A story must contain between 40 and 6000 characters.' using errcode = '22023';
  end if;
  if p_author_display_name is not null and char_length(btrim(p_author_display_name)) > 80 then
    raise exception 'A public byline cannot exceed 80 characters.' using errcode = '22023';
  end if;
  if p_response_request is null or p_response_request not in (
    'listening', 'understanding', 'perspective', 'reflection', 'reading_guidance', 'support_resources'
  ) then
    raise exception 'Choose a valid response preference.' using errcode = '22023';
  end if;

  insert into public.story_submissions (
    author_id,
    title,
    story,
    author_display_name,
    is_anonymous,
    response_request,
    private_consent,
    public_consent
  )
  values (
    auth.uid(),
    btrim(p_title),
    btrim(p_story),
    case when coalesce(p_is_anonymous, true) then null else nullif(btrim(p_author_display_name), '') end,
    coalesce(p_is_anonymous, true),
    p_response_request,
    true,
    coalesce(p_public_consent, false)
  )
  returning id into submission_id;

  return submission_id;
end;
$$;

revoke all on function public.greyveil_submit_story(text, text, text, boolean, text, boolean) from public, anon;
grant execute on function public.greyveil_submit_story(text, text, text, boolean, text, boolean) to authenticated;

create table if not exists public.story_internal_notes (
  id uuid primary key default gen_random_uuid(),
  story_id uuid not null references public.story_submissions(id) on delete cascade,
  author_id uuid not null references auth.users(id),
  note text not null check (char_length(btrim(note)) between 1 and 4000),
  created_at timestamptz not null default now()
);

create index if not exists story_internal_notes_story_created_idx
  on public.story_internal_notes (story_id, created_at desc);

alter table public.story_internal_notes enable row level security;

drop policy if exists "Admins manage private story notes" on public.story_internal_notes;
create policy "Admins manage private story notes"
  on public.story_internal_notes for all to authenticated
  using ((select public.greyveil_is_admin()))
  with check ((select public.greyveil_is_admin()) and author_id = (select auth.uid()));

revoke all on public.story_internal_notes from public, anon;
grant select, insert, delete on public.story_internal_notes to authenticated;

create table if not exists public.story_responses (
  id uuid primary key default gen_random_uuid(),
  story_id uuid not null references public.story_submissions(id) on delete cascade,
  responder_id uuid not null references auth.users(id),
  response_category text not null
    check (response_category in ('listening', 'understanding', 'perspective', 'reflection', 'reading_guidance', 'support_resources')),
  response_text text not null check (char_length(btrim(response_text)) between 1 and 6000),
  response_origin text not null default 'personal' check (response_origin = 'personal'),
  recommended_book_slugs text[] not null default '{}'
    check (cardinality(recommended_book_slugs) <= 3),
  recommended_essay_slugs text[] not null default '{}'
    check (cardinality(recommended_essay_slugs) <= 3),
  created_at timestamptz not null default now(),
  read_at timestamptz
);

alter table public.story_responses
  add column if not exists recommended_book_slugs text[] not null default '{}',
  add column if not exists recommended_essay_slugs text[] not null default '{}';

create index if not exists story_responses_story_created_idx
  on public.story_responses (story_id, created_at desc);

alter table public.story_responses enable row level security;

drop policy if exists "Authors and admins read story responses" on public.story_responses;
create policy "Authors and admins read story responses"
  on public.story_responses for select to authenticated
  using (
    exists (
      select 1 from public.story_submissions s
      where s.id = story_id
        and (s.author_id = (select auth.uid()) or (select public.greyveil_is_admin()))
    )
  );

drop policy if exists "Authors mark their responses read" on public.story_responses;
create policy "Authors mark their responses read"
  on public.story_responses for update to authenticated
  using (
    exists (
      select 1 from public.story_submissions s
      where s.id = story_id and s.author_id = (select auth.uid())
    )
  )
  with check (
    exists (
      select 1 from public.story_submissions s
      where s.id = story_id and s.author_id = (select auth.uid())
    )
  );

revoke all on public.story_responses from public, anon;
grant select on public.story_responses to authenticated;
grant update (read_at) on public.story_responses to authenticated;

create or replace function public.greyveil_admin_respond_to_story(
  p_story_id uuid,
  p_category text,
  p_response text,
  p_recommended_book_slugs text[] default '{}',
  p_recommended_essay_slugs text[] default '{}'
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  response_id uuid;
begin
  if auth.uid() is null or not public.greyveil_is_admin() then
    raise exception 'Greyveil administration access required.' using errcode = '42501';
  end if;
  if p_category is null or p_category not in ('listening', 'understanding', 'perspective', 'reflection', 'reading_guidance', 'support_resources') then
    raise exception 'Choose a valid human response category.' using errcode = '22023';
  end if;
  if p_response is null or char_length(btrim(p_response)) not between 1 and 6000 then
    raise exception 'A response must contain between 1 and 6000 characters.' using errcode = '22023';
  end if;
  if coalesce(cardinality(p_recommended_book_slugs), 0) > 3
    or exists (
      select 1
      from unnest(coalesce(p_recommended_book_slugs, '{}')) as requested(slug)
      where requested.slug !~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'
        or not exists (select 1 from public.books b where b.slug = requested.slug)
    ) then
    raise exception 'Choose up to three books from the Greyveil catalogue.' using errcode = '22023';
  end if;
  if coalesce(cardinality(p_recommended_essay_slugs), 0) > 3
    or exists (
      select 1
      from unnest(coalesce(p_recommended_essay_slugs, '{}')) as requested(slug)
      where requested.slug not in ('identity-stories', 'memory-and-return', 'understanding-begins')
    ) then
    raise exception 'Choose up to three essays from the Greyveil reading room.' using errcode = '22023';
  end if;

  insert into public.story_responses (
    story_id, responder_id, response_category, response_text, response_origin,
    recommended_book_slugs, recommended_essay_slugs
  )
  values (
    p_story_id, auth.uid(), p_category, btrim(p_response), 'personal',
    coalesce(p_recommended_book_slugs, '{}'), coalesce(p_recommended_essay_slugs, '{}')
  )
  returning id into response_id;

  update public.story_submissions
  set status = case when status in ('pending', 'in_review') then 'responded' else status end,
      reviewed_at = coalesce(reviewed_at, now())
  where id = p_story_id;

  if not found then
    raise exception 'The story submission no longer exists.' using errcode = 'P0002';
  end if;
  return response_id;
end;
$$;

drop function if exists public.greyveil_admin_respond_to_story(uuid, text, text);
drop function if exists public.greyveil_admin_respond_to_story(uuid, text, text, text[]);
revoke all on function public.greyveil_admin_respond_to_story(uuid, text, text, text[], text[]) from public, anon;
grant execute on function public.greyveil_admin_respond_to_story(uuid, text, text, text[], text[]) to authenticated;

create or replace function public.greyveil_admin_update_story_status(
  p_story_id uuid,
  p_status text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  story_public_consent boolean;
  story_publication_withdrawn boolean;
begin
  if auth.uid() is null or not public.greyveil_is_admin() then
    raise exception 'Greyveil administration access required.' using errcode = '42501';
  end if;
  if p_status is null or p_status not in ('in_review', 'declined', 'published') then
    raise exception 'Choose a valid editorial status.' using errcode = '22023';
  end if;

  select s.public_consent,
         exists (
           select 1
           from public.story_publication_withdrawals w
           where w.story_id = s.id
         )
  into story_public_consent, story_publication_withdrawn
  from public.story_submissions s
  where s.id = p_story_id
  for update;

  if not found then
    raise exception 'The story submission no longer exists.' using errcode = 'P0002';
  end if;
  if p_status = 'published'
    and (not story_public_consent or story_publication_withdrawn) then
    raise exception 'Separate active public-sharing permission is required before publication.' using errcode = '42501';
  end if;

  update public.story_submissions
  set status = p_status,
      reviewed_at = coalesce(reviewed_at, now()),
      published_at = case when p_status = 'published' then now() else null end
  where id = p_story_id;
end;
$$;

revoke all on function public.greyveil_admin_update_story_status(uuid, text) from public, anon;
grant execute on function public.greyveil_admin_update_story_status(uuid, text) to authenticated;

create or replace function public.greyveil_admin_save_story_note(p_story_id uuid, p_note text)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  note_id uuid;
begin
  if auth.uid() is null or not public.greyveil_is_admin() then
    raise exception 'Greyveil administration access required.' using errcode = '42501';
  end if;
  if p_note is null or char_length(btrim(p_note)) not between 1 and 4000 then
    raise exception 'A private note must contain between 1 and 4000 characters.' using errcode = '22023';
  end if;
  insert into public.story_internal_notes (story_id, author_id, note)
  values (p_story_id, auth.uid(), btrim(p_note))
  returning id into note_id;
  return note_id;
end;
$$;

revoke all on function public.greyveil_admin_save_story_note(uuid, text) from public, anon;
grant execute on function public.greyveil_admin_save_story_note(uuid, text) to authenticated;

alter table public.story_submissions enable row level security;

drop policy if exists "Authors read own story submissions" on public.story_submissions;
create policy "Authors read own story submissions"
  on public.story_submissions for select to authenticated
  using (author_id = (select auth.uid()) or (select public.greyveil_is_admin()));

drop policy if exists "Authors submit private stories" on public.story_submissions;
create policy "Authors submit private stories"
  on public.story_submissions for insert to authenticated
  with check (
    author_id = (select auth.uid())
    and status = 'pending'
    and reviewed_at is null
    and published_at is null
  );

drop policy if exists "Authors delete own story submissions" on public.story_submissions;
create policy "Authors delete own story submissions"
  on public.story_submissions for delete to authenticated
  using (author_id = (select auth.uid()) or (select public.greyveil_is_admin()));

drop policy if exists "Admins moderate story submissions" on public.story_submissions;
create policy "Admins moderate story submissions"
  on public.story_submissions for update to authenticated
  using ((select public.greyveil_is_admin()))
  with check (
    (select public.greyveil_is_admin())
    and (status <> 'published' or public_consent)
  );

revoke all on public.story_submissions from public, anon;
grant select, delete on public.story_submissions to authenticated;
revoke insert, update on public.story_submissions from authenticated;

create table if not exists public.story_reports (
  id uuid primary key default gen_random_uuid(),
  story_id uuid not null references public.story_submissions(id) on delete cascade,
  reporter_id uuid not null references auth.users(id) on delete cascade,
  reason text not null check (reason in ('privacy', 'safety', 'copyright', 'other')),
  details text check (details is null or char_length(details) <= 1000),
  status text not null default 'open' check (status in ('open', 'resolved', 'dismissed')),
  created_at timestamptz not null default now(),
  reviewed_at timestamptz,
  unique (story_id, reporter_id)
);

create index if not exists story_reports_status_created_idx
  on public.story_reports (status, created_at desc);

alter table public.story_reports enable row level security;

create or replace function public.greyveil_story_is_reportable(p_story_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.story_submissions s
    where s.id = p_story_id
      and s.status = 'published'
      and s.public_consent
      and s.author_id <> (select auth.uid())
      and not exists (
        select 1 from public.story_publication_withdrawals w where w.story_id = s.id
      )
  );
$$;

revoke all on function public.greyveil_story_is_reportable(uuid) from public;
grant execute on function public.greyveil_story_is_reportable(uuid) to authenticated;

drop policy if exists "Readers report published stories" on public.story_reports;
create policy "Readers report published stories"
  on public.story_reports for insert to authenticated
  with check (
    reporter_id = (select auth.uid())
    and (select public.greyveil_story_is_reportable(story_id))
  );

drop policy if exists "Admins manage story reports" on public.story_reports;
create policy "Admins manage story reports"
  on public.story_reports for all to authenticated
  using ((select public.greyveil_is_admin()))
  with check ((select public.greyveil_is_admin()));

revoke all on public.story_reports from public, anon;
grant insert on public.story_reports to authenticated;
grant select, update on public.story_reports to authenticated;

create or replace function public.get_public_greyveil_stories()
returns table (
  id uuid,
  title text,
  story text,
  byline text,
  published_at timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    s.id,
    s.title,
    s.story,
    case
      when s.is_anonymous then 'Anonymous'
      else coalesce(nullif(btrim(s.author_display_name), ''), 'A Greyveil reader')
    end,
    s.published_at
  from public.story_submissions s
  where s.status = 'published'
    and s.public_consent is true
    and s.published_at is not null
    and not exists (
      select 1 from public.story_publication_withdrawals w where w.story_id = s.id
    )
  order by s.published_at desc
  limit 50;
$$;

revoke all on function public.get_public_greyveil_stories() from public;
grant execute on function public.get_public_greyveil_stories() to anon, authenticated;

commit;
notify pgrst, 'reload schema';
