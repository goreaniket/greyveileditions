-- Greyveil Owner Command Centre RBAC and audited Human Response operations.
-- Apply only after greyveil-2-experience.sql and the existing profile/admin schema.
-- Owner provisioning is intentionally separate: set greyveil.owner_user_id to
-- Lalit's verified auth.users UUID before applying, or insert the owner row
-- through an authorised service-role migration after identity verification.

begin;

do $$
begin
  if to_regclass('public.story_submissions') is null
    or to_regclass('public.story_responses') is null
    or to_regclass('public.story_internal_notes') is null
    or to_regclass('public.story_reports') is null
    or to_regclass('public.story_publication_withdrawals') is null then
    raise exception 'Apply and verify supabase/greyveil-2-experience.sql before the Owner Command Centre migration.';
  end if;
  if to_regclass('public.profiles') is null
    or to_regclass('public.books') is null
    or to_regclass('public.orders') is null
    or to_regclass('public.feedbacks') is null then
    raise exception 'The existing Greyveil profile, catalogue, order, and feedback schema is required.';
  end if;
  if to_regprocedure('public.greyveil_admin_respond_to_story(uuid,text,text,text[],text[])') is null
    or to_regprocedure('public.greyveil_admin_update_story_status(uuid,text)') is null
    or to_regprocedure('public.greyveil_admin_save_story_note(uuid,text)') is null then
    raise exception 'The complete supabase/greyveil-2-experience.sql function set is required.';
  end if;
end
$$;

create table if not exists public.greyveil_owner_identity (
  singleton boolean primary key default true check (singleton),
  user_id uuid not null unique references auth.users(id) on delete restrict,
  assigned_at timestamptz not null default now()
);

alter table public.greyveil_owner_identity enable row level security;
revoke all on public.greyveil_owner_identity from public, anon, authenticated;

do $$
declare
  configured_owner_id text := nullif(current_setting('greyveil.owner_user_id', true), '');
  owner_exists boolean;
  existing_owner_id uuid;
begin
  select exists (select 1 from public.greyveil_owner_identity) into owner_exists;
  if owner_exists then
    select user_id into existing_owner_id from public.greyveil_owner_identity where singleton;
  elsif configured_owner_id is null then
    raise exception 'Set greyveil.owner_user_id to Lalit''s verified auth.users UUID before applying the Owner Command Centre migration.';
  end if;
  if configured_owner_id is not null then
    if configured_owner_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
      raise exception 'greyveil.owner_user_id must be the verified owner's auth.users UUID.';
    end if;
    if owner_exists and existing_owner_id <> configured_owner_id::uuid then
      raise exception 'An owner identity already exists; owner replacement requires a separately approved operation.';
    end if;
    if not owner_exists then
      insert into public.greyveil_owner_identity(singleton, user_id)
      values (true, configured_owner_id::uuid);
    end if;
  end if;
end
$$;

create table if not exists public.greyveil_staff_access (
  user_id uuid primary key references auth.users(id) on delete cascade,
  staff_role text not null check (staff_role in (
    'super_admin', 'human_support', 'content_editor', 'finance_admin', 'moderator'
  )),
  active boolean not null default true,
  invited_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  revoked_at timestamptz,
  check ((active and revoked_at is null) or (not active and revoked_at is not null))
);

alter table public.greyveil_staff_access enable row level security;
revoke all on public.greyveil_staff_access from public, anon, authenticated;

create table if not exists public.greyveil_staff_role_permissions (
  staff_role text not null check (staff_role in (
    'super_admin', 'human_support', 'content_editor', 'finance_admin', 'moderator'
  )),
  permission text not null check (permission in (
    'analytics.read', 'users.read', 'staff.read', 'staff.manage',
    'human.inbox.read', 'human.respond', 'human.assign', 'human.moderate',
    'content.read', 'content.manage', 'finance.read', 'finance.invoice',
    'moderation.read', 'moderation.manage', 'security.read', 'audit.read'
  )),
  primary key (staff_role, permission)
);

