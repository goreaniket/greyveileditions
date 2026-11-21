const $ = (selector, root = document) => root.querySelector(selector);
const make = (tag, className = '', value = '') => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (value !== '') node.textContent = String(value);
  return node;
};
const SERIES = [
  { name: 'The Human Mind', count: 5, href: '/projects/human-mind/', description: 'Recognising attachment, silence, mental loops and the ways we begin to understand ourselves.' },
  { name: 'The Human Paradox', count: 5, href: '/projects/human-paradox/', description: 'Questioning awareness, explanation, interpretation, reality and stillness.' },
  { name: 'The Human Fiction', count: 4, href: '/projects/human-fiction/', description: 'Examining narration, meaning, becoming and the stories through which we construct identity.' },
  { name: 'The Human Experience', count: 10, href: '/projects/human-experience/', description: 'Returning to love, responsibility, loss, mortality, society and the search for enough.' },
];
const STAGES = [
  { volume: 'I', title: 'The Inner World', range: '01–05', start: 1, end: 5, description: 'Recognise attachment, silence, mental loops and understanding.' },
  { volume: 'II', title: 'The Limits of Understanding', range: '06–10', start: 6, end: 10, description: 'Question awareness, explanation, reality and the need for certainty.' },
  { volume: 'III', title: 'The Stories We Become', range: '11–14', start: 11, end: 14, description: 'Examine narration, meaning, becoming and self-construction.' },
  { volume: 'IV', title: 'The Life We Actually Live', range: '15–24', start: 15, end: 24, description: 'Return to the complexities of love, responsibility, loss and everyday life.' },
];
const SPECIAL_SLUGS = {
  'The Last Shift — Part II': 'the-last-shift-ii',
  'The Fiction of the Human': 'the-fiction-of-human',
  "The People We Couldn't Save": 'the-people-we-couldnt-save',
};
const slugFor = (title) => SPECIAL_SLUGS[title] || String(title).toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const detailUrl = (book) => {
  const slug = slugFor(book.title);
  if (book.series === 'The Human Experience') return `/projects/human-experience/books/${slug}/`;
  const directory = book.series === 'The Human Mind' ? 'human-mind' : book.series === 'The Human Paradox' ? 'human-paradox' : 'human-fiction';
  return `/projects/${directory}/books/${slug}.html`;
};
const coverUrl = (book) => {
  if (book.series === 'The Human Experience') {
    const number = String(Number(book.series_book_number)).padStart(2, '0');
    const ext = [6, 9].includes(Number(book.series_book_number)) ? 'png' : 'jpg';
    return `/projects/human-experience/covers/book-${number}.${ext}`;
  }
  return `/assets/books/${slugFor(book.title)}/cover/front-cover.webp`;
};
const bookCard = (book) => {
  const article = make('article', 'gv-book-card');
  const coverLink = make('a', 'gv-book-cover');
  coverLink.href = detailUrl(book);
  coverLink.setAttribute('aria-label', `View ${book.title}`);
  const img = document.createElement('img');
  img.src = coverUrl(book);
  img.alt = `Cover of ${book.title}`;
  img.loading = 'lazy';
  img.decoding = 'async';
  img.addEventListener('error', () => { coverLink.classList.add('is-missing-cover'); img.remove(); });
  coverLink.append(img);
  const body = make('div', 'gv-book-card-body');
  const meta = make('p', 'gv-book-meta', `JOURNEY ${String(book.journey_number).padStart(2,'0')} · SERIES BOOK ${String(book.series_book_number).padStart(2,'0')}`);
  const title = make('h3', '', book.title);
  const question = make('p', 'gv-book-question', book.core_question || '');
  const series = make('p', 'gv-book-series', book.series);
  const topics = make('p', 'gv-book-topics', book.key_topics || '');
  const link = make('a', 'gv-book-link', 'Explore book ↗');
  link.href = detailUrl(book);
  body.append(meta, title, question, series, topics, link);
  article.append(coverLink, body);
  return article;
};
const renderSeries = (target) => {
  SERIES.forEach((series, index) => {
    const card = make('article', 'gv-series-card');
    card.append(make('p', 'gv-book-meta', `SERIES 0${index + 1} · ${series.count} BOOKS`), make('h3', '', series.name), make('p', '', series.description));
    const link = make('a', 'gv-book-link', 'Explore series ↗');
    link.href = series.href;
    card.append(link);
    target.append(card);
  });
};
const renderStages = (target) => {
  STAGES.forEach((stage) => {
    const card = make('a', 'gv-stage-card');
    card.href = `/projects/journey/#stage-${stage.volume}`;
    card.append(make('p', 'gv-book-meta', `VOLUME ${stage.volume} · JOURNEY ${stage.range}`), make('h3', '', stage.title), make('p', '', stage.description), make('span', 'gv-book-link', 'Explore stage ↗'));
    target.append(card);
  });
};
const renderBookGrid = (target, books, countNode, options = {}) => {
  const search = $('[data-book-search]');
  const seriesFilter = $('[data-series-filter]');
  const topicFilter = $('[data-topic-filter]');
  const seriesOptions = [...new Set(books.map((book) => book.series))];
  if (seriesFilter && !seriesFilter.dataset.ready) {
    seriesOptions.forEach((name) => seriesFilter.add(new Option(name, name)));
    seriesFilter.dataset.ready = 'true';
  }
  const topics = [...new Set(books.flatMap((book) => String(book.key_topics || '').split(',').map((v) => v.trim()).filter(Boolean)))].sort((a,b)=>a.localeCompare(b));
  if (topicFilter && !topicFilter.dataset.ready) {
    topics.forEach((name) => topicFilter.add(new Option(name, name)));
    topicFilter.dataset.ready = 'true';
  }
  const render = () => {
    const term = String(search?.value || '').trim().toLowerCase();
    const series = String(seriesFilter?.value || '');
    const topic = String(topicFilter?.value || '').toLowerCase();
    const visible = books.filter((book) => {
      const searchable = [book.title, book.series, book.core_question, book.key_topics, book.reader_situation].join(' ').toLowerCase();
      const matchesSearch = !term || searchable.includes(term);
      const matchesSeries = !series || book.series === series;
      const matchesTopic = !topic || String(book.key_topics || '').toLowerCase().includes(topic);
      return matchesSearch && matchesSeries && matchesTopic;
    });
    target.replaceChildren(...visible.map(bookCard));
    if (countNode) countNode.textContent = `${visible.length} of ${books.length} ${books.length === 1 ? 'book' : 'books'} shown`;
    if (!visible.length) target.append(make('p', 'gv-collection-empty', 'No books match those filters. Try another search or topic.'));
  };
  [search, seriesFilter, topicFilter].filter(Boolean).forEach((control) => control.addEventListener('input', render));
  [seriesFilter, topicFilter].filter(Boolean).forEach((control) => control.addEventListener('change', render));
  render();
};
const renderJourney = (target, books) => {
  STAGES.forEach((stage) => {
    const section = make('section', 'gv-journey-stage');
    section.id = `stage-${stage.volume}`;
    const head = make('div', 'gv-journey-stage-head');
    head.append(make('p', 'gv-book-meta', `VOLUME ${stage.volume} · JOURNEY ${stage.range}`), make('h2', '', stage.title), make('p', '', stage.description));
    const grid = make('div', 'gv-book-grid');
    books.filter((book) => Number(book.journey_number) >= stage.start && Number(book.journey_number) <= stage.end).forEach((book) => grid.append(bookCard(book)));
    section.append(head, grid);
    target.append(section);
  });
};
const bookFromRecommendation = (text, byJourney) => {
  const match = String(text || '').match(/^\s*(\d{1,2})/);
  return match ? byJourney.get(Number(match[1])) : null;
};
const renderTopics = (target, topics, byJourney) => {
  topics.forEach((topic, index) => {
    const card = make('article', 'gv-topic-card');
    card.append(make('p', 'gv-book-meta', `TOPIC ${String(index + 1).padStart(2,'0')}`), make('h3', '', topic.topic), make('p', '', topic.notes || ''));
    const primary = bookFromRecommendation(topic.primary_recommendation, byJourney);
    if (primary) {
      card.append(make('p', 'gv-topic-label', 'PRIMARY RECOMMENDATION'));
      card.append(bookLink(primary));
    }
    const others = String(topic.other_books || '').split('|').map((entry) => bookFromRecommendation(entry, byJourney)).filter(Boolean);
    if (others.length) {
      card.append(make('p', 'gv-topic-label', 'ALSO RELEVANT'));
      const list = make('ul', 'gv-topic-links');
      others.forEach((book) => { const li = make('li'); li.append(bookLink(book)); list.append(li); });
      card.append(list);
    }
    target.append(card);
  });
};
const bookLink = (book) => {
  const link = make('a', 'gv-book-link', `${String(book.journey_number).padStart(2,'0')} — ${book.title} ↗`);
  link.href = detailUrl(book);
  return link;
};
const init = async () => {
  const root = $('[data-collection-view]');
  if (!root) return;
  const view = root.dataset.collectionView;
  const response = await fetch('/catalogue.json', { cache: 'no-store' });
  if (!response.ok) throw new Error(`Catalogue unavailable (${response.status})`);
  const catalogue = await response.json();
  const books = Array.isArray(catalogue.books) ? [...catalogue.books].sort((a,b)=>Number(a.journey_number)-Number(b.journey_number)) : [];
  if (books.length !== 24) throw new Error('The approved catalogue did not return 24 books.');
  const byJourney = new Map(books.map((book) => [Number(book.journey_number), book]));
  if (view === 'overview') {
    renderSeries($('[data-series-grid]', root));
    renderStages($('[data-stage-grid]', root));
    renderBookGrid($('[data-book-grid]', root), books, $('[data-book-count]', root));
  } else if (view === 'journey') {
    renderJourney($('[data-journey-grid]', root), books);
  } else if (view === 'topics') {
    if (!Array.isArray(catalogue.topics)) throw new Error('Topic index is unavailable.');
    renderTopics($('[data-topic-grid]', root), catalogue.topics, byJourney);
  } else if (view === 'series') {
    const filtered = books.filter((book) => book.series === root.dataset.series);
    renderBookGrid($('[data-book-grid]', root), filtered, $('[data-book-count]', root));
  }
};
init().catch((error) => {
  console.error('Greyveil collection pages could not load.', error);
  const target = $('[data-book-grid], [data-journey-grid], [data-topic-grid]');
  if (target) target.replaceChildren(make('p', 'gv-collection-empty', 'The collection could not be loaded. Refresh the page to try again.'));
  const count = $('[data-book-count]');
  if (count) count.textContent = 'Catalogue unavailable';
});
