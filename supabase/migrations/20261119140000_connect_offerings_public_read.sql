-- Public discovery may read only the fields required to render published listings.
-- RLS keeps drafts, full records, and all write operations restricted to authenticated admins.
grant select (id, title, offering_type, summary, delivery_mode, location_label, starts_at, capacity)
on table public.connect_offerings to anon;

drop policy if exists "Public can view published offerings" on public.connect_offerings;
create policy "Public can view published offerings"
on public.connect_offerings
for select
to anon
using (status = 'published');