alter table public.greyveil_staff_role_permissions enable row level security;
revoke all on public.greyveil_staff_role_permissions from public, anon, authenticated;

insert into public.greyveil_staff_role_permissions(staff_role, permission) values
  ('super_admin', 'analytics.read'), ('super_admin', 'users.read'),
  ('super_admin', 'staff.read'), ('super_admin', 'human.inbox.read'),
  ('super_admin', 'human.respond'), ('super_admin', 'human.assign'),
  ('super_admin', 'human.moderate'), ('super_admin', 'content.read'),
  ('super_admin', 'content.manage'), ('super_admin', 'finance.read'),
  ('super_admin', 'finance.invoice'), ('super_admin', 'moderation.read'),
  ('super_admin', 'moderation.manage'), ('super_admin', 'audit.read'),
  ('human_support', 'analytics.read'), ('human_support', 'users.read'),
  ('human_support', 'human.inbox.read'), ('human_support', 'human.respond'),
  ('human_support', 'human.assign'),
  ('content_editor', 'analytics.read'), ('content_editor', 'content.read'),
  ('content_editor', 'content.manage'), ('content_editor', 'moderation.read'),
  ('finance_admin', 'analytics.read'), ('finance_admin', 'finance.read'),
  ('finance_admin', 'finance.invoice'),
  ('moderator', 'analytics.read'), ('moderator', 'human.inbox.read'),
  ('moderator', 'human.moderate'), ('moderator', 'moderation.read'),
  ('moderator', 'moderation.manage')
on conflict do nothing;

create table if not exists public.greyveil_story_assignments (
  story_id uuid primary key references public.story_submissions(id) on delete cascade,
  assigned_to uuid not null references auth.users(id),
  assigned_by uuid not null references auth.users(id),
  assigned_at timestamptz not null default now()
);

alter table public.greyveil_story_assignments enable row level security;
revoke all on public.greyveil_story_assignments from public, anon, authenticated;

