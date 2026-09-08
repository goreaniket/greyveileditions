-- Updates only the existing Human Experience catalog record and its five books.
-- Apply after the five PDFs have been uploaded through the publishing dashboard;
-- this preserves each existing Storage path and updates its file label.

begin;

do $$
declare
  target_collection_id uuid;
  target_series_id uuid;
  matched_books integer;
  mapped_pdfs integer;
begin
  select id into target_collection_id
  from public.collections
  where slug = 'human-experience-collection'
  limit 1;

  if target_collection_id is null then
    raise exception 'Human Experience collection (human-experience-collection) was not found.';
  end if;

  update public.collections
  set title = 'The Human Experience — 5 Book Collection',
      description = 'What if the hardest parts of being human were never the obvious ones? The Human Experience is a five-book psychological and philosophical collection exploring the parts of life we usually feel before we understand them.'
  where id = target_collection_id;

  select id into target_series_id
  from public.series
  where collection_id = target_collection_id and slug = 'human-experience'
  limit 1;

  if target_series_id is null then
    raise exception 'Human Experience series (human-experience) was not found.';
  end if;

  update public.series
  set title = 'The Human Experience',
      description = 'Five books. Five different doors into the same question: What does it actually mean to be human?'
  where id = target_series_id;

  with requested_books (book_number, slug, title) as (
    values
      (1, 'the-person-who-was-tired-of-being-strong', 'The Person Who Was Tired of Being Strong'),
      (2, 'the-world-we-thought-we-saw', 'The World We Thought We Saw'),
      (3, 'an-unknown-part-of-life', 'An Unknown Part of Life'),
      (4, 'the-people-we-couldnt-save', 'The People We Couldn’t Save'),
      (5, 'between-birth-and-death', 'Between Birth and Death')
  )
  update public.books book
  set title = requested.title,
      series = 'The Human Experience',
      book_number = requested.book_number,
      series_id = target_series_id
  from requested_books requested
  where book.series_id = target_series_id and book.slug = requested.slug;

  get diagnostics matched_books = row_count;
  if matched_books <> 5 then
    raise exception 'Expected five Human Experience books; updated %.', matched_books;
  end if;

  with requested_books (slug, pdf_file_name) as (
    values
      ('the-person-who-was-tired-of-being-strong', 'The Human Experience Book I.pdf'),
      ('the-world-we-thought-we-saw', 'The_Human_Experience_Book_II_FINAL_FIXED.pdf'),
      ('an-unknown-part-of-life', 'An_Unknown_Part_of_Life_FINAL_VERIFIED.pdf'),
      ('the-people-we-couldnt-save', 'The_People_We_Couldnt_Save_THE_Book_4.pdf'),
      ('between-birth-and-death', 'Between_Birth_and_Death_THE_HUMAN_EXPERIENCE_Book_V_FINAL_READY.pdf')
  )
  update public.book_files file
  set file_name = requested.pdf_file_name
  from public.books book
  join requested_books requested on requested.slug = book.slug
  where file.book_id = book.id and file.file_type = 'pdf';

  get diagnostics mapped_pdfs = row_count;
  if mapped_pdfs <> 5 then
    raise exception 'Expected five existing Human Experience PDF references; updated %.', mapped_pdfs;
  end if;
end;
$$;

commit;
