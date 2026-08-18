-- Greyveil Editions authentication/profile repair (run once in Supabase SQL Editor).
-- This migration preserves the existing auth.users trigger named on_auth_user_created.
-- It prints that trigger and its called function before replacing the function in place.

begin;

do $$
declare
  profiles_id_attribute smallint;
  auth_users_id_attribute smallint;
begin
  if to_regclass('public.profiles') is null then
    raise exception 'public.profiles does not exist; restore the base schema before applying this repair.';
  end if;

  if exists (
    select required.column_name
    from (values ('id'), ('display_name'), ('role'), ('created_at')) required(column_name)
    where not exists (
      select 1
      from information_schema.columns actual
      where actual.table_schema = 'public'
        and actual.table_name = 'profiles'
        and actual.column_name = required.column_name
    )
  ) then
    raise exception 'public.profiles is missing a required Greyveil column.';
  end if;

  select attnum into profiles_id_attribute
  from pg_attribute
  where attrelid = 'public.profiles'::regclass
    and attname = 'id'
    and not attisdropped;

  select attnum into auth_users_id_attribute
  from pg_attribute
  where attrelid = 'auth.users'::regclass
    and attname = 'id'
    and not attisdropped;

  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.profiles'::regclass
      and contype in ('p', 'u')
      and conkey = array[profiles_id_attribute]::smallint[]
  ) then
    raise exception 'public.profiles.id must be a primary key or unique key before applying this repair.';
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.profiles'::regclass
      and confrelid = 'auth.users'::regclass
      and contype = 'f'
      and conkey = array[profiles_id_attribute]::smallint[]
      and confkey = array[auth_users_id_attribute]::smallint[]
  ) then
    raise exception 'public.profiles.id must reference auth.users.id before applying this repair.';
  end if;

  if exists (select 1 from public.profiles where id is null or role is null) then
    raise exception 'public.profiles contains a null id or role; review those rows before applying this repair.';
  end if;

  if exists (
    select 1 from public.profiles
    where role not in ('customer', 'admin', 'super_admin')
  ) then
    raise exception 'public.profiles contains an unsupported role; review it before applying this repair.';
  end if;

  if exists (
    select 1
    from information_schema.columns actual
    where actual.table_schema = 'public'
      and actual.table_name = 'profiles'
      and actual.is_nullable = 'NO'
      and actual.column_default is null
      and actual.is_identity = 'NO'
      and actual.is_generated = 'NEVER'
      and actual.column_name not in ('id', 'display_name', 'role', 'created_at')
  ) then
    raise exception 'public.profiles has an additional required column without a default; repair its default/nullability before signup.';
  end if;
end;
$$;

alter table public.profiles
  alter column role set default 'customer',
  alter column role set not null;

do $$
declare
  signup_trigger_oid oid;
  signup_function_oid oid;
  signup_function_schema text;
  signup_function_name text;
  competing_profile_triggers text[];
begin
  select trigger_item.oid, trigger_item.tgfoid
  into signup_trigger_oid, signup_function_oid
  from pg_trigger trigger_item
  where trigger_item.tgrelid = 'auth.users'::regclass
    and trigger_item.tgname = 'on_auth_user_created'
    and not trigger_item.tgisinternal;

  if signup_trigger_oid is null then
    raise exception 'Expected existing auth.users trigger on_auth_user_created was not found; no trigger was changed.';
  end if;

  if not exists (
    select 1
    from pg_trigger trigger_item
    where trigger_item.oid = signup_trigger_oid
      and (trigger_item.tgtype & 1) = 1
      and (trigger_item.tgtype & 4) = 4
      and (trigger_item.tgtype & 2) = 0
      and (trigger_item.tgtype & (8 | 16 | 32 | 64)) = 0
      and trigger_item.tgenabled <> 'D'
  ) then
    raise exception 'on_auth_user_created is not an enabled AFTER INSERT FOR EACH ROW trigger; no trigger was changed.';
  end if;

  select namespace_item.nspname, procedure_item.proname
  into signup_function_schema, signup_function_name
  from pg_proc procedure_item
  join pg_namespace namespace_item on namespace_item.oid = procedure_item.pronamespace
  where procedure_item.oid = signup_function_oid
    and procedure_item.prorettype = 'trigger'::regtype
    and procedure_item.pronargs = 0;

  if signup_function_name is null then
    raise exception 'on_auth_user_created does not call a zero-argument trigger function; no function was changed.';
  end if;

  select array_agg(trigger_item.tgname order by trigger_item.tgname)
  into competing_profile_triggers
  from pg_trigger trigger_item
  where trigger_item.tgrelid = 'auth.users'::regclass
    and trigger_item.oid <> signup_trigger_oid
    and not trigger_item.tgisinternal
    and (trigger_item.tgtype & 4) = 4
    and pg_get_functiondef(trigger_item.tgfoid) ilike '%profiles%';

  if coalesce(array_length(competing_profile_triggers, 1), 0) > 0 then
    raise exception 'Competing auth.users profile trigger(s) found: %. Review them before applying this repair.', competing_profile_triggers;
  end if;

  -- These notices are the exact pre-change definitions requested for the audit.
  raise notice 'Existing on_auth_user_created trigger definition: %', pg_get_triggerdef(signup_trigger_oid, true);
  raise notice 'Existing on_auth_user_created function definition: %', pg_get_functiondef(signup_function_oid);

  execute format(
    $definition$
      create or replace function %I.%I()
      returns trigger
      language plpgsql
      security definer
      set search_path = ''
      as $body$
      declare
        requested_display_name text;
      begin
        requested_display_name := nullif(
          regexp_replace(trim(coalesce(new.raw_user_meta_data ->> 'display_name', '')), '[[:space:]]+', ' ', 'g'),
          ''
        );

        insert into public.profiles (id, display_name, role, created_at)
        values (
          new.id,
          left(coalesce(requested_display_name, nullif(split_part(new.email, '@', 1), ''), 'Reader'), 80),
          'customer',
          coalesce(new.created_at, now())
        )
        on conflict (id) do nothing;

        return new;
      end;
      $body$;
    $definition$,
    signup_function_schema,
    signup_function_name
  );

  execute format(
    'revoke all on function %I.%I() from public, anon, authenticated',
    signup_function_schema,
    signup_function_name
  );