create table if not exists public.greyveil_command_audit (
  id bigint generated always as identity primary key,
  actor_id uuid references auth.users(id) on delete set null,
  action text not null check (char_length(action) between 1 and 100),
  target_type text not null check (char_length(target_type) between 1 and 60),
  target_id text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists greyveil_command_audit_created_idx
  on public.greyveil_command_audit(created_at desc);
create index if not exists greyveil_command_audit_actor_idx
  on public.greyveil_command_audit(actor_id, created_at desc);
alter table public.greyveil_command_audit enable row level security;
revoke all on public.greyveil_command_audit from public, anon, authenticated;

create or replace function public.greyveil_command_center_is_owner()
returns boolean
language sql stable security definer
set search_path = public, pg_temp
as $$
  select auth.uid() is not null and exists (
    select 1 from public.greyveil_owner_identity o where o.user_id = auth.uid()
  )
$$;

create or replace function public.greyveil_command_center_has_permission(p_permission text)
returns boolean
language sql stable security definer
set search_path = public, pg_temp
as $$
  select public.greyveil_command_center_is_owner()
    or exists (
      select 1
      from public.greyveil_staff_access a
      join public.greyveil_staff_role_permissions rp on rp.staff_role = a.staff_role
      where a.user_id = auth.uid()
        and a.active
        and rp.permission = p_permission
    )
$$;

revoke all on function public.greyveil_command_center_is_owner() from public, anon;
revoke all on function public.greyveil_command_center_has_permission(text) from public, anon;
grant execute on function public.greyveil_command_center_is_owner() to authenticated;
grant execute on function public.greyveil_command_center_has_permission(text) to authenticated;

create or replace function public.greyveil_command_center_has_story_access(p_story_id uuid)
returns boolean
language sql stable security definer
set search_path = public, pg_temp
as $$
  select auth.uid() is not null
    and coalesce(auth.jwt() ->> 'aal', 'aal1') = 'aal2'
    and public.greyveil_command_center_has_permission('human.inbox.read')
    and (
      public.greyveil_command_center_is_owner()
      or exists (
        select 1 from public.greyveil_staff_access a
        where a.user_id = auth.uid() and a.active and a.staff_role = 'super_admin'
      )
      or exists (
        select 1 from public.greyveil_story_assignments a
        where a.story_id = p_story_id and a.assigned_to = auth.uid()
      )
    )
$$;

revoke all on function public.greyveil_command_center_has_story_access(uuid) from public, anon;
grant execute on function public.greyveil_command_center_has_story_access(uuid) to authenticated;

-- Replace legacy admin policies on private Human Response tables, which otherwise
-- let every legacy admin role read submissions outside the assigned inbox.
do $$
declare
  policy_row record;
begin
  for policy_row in
    select policyname, tablename
    from pg_policies
    where schemaname = 'public'
      and tablename = any(array[
        'story_submissions', 'story_responses', 'story_internal_notes',
        'story_reports', 'story_publication_withdrawals'
      ])
  loop
    execute format('drop policy %I on public.%I', policy_row.policyname, policy_row.tablename);
  end loop;
end
$$;

create policy "Readers and assigned command staff read stories"
  on public.story_submissions for select to authenticated
  using (author_id = (select auth.uid()) or
    (select public.greyveil_command_center_has_story_access(id)));
create policy "Readers submit private stories"
  on public.story_submissions for insert to authenticated
  with check (
    author_id = (select auth.uid())
    and private_consent is true
    and status = 'pending'
    and published_at is null
  );
create policy "Readers delete their own stories"
  on public.story_submissions for delete to authenticated
  using (author_id = (select auth.uid()));

create policy "Readers and assigned command staff read responses"
  on public.story_responses for select to authenticated
  using (
    exists (
      select 1 from public.story_submissions s
      where s.id = story_id
        and (s.author_id = (select auth.uid())
          or (select public.greyveil_command_center_has_story_access(s.id)))
    )
  );
create policy "Readers mark their responses read"
  on public.story_responses for update to authenticated
  using (exists (
    select 1 from public.story_submissions s
    where s.id = story_id and s.author_id = (select auth.uid())
  ))
  with check (exists (
    select 1 from public.story_submissions s
    where s.id = story_id and s.author_id = (select auth.uid())
  ));

create policy "Readers and assigned command staff read publication withdrawals"
  on public.story_publication_withdrawals for select to authenticated
  using (author_id = (select auth.uid()) or
    (select public.greyveil_command_center_has_story_access(story_id)));
create policy "Readers withdraw publication consent"
  on public.story_publication_withdrawals for insert to authenticated
  with check (
    author_id = (select auth.uid())
    and exists (
      select 1 from public.story_submissions s
      where s.id = story_id and s.author_id = (select auth.uid()) and s.public_consent
    )
  );
create policy "Readers report published stories"
  on public.story_reports for insert to authenticated
  with check (
    reporter_id = (select auth.uid())
    and (select public.greyveil_story_is_reportable(story_id))
  );

revoke all on public.story_internal_notes from public, anon, authenticated;
revoke all on public.story_reports from public, anon, authenticated;
grant insert on public.story_reports to authenticated;

-- Retire older admin-only RPCs so a legacy admin role cannot bypass the new
-- MFA-gated permission and audit checks.
revoke all on function public.greyveil_admin_respond_to_story(uuid, text, text, text[], text[]) from public, anon, authenticated;
revoke all on function public.greyveil_admin_update_story_status(uuid, text) from public, anon, authenticated;
revoke all on function public.greyveil_admin_save_story_note(uuid, text) from public, anon, authenticated;

create or replace function public.greyveil_command_center_require(
  p_permission text,
  p_require_mfa boolean default true
)
returns void
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null or not public.greyveil_command_center_has_permission(p_permission) then
    raise exception 'Greyveil command-centre permission required: %.', p_permission using errcode = '42501';
  end if;
  if p_require_mfa and coalesce(auth.jwt() ->> 'aal', 'aal1') <> 'aal2' then
    raise exception 'Complete multi-factor authentication before using this command-centre action.'
      using errcode = '42501';
  end if;
end;
$$;

revoke all on function public.greyveil_command_center_require(text, boolean) from public, anon;
grant execute on function public.greyveil_command_center_require(text, boolean) to authenticated;

create or replace function public.greyveil_command_center_session()
returns jsonb
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
declare
  role_name text;
  profile_name text;
  role_permissions jsonb;
begin
  if auth.uid() is null then
    raise exception 'Sign in to continue.' using errcode = '42501';
  end if;
  if public.greyveil_command_center_is_owner() then
    role_name := 'owner';
    select display_name into profile_name from public.profiles where id = auth.uid();
    role_permissions := '["*"]'::jsonb;
  else
    select a.staff_role, p.display_name into role_name, profile_name
    from public.greyveil_staff_access a
    join public.profiles p on p.id = a.user_id
    where a.user_id = auth.uid() and a.active;
    if role_name is null then
      raise exception 'No active Greyveil command-centre access is assigned to this account.' using errcode = '42501';
    end if;
    select coalesce(jsonb_agg(rp.permission order by rp.permission), '[]'::jsonb)
      into role_permissions
    from public.greyveil_staff_role_permissions rp
    where rp.staff_role = role_name;
  end if;
  return jsonb_build_object(
    'user_id', auth.uid(),
    'display_name', profile_name,
    'role', role_name,
    'aal', coalesce(auth.jwt() ->> 'aal', 'aal1'),
    'mfa_required', true,
    'permissions', role_permissions
  );
end;
$$;

revoke all on function public.greyveil_command_center_session() from public, anon;
grant execute on function public.greyveil_command_center_session() to authenticated;

create or replace function public.greyveil_command_center_overview()
returns jsonb
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
declare result jsonb;
begin
  perform public.greyveil_command_center_require('analytics.read');
  select jsonb_build_object(
    'readers', (select count(*) from public.profiles where role = 'customer'),
    'books', (select count(*) from public.books),
    'orders', (select count(*) from public.orders),
    'captured_orders', (select count(*) from public.orders where status = 'paid'),
    'captured_revenue_paise', (select coalesce(sum(amount), 0) from public.orders where status = 'paid'),
    'pending_stories', (select count(*) from public.story_submissions where status in ('pending', 'in_review')),
    'unread_responses', (select count(*) from public.story_responses where read_at is null),
    'open_reports', (select count(*) from public.story_reports where status = 'open'),
    'new_feedback', (select count(*) from public.feedbacks where coalesce(status, 'new') = 'new')
  ) into result;
  return result;
end;
$$;
revoke all on function public.greyveil_command_center_overview() from public, anon;
grant execute on function public.greyveil_command_center_overview() to authenticated;

create or replace function public.greyveil_command_center_inbox(
  p_search text default null,
  p_status text default null,
  p_category text default null,
  p_assigned_to uuid default null,
  p_limit integer default 100
)
returns table (
  story_id uuid, reader_id uuid, reader_name text, reader_email text, category text,
  title text, status text, is_anonymous boolean, created_at timestamptz,
  assigned_to uuid, assigned_name text, unread_responses bigint
)
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
begin
  perform public.greyveil_command_center_require('human.inbox.read');
  if coalesce(p_limit, 100) not between 1 and 200 then
    raise exception 'Inbox page size must be between 1 and 200.' using errcode = '22023';
  end if;
  return query
  select s.id, case when s.is_anonymous then null else s.author_id end,
    case when s.is_anonymous then 'Anonymous reader' else coalesce(nullif(p.display_name, ''), 'Greyveil reader') end,
    case when s.is_anonymous then null else u.email end,
    s.response_request, s.title, s.status, s.is_anonymous, s.created_at,
    a.assigned_to, assignee.display_name,
    (select count(*) from public.story_responses r where r.story_id = s.id and r.read_at is null)
  from public.story_submissions s
  join public.profiles p on p.id = s.author_id
  join auth.users u on u.id = s.author_id
  left join public.greyveil_story_assignments a on a.story_id = s.id
  left join public.profiles assignee on assignee.id = a.assigned_to
  where (p_search is null or p_search = '' or
    concat_ws(' ', s.title,
      case when not s.is_anonymous then p.display_name end,
      case when not s.is_anonymous then u.email end, s.story) ilike '%' || p_search || '%')
    and (p_status is null or s.status = p_status)
    and (p_category is null or s.response_request = p_category)
    and (p_assigned_to is null or a.assigned_to = p_assigned_to)
  order by s.created_at desc
  limit p_limit;
end;
$$;
revoke all on function public.greyveil_command_center_inbox(text, text, text, uuid, integer) from public, anon;
grant execute on function public.greyveil_command_center_inbox(text, text, text, uuid, integer) to authenticated;

create or replace function public.greyveil_command_center_story(p_story_id uuid)
returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare result jsonb;
begin
  perform public.greyveil_command_center_require('human.inbox.read');
  if not public.greyveil_command_center_is_owner()
    and not exists (select 1 from public.greyveil_staff_access a where a.user_id = auth.uid() and a.staff_role = 'super_admin' and a.active)
    and not exists (select 1 from public.greyveil_story_assignments a where a.story_id = p_story_id and a.assigned_to = auth.uid()) then
    raise exception 'This private conversation is not assigned to your account.' using errcode = '42501';
  end if;
  select jsonb_build_object(
    'story', jsonb_build_object(
      'id', s.id,
      'reader_id', case when s.is_anonymous then null else s.author_id end,
      'reader_name', case when s.is_anonymous then 'Anonymous reader' else p.display_name end,
      'reader_email', case when s.is_anonymous then null else u.email end,
      'title', s.title, 'story', s.story,
      'category', s.response_request, 'status', s.status,
      'is_anonymous', s.is_anonymous, 'public_consent', s.public_consent,
      'created_at', s.created_at
    ),
    'responses', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', r.id, 'category', r.response_category, 'text', r.response_text,
        'created_at', r.created_at, 'read_at', r.read_at, 'responder_id', r.responder_id
      ) order by r.created_at)
      from public.story_responses r where r.story_id = s.id
    ), '[]'::jsonb),
    'notes', case when public.greyveil_command_center_has_permission('human.moderate')
      then coalesce((
        select jsonb_agg(jsonb_build_object('id', n.id, 'note', n.note, 'created_at', n.created_at)
          order by n.created_at)
        from public.story_internal_notes n where n.story_id = s.id
      ), '[]'::jsonb) else '[]'::jsonb end
  ) into result
  from public.story_submissions s
  join public.profiles p on p.id = s.author_id
  join auth.users u on u.id = s.author_id
  where s.id = p_story_id;
  if result is null then raise exception 'Story not found.' using errcode = 'P0002'; end if;
  insert into public.greyveil_command_audit(actor_id, action, target_type, target_id)
    values (auth.uid(), 'human.private_conversation.viewed', 'story', p_story_id::text);
  return result;
