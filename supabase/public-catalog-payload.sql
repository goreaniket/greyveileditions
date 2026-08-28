-- Phase 5: one public catalog payload for the storefront.
-- Apply separately before deploying the matching frontend. This function returns
-- catalog metadata only; it never exposes reader files, cover Storage paths, or
-- any generated/private publishing artifacts.

begin;

-- The current public HTML contained three series and fourteen canonical books,
-- while the live catalog tables were only partially populated. Seed only those
-- established catalog identities so switching authority does not drop titles.
-- Existing visibility, active state, and configured prices always win.
insert into public.series (
  collection_id, volume_id, slug, title, description, visibility, is_active,
  price_amount, sort_order
)
values
  (
    (select id from public.collections where slug = 'human-paradox-collection'),
    (select id from public.volumes where slug = 'volume-i'),
    'human-mind', 'The Human Mind',
    'An exploration of consciousness, identity, attachment, perception, silence and understanding.',
    'paid', true, 59900, 1
  ),
  (
    (select id from public.collections where slug = 'human-paradox-collection'),
    (select id from public.volumes where slug = 'volume-i'),
    'human-paradox', 'The Human Paradox',
    'Because understanding the mind is only the beginning. The real journey is understanding the paradox.',
    'paid', true, 59900, 2
  ),
  (
    (select id from public.collections where slug = 'human-paradox-collection'),
    (select id from public.volumes where slug = 'volume-i'),
    'human-fiction', 'The Human Fiction',
    'Stories, narratives and fictional explorations of human nature.',
    'paid', true, 49900, 3
  )
on conflict (collection_id, slug) do update
set collection_id = excluded.collection_id,
    volume_id = excluded.volume_id,
    title = excluded.title,
    description = excluded.description,
    price_amount = coalesce(public.series.price_amount, excluded.price_amount),
    sort_order = excluded.sort_order;

with canonical_books (series_slug, legacy_series, book_number, slug, title) as (
  values
    ('human-mind', 'Human Mind', 1, 'the-last-shift', 'The Last Shift'),
    ('human-mind', 'Human Mind', 2, 'the-last-shift-ii', 'The Last Shift II'),
    ('human-mind', 'Human Mind', 3, 'the-quiet-i-started-living-with', 'The Quiet I Started Living With'),
    ('human-mind', 'Human Mind', 4, 'the-loop-within', 'The Loop Within'),
    ('human-mind', 'Human Mind', 5, 'when-understanding-begins', 'When Understanding Begins'),
    ('human-paradox', 'Human Paradox', 1, 'the-paradox-of-awareness', 'The Paradox of Awareness'),
    ('human-paradox', 'Human Paradox', 2, 'the-paradox-of-explanation', 'The Paradox of Explanation'),
    ('human-paradox', 'Human Paradox', 3, 'the-end-of-interpretation', 'The End of Interpretation'),
    ('human-paradox', 'Human Paradox', 4, 'the-paradox-of-reality', 'The Paradox of Reality'),
    ('human-paradox', 'Human Paradox', 5, 'the-paradox-of-stillness', 'The Paradox of Stillness'),
    ('human-fiction', 'Human Fiction', 1, 'the-fiction-of-awareness', 'The Fiction of Awareness'),
    ('human-fiction', 'Human Fiction', 2, 'the-fiction-of-meaning', 'The Fiction of Meaning'),
    ('human-fiction', 'Human Fiction', 3, 'the-fiction-of-becoming', 'The Fiction of Becoming'),
    ('human-fiction', 'Human Fiction', 4, 'the-fiction-of-human', 'The Fiction of Human')
)
insert into public.books (
  title, series, book_number, slug, visibility, series_id, is_public, is_active,
  price_amount
)
select canonical.title, canonical.legacy_series, canonical.book_number,
  canonical.slug, 'paid', series_item.id, false, true, 14900
from canonical_books canonical
join public.series series_item on series_item.slug = canonical.series_slug
on conflict (slug) do update
set title = excluded.title,
    series = excluded.series,
    book_number = excluded.book_number,
    series_id = excluded.series_id,
    price_amount = coalesce(public.books.price_amount, excluded.price_amount);

-- Retire the exact Phase 2 smoke-test row so it cannot become a broken public
-- catalog card. This does not delete the row or any publishing artifacts.
update public.books
set visibility = 'private', is_public = false, is_active = false
where slug = 'phase-2-github-actions-e2e-20260827';

create or replace function public.greyveil_public_catalog()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with viewer as (
    select coalesce(public.greyveil_is_admin(), false) as is_admin
  ),
  visible_collections as (
    select collection.*
    from public.collections collection
    cross join viewer
    where viewer.is_admin
      or (
        coalesce(collection.is_active, true)
        and lower(coalesce(collection.visibility, 'public')) <> 'private'
      )
  ),
  visible_volumes as (
    select volume.*
    from public.volumes volume
    join visible_collections collection on collection.id = volume.collection_id
    cross join viewer
    where viewer.is_admin
      or (
        coalesce(volume.is_active, true)
        and lower(coalesce(volume.visibility, 'public')) <> 'private'
      )
  ),
  visible_series as (
    select series_item.*
    from public.series series_item
    left join visible_volumes volume on volume.id = series_item.volume_id
    left join visible_collections collection
      on collection.id = coalesce(series_item.collection_id, volume.collection_id)
    cross join viewer
    where viewer.is_admin
      or (
        collection.id is not null
        and (series_item.volume_id is null or volume.id is not null)
        and coalesce(series_item.is_active, true)
        and lower(coalesce(series_item.visibility, 'public')) <> 'private'
      )
  ),
  visible_books as (
    select book.*
    from public.books book
    join visible_series series_item on series_item.id = book.series_id
    cross join viewer
    where viewer.is_admin
      or (
        coalesce(book.is_active, true)
        and lower(coalesce(book.visibility, 'paid')) <> 'private'
      )
  )
  select jsonb_build_object(
    'collections', coalesce((
      select jsonb_agg(to_jsonb(row_data) order by row_data.sort_order, row_data.title)
      from (
        select id, slug, title, description, visibility, is_active, price_amount,
          sort_order, created_at, updated_at
        from visible_collections
      ) row_data
    ), '[]'::jsonb),
    'volumes', coalesce((
      select jsonb_agg(to_jsonb(row_data) order by row_data.sort_order, row_data.title)
      from (
        select id, collection_id, slug, title, description, visibility, is_active,
          sort_order, created_at, updated_at
        from visible_volumes
      ) row_data
    ), '[]'::jsonb),
    'series', coalesce((
      select jsonb_agg(to_jsonb(row_data) order by row_data.sort_order, row_data.title)
      from (
        select id, collection_id, volume_id, slug, title, description, visibility,
          is_active, price_amount, sort_order, created_at, updated_at
        from visible_series
      ) row_data
    ), '[]'::jsonb),
    'books', coalesce((
      select jsonb_agg(to_jsonb(row_data) order by row_data.series, row_data.book_number, row_data.title)
      from (
        select id, title, series, book_number, slug, visibility, series_id,
          is_public, is_active, price_amount, created_at, updated_at
        from visible_books
      ) row_data
    ), '[]'::jsonb)
  );
$$;

revoke all on function public.greyveil_public_catalog() from public;
grant execute on function public.greyveil_public_catalog() to anon, authenticated;

commit;
