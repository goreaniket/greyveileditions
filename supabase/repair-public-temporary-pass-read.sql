-- Keep the public Pass offer readable without granting anon access to the
-- Admin-role helper. The separate authenticated Admin management policy
-- continues to cover inactive rows for Admin and Super Admin users.

begin;

drop policy if exists "Public reads active temporary passes"
  on public.temporary_access_passes;

create policy "Public reads active temporary passes"
on public.temporary_access_passes
for select
to anon, authenticated
using (active);

commit;