end;
$$;
revoke all on function public.greyveil_command_center_story(uuid) from public, anon;
grant execute on function public.greyveil_command_center_story(uuid) to authenticated;

create or replace function public.greyveil_command_center_respond(
  p_story_id uuid, p_category text, p_response text
)
returns uuid
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare response_id uuid;
begin
  perform public.greyveil_command_center_require('human.respond');
  if not public.greyveil_command_center_is_owner()
    and not exists (select 1 from public.greyveil_story_assignments a where a.story_id = p_story_id and a.assigned_to = auth.uid()) then
    raise exception 'Assign this conversation to yourself before responding.' using errcode = '42501';
  end if;
  if p_category not in ('listening','understanding','perspective','reflection','reading_guidance','support_resources')
    or p_response is null or char_length(btrim(p_response)) not between 1 and 6000 then
    raise exception 'Choose a response category and enter a response of up to 6000 characters.' using errcode = '22023';
  end if;
  insert into public.story_responses(story_id, responder_id, response_category, response_text)
  values (p_story_id, auth.uid(), p_category, btrim(p_response))
  returning id into response_id;
  update public.story_submissions set status = 'responded', reviewed_at = coalesce(reviewed_at, now())
    where id = p_story_id and status in ('pending','in_review');
  insert into public.greyveil_command_audit(actor_id, action, target_type, target_id)
    values (auth.uid(), 'human.response.sent', 'story', p_story_id::text);
  return response_id;