end;
$$;

-- Repair only missing rows; existing profiles and privileged roles are not rewritten.
insert into public.profiles (id, display_name, role, created_at)
select
  auth_user.id,
  left(
    coalesce(
      nullif(
        regexp_replace(trim(coalesce(auth_user.raw_user_meta_data ->> 'display_name', '')), '[[:space:]]+', ' ', 'g'),
        ''
      ),
      nullif(split_part(auth_user.email, '@', 1), ''),
      'Reader'
    ),
    80
  ),
  'customer',
  coalesce(auth_user.created_at, now())
from auth.users auth_user
left join public.profiles profile on profile.id = auth_user.id
where profile.id is null
on conflict (id) do nothing;

alter table public.profiles enable row level security;

drop policy if exists "Users read their own profile" on public.profiles;
create policy "Users read their own profile"
on public.profiles for select
to authenticated
using (auth.uid() = id);

drop policy if exists "Users update their own profile" on public.profiles;
create policy "Users update their own profile"
on public.profiles for update
to authenticated
using (auth.uid() = id)
with check (auth.uid() = id);

-- Preserve the established super-admin role flow before adding a customer field guard.
do $$
declare
  role_guard_definition text;
begin
  select pg_get_triggerdef(trigger_item.oid, true)
  into role_guard_definition
  from pg_trigger trigger_item
  where trigger_item.tgrelid = 'public.profiles'::regclass
    and trigger_item.tgname = 'greyveil_guard_profile_role'
    and not trigger_item.tgisinternal
    and trigger_item.tgenabled <> 'D';

  if role_guard_definition is null
    or role_guard_definition not ilike '%before update of role%'
  then
    raise exception 'The existing greyveil_guard_profile_role trigger is required before profile update grants are repaired.';
  end if;

  raise notice 'Existing role guard retained: %', role_guard_definition;
end;
$$;

create or replace function public.greyveil_guard_customer_profile_fields()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  jwt_role text := coalesce(current_setting('request.jwt.claim.role', true), '');
begin
  if jwt_role = 'service_role' or public.greyveil_is_super_admin() then
    return new;
  end if;

  if (to_jsonb(new) - 'display_name') is distinct from (to_jsonb(old) - 'display_name') then
    raise exception 'Customers may update only their display name.' using errcode = '42501';
  end if;

  return new;
end;
$$;

revoke all on function public.greyveil_guard_customer_profile_fields() from public, anon, authenticated;

drop trigger if exists greyveil_guard_customer_profile_fields on public.profiles;
create trigger greyveil_guard_customer_profile_fields
before update on public.profiles
for each row execute function public.greyveil_guard_customer_profile_fields();

grant update (display_name) on public.profiles to authenticated;
grant select (id, display_name, role, created_at) on public.profiles to authenticated;

do $$
declare
  remaining_missing_profiles bigint;
  final_trigger_definition text;
begin
  select count(*) into remaining_missing_profiles
  from auth.users auth_user
  left join public.profiles profile on profile.id = auth_user.id
  where profile.id is null;

  if remaining_missing_profiles <> 0 then
    raise exception '% Auth user(s) still lack a public.profiles row; transaction rolled back.', remaining_missing_profiles;
  end if;

  select pg_get_triggerdef(trigger_item.oid, true)
  into final_trigger_definition
  from pg_trigger trigger_item
  where trigger_item.tgrelid = 'auth.users'::regclass
    and trigger_item.tgname = 'on_auth_user_created'
    and not trigger_item.tgisinternal;

  raise notice 'Preserved on_auth_user_created trigger definition: %', final_trigger_definition;
  raise notice 'Profile audit passed: every current Auth user has exactly one profile id and new roles are hardcoded to customer.';
end;
$$;

commit;

notify pgrst, 'reload schema';
