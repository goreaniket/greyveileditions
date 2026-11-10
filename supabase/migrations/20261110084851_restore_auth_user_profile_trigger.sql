-- Restore automatic reader-profile creation for Greyveil email signups.
-- Existing profile rows and privileged roles are preserved.
begin;

create or replace function public.greyveil_handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  chosen_display_name text;
begin
  chosen_display_name := nullif(
    btrim(coalesce(
      new.raw_user_meta_data ->> 'display_name',
      new.raw_user_meta_data ->> 'full_name'
    )),
    ''
  );

  insert into public.profiles (id, display_name, role)
  values (new.id, chosen_display_name, 'reader')
  on conflict (id) do update
    set display_name = coalesce(public.profiles.display_name, excluded.display_name);

  return new;
end;
$$;

revoke all on function public.greyveil_handle_new_auth_user() from public, anon, authenticated;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row
execute function public.greyveil_handle_new_auth_user();

commit;