end;
$$;
revoke all on function public.greyveil_command_center_respond(uuid, text, text) from public, anon;
grant execute on function public.greyveil_command_center_respond(uuid, text, text) to authenticated;

create or replace function public.greyveil_command_center_assign_story(p_story_id uuid, p_assigned_to uuid)
returns void
language plpgsql security definer
set search_path = public, pg_temp
as $$
begin
  perform public.greyveil_command_center_require('human.assign');
  if not (public.greyveil_command_center_is_owner()
    or public.greyveil_command_center_has_permission('staff.manage')) then
    if p_assigned_to <> auth.uid() then
      raise exception 'Support staff may only assign an inbox story to themselves.' using errcode = '42501';
    end if;
    if not exists (select 1 from public.greyveil_staff_access a where a.user_id = p_assigned_to and a.active and a.staff_role = 'human_support') then
      raise exception 'Assignment target is not active Human Support staff.' using errcode = '22023';
    end if;
  end if;
  insert into public.greyveil_story_assignments(story_id, assigned_to, assigned_by)
  values (p_story_id, p_assigned_to, auth.uid())
  on conflict (story_id) do update set assigned_to = excluded.assigned_to,
    assigned_by = excluded.assigned_by, assigned_at = now();
  insert into public.greyveil_command_audit(actor_id, action, target_type, target_id, details)
    values (auth.uid(), 'human.story.assigned', 'story', p_story_id::text,
      jsonb_build_object('assigned_to', p_assigned_to));
