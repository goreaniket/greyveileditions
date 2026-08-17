-- Greyveil Editions Auth -> profile signup repair (review before running).
-- This file is not applied automatically. It only repairs the signup trigger and role default;
-- it does not rewrite existing profiles, roles, or RLS policies.

begin;

do $$
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
  existing_after_insert_triggers text[];
begin
  select array_agg(trigger_item.tgname order by trigger_item.tgname)
  into existing_after_insert_triggers
  from pg_trigger trigger_item
  where trigger_item.tgrelid = 'auth.users'::regclass
    and not trigger_item.tgisinternal
    and trigger_item.tgname <> 'greyveil_create_profile_after_signup'
    and pg_get_triggerdef(trigger_item.oid) ilike '%after insert%';

  if coalesce(array_length(existing_after_insert_triggers, 1), 0) > 0 then
    raise exception 'Review existing auth.users AFTER INSERT trigger(s) before applying this repair: %', existing_after_insert_triggers;
  end if;
end;
$$;

create or replace function public.greyveil_create_profile_for_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  requested_display_name text;
begin
  requested_display_name := nullif(trim(new.raw_user_meta_data ->> 'display_name'), '');

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
$$;

revoke all on function public.greyveil_create_profile_for_auth_user() from public, anon, authenticated;

drop trigger if exists greyveil_create_profile_after_signup on auth.users;
create trigger greyveil_create_profile_after_signup
after insert on auth.users
for each row execute function public.greyveil_create_profile_for_auth_user();

commit;