end;
$$;
revoke all on function public.greyveil_command_center_assign_story(uuid, uuid) from public, anon;
grant execute on function public.greyveil_command_center_assign_story(uuid, uuid) to authenticated;

create or replace function public.greyveil_command_center_update_story(p_story_id uuid, p_status text)
returns void
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  has_public_consent boolean;
  has_withdrawn boolean;
begin
  perform public.greyveil_command_center_require('human.moderate');
  if p_status not in ('in_review','declined','published') then
    raise exception 'Unsupported moderation status.' using errcode = '22023';
  end if;
  select s.public_consent,
    exists (select 1 from public.story_publication_withdrawals w where w.story_id = s.id)
    into has_public_consent, has_withdrawn
    from public.story_submissions s where s.id = p_story_id for update;
  if not found then raise exception 'Story not found.' using errcode = 'P0002'; end if;
  if p_status = 'published' and (not has_public_consent or has_withdrawn) then
    raise exception 'Active public-sharing consent is required before publication.' using errcode = '42501';
  end if;
  update public.story_submissions set status = p_status,
    reviewed_at = coalesce(reviewed_at, now()),
    published_at = case when p_status = 'published' then now() else null end
    where id = p_story_id;
  insert into public.greyveil_command_audit(actor_id, action, target_type, target_id, details)
    values (auth.uid(), 'human.story.status_changed', 'story', p_story_id::text,
      jsonb_build_object('status', p_status));
end;
$$;
revoke all on function public.greyveil_command_center_update_story(uuid, text) from public, anon;
grant execute on function public.greyveil_command_center_update_story(uuid, text) to authenticated;

create or replace function public.greyveil_command_center_readers(
  p_search text default null,
  p_limit integer default 100
)
returns table(user_id uuid, display_name text, email text, account_role text, joined_at timestamptz)
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
begin
  perform public.greyveil_command_center_require('users.read');
  if p_limit not between 1 and 200 then raise exception 'Invalid reader page size.' using errcode = '22023'; end if;
  return query
    select p.id, coalesce(nullif(p.display_name, ''), 'Greyveil reader'), u.email, p.role, p.created_at
    from public.profiles p join auth.users u on u.id = p.id
    where p_search is null or p_search = '' or
      concat_ws(' ', p.display_name, u.email, p.role) ilike '%' || p_search || '%'
    order by p.created_at desc limit p_limit;
end;
$$;
revoke all on function public.greyveil_command_center_readers(text, integer) from public, anon;
grant execute on function public.greyveil_command_center_readers(text, integer) to authenticated;

create or replace function public.greyveil_command_center_reports(p_status text default null)
returns table(report_id uuid, story_id uuid, reason text, details text, status text, created_at timestamptz, reporter_name text)
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
begin
  perform public.greyveil_command_center_require('moderation.read');
  return query
    select r.id, r.story_id, r.reason, r.details, r.status, r.created_at,
      coalesce(p.display_name, 'Greyveil reader')
    from public.story_reports r join public.profiles p on p.id = r.reporter_id
    where p_status is null or r.status = p_status
    order by r.created_at desc limit 200;
end;
$$;
revoke all on function public.greyveil_command_center_reports(text) from public, anon;
grant execute on function public.greyveil_command_center_reports(text) to authenticated;

create or replace function public.greyveil_command_center_update_report(p_report_id uuid, p_status text)
returns void
language plpgsql security definer
set search_path = public, pg_temp
as $$
begin
  perform public.greyveil_command_center_require('moderation.manage');
  if p_status not in ('resolved','dismissed') then
    raise exception 'Choose resolved or dismissed.' using errcode = '22023';
  end if;
  update public.story_reports set status = p_status, reviewed_at = now()
    where id = p_report_id and status = 'open';
  if not found then raise exception 'Open report not found.' using errcode = 'P0002'; end if;
  insert into public.greyveil_command_audit(actor_id, action, target_type, target_id, details)
    values (auth.uid(), 'moderation.report.updated', 'story_report', p_report_id::text,
      jsonb_build_object('status', p_status));
end;
$$;
revoke all on function public.greyveil_command_center_update_report(uuid, text) from public, anon;
grant execute on function public.greyveil_command_center_update_report(uuid, text) to authenticated;

create or replace function public.greyveil_command_center_save_note(p_story_id uuid, p_note text)
returns uuid
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare note_id uuid;
begin
  perform public.greyveil_command_center_require('human.moderate');
  if p_note is null or char_length(btrim(p_note)) not between 1 and 4000 then
    raise exception 'A private note must contain 1 to 4000 characters.' using errcode = '22023';
  end if;
  insert into public.story_internal_notes(story_id, author_id, note)
    values (p_story_id, auth.uid(), btrim(p_note)) returning id into note_id;
  insert into public.greyveil_command_audit(actor_id, action, target_type, target_id)
    values (auth.uid(), 'human.internal_note.created', 'story', p_story_id::text);
  return note_id;
end;
$$;
revoke all on function public.greyveil_command_center_save_note(uuid, text) from public, anon;
grant execute on function public.greyveil_command_center_save_note(uuid, text) to authenticated;

drop function if exists public.greyveil_command_center_staff();
create function public.greyveil_command_center_staff()
returns table(user_id uuid, display_name text, email text, staff_role text, active boolean, invitation_pending boolean, created_at timestamptz, revoked_at timestamptz)
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
begin
  perform public.greyveil_command_center_require('staff.read');
  return query select a.user_id, coalesce(nullif(p.display_name, ''), u.email), u.email,
    a.staff_role, a.active, u.email_confirmed_at is null, a.created_at, a.revoked_at
  from public.greyveil_staff_access a left join public.profiles p on p.id = a.user_id
  join auth.users u on u.id = a.user_id order by a.created_at desc;
end;
$$;
revoke all on function public.greyveil_command_center_staff() from public, anon;
grant execute on function public.greyveil_command_center_staff() to authenticated;

create or replace function public.greyveil_command_center_assign_role(p_user_id uuid, p_role text)
returns void
language plpgsql security definer
set search_path = public, pg_temp
as $$
begin
  perform public.greyveil_command_center_require('staff.manage');
  if p_role not in ('super_admin','human_support','content_editor','finance_admin','moderator')
    or exists (select 1 from public.greyveil_owner_identity where user_id = p_user_id) then
    raise exception 'Invalid or protected staff assignment.' using errcode = '22023';
  end if;
  if not exists (select 1 from public.profiles where id = p_user_id) then
    raise exception 'A registered Greyveil profile is required before assigning staff access.' using errcode = 'P0002';
  end if;
  insert into public.greyveil_staff_access(user_id, staff_role, active, invited_by, revoked_at)
    values (p_user_id, p_role, true, auth.uid(), null)
  on conflict (user_id) do update set staff_role = excluded.staff_role, active = true,
    invited_by = excluded.invited_by, updated_at = now(), revoked_at = null;
  insert into public.greyveil_command_audit(actor_id, action, target_type, target_id, details)
    values (auth.uid(), 'staff.role.assigned', 'user', p_user_id::text,
      jsonb_build_object('role', p_role));
end;
$$;
revoke all on function public.greyveil_command_center_assign_role(uuid, text) from public, anon;
grant execute on function public.greyveil_command_center_assign_role(uuid, text) to authenticated;

create or replace function public.greyveil_command_center_revoke_staff(p_user_id uuid)
returns void
language plpgsql security definer
set search_path = public, pg_temp
as $$
begin
  perform public.greyveil_command_center_require('staff.manage');
  if exists (select 1 from public.greyveil_owner_identity where user_id = p_user_id) then
    raise exception 'The Owner identity cannot be revoked through staff management.' using errcode = '42501';
  end if;
  update public.greyveil_staff_access set active = false, revoked_at = now(), updated_at = now()
    where user_id = p_user_id and active;
  if not found then raise exception 'No active staff assignment was found.' using errcode = 'P0002'; end if;
  insert into public.greyveil_command_audit(actor_id, action, target_type, target_id)
    values (auth.uid(), 'staff.access.revoked', 'user', p_user_id::text);
end;
$$;
revoke all on function public.greyveil_command_center_revoke_staff(uuid) from public, anon;
grant execute on function public.greyveil_command_center_revoke_staff(uuid) to authenticated;

create or replace function public.greyveil_command_center_audit(p_limit integer default 100)
returns table(id bigint, actor_name text, action text, target_type text, target_id text, details jsonb, created_at timestamptz)
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
begin
  perform public.greyveil_command_center_require('audit.read');
  if p_limit not between 1 and 200 then raise exception 'Invalid audit page size.' using errcode = '22023'; end if;
  return query select a.id, coalesce(p.display_name, 'Former Greyveil user'), a.action,
    a.target_type, a.target_id, a.details, a.created_at
  from public.greyveil_command_audit a left join public.profiles p on p.id = a.actor_id
  order by a.created_at desc limit p_limit;
end;
$$;
revoke all on function public.greyveil_command_center_audit(integer) from public, anon;
grant execute on function public.greyveil_command_center_audit(integer) to authenticated;

commit;
notify pgrst, 'reload schema';
