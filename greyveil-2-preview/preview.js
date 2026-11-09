const $ = (selector) => document.querySelector(selector);
const make = (tag, className = '', text = '') => {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text) element.textContent = text;
  return element;
};

const initializeSiteAssets = () => {
  if (!siteAssetsAvailable) return;
  document.querySelectorAll('[data-site-asset]').forEach((image) => {
    image.src = image.dataset.siteAsset;
  });
};

const seriesDirectories = {
  'The Human Mind': 'human-mind',
  'The Human Paradox': 'human-paradox',
  'The Human Fiction': 'human-fiction',
  'The Human Experience': 'human-experience',
};
const siteAssetsAvailable = window.location.protocol === 'http:' || window.location.protocol === 'https:';

const bookSlug = (title) => {
  if (title === 'The Last Shift — Part II') return 'the-last-shift-ii';
  if (title === 'The Fiction of the Human') return 'the-fiction-of-human';
  return title.toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
};

const seriesDirectory = (book) => {
  const directory = seriesDirectories[book.series];
  if (directory) return directory;
  return 'human-experience';
};

const detailUrl = (book) => {
  const series = seriesDirectory(book);
  if (series === 'human-experience') {
    return `https://greyveileditions.site/projects/${series}/books/${bookSlug(book.title)}/`;
  }
  return `https://greyveileditions.site/projects/${series}/books/${bookSlug(book.title)}.html`;
};

const coverUrl = (book) => {
  if (!siteAssetsAvailable) return null;
  if (book.series === 'The Human Experience') {
    const extension = [6, 9].includes(Number(book.series_book_number)) ? 'png' : 'jpg';
    const number = String(Number(book.series_book_number)).padStart(2, '0');
    return `../projects/human-experience/covers/book-${number}.${extension}`;
  }
  return `../assets/books/${bookSlug(book.title)}/cover/front-cover.webp`;
};

let catalogue;
const PREVIEW_SHELF_KEY = 'greyveil-2-preview:shelf';
const READING_HISTORY_KEY = 'greyveil-2-preview:history';
const REFLECTIONS_KEY = 'greyveil-2-preview:reflections';
const LINES_KEY = 'greyveil-2-preview:lines';
const HEARD_DRAFT_KEY = 'greyveil-2-preview:heard-draft';
let savedBookSlugs = new Set();
let supabaseClient = null;
let currentReader = null;
let storyServiceReady = false;
let editorialSubmissions = [];
let selectedEditorialSubmissionId = null;

const responseCategoryLabels = {
  listening: 'Listening',
  understanding: 'Understanding',
  perspective: 'Perspective',
  reflection: 'Reflection',
  reading_guidance: 'Reading Guidance',
  support_resources: 'Support Resources',
};

const readLocalList = (key, statusSelector) => {
  try {
    const saved = JSON.parse(localStorage.getItem(key) || '[]');
    if (!Array.isArray(saved)) throw new TypeError('Saved browser data must be a list.');
    return saved;
  } catch (error) {
    console.error('Greyveil browser data could not be read.', { key, error });
    const status = statusSelector && $(statusSelector);
    if (status) status.textContent = 'This browser could not read the saved data. You can clear Greyveil data in My Space.';
    return [];
  }
};

const writeLocalList = (key, list, statusSelector) => {
  try {
    localStorage.setItem(key, JSON.stringify(list));
    return true;
  } catch (error) {
    console.error('Greyveil browser data could not be saved.', { key, error });
    const status = statusSelector && $(statusSelector);
    if (status) status.textContent = 'This browser could not save your data. Nothing was sent to Greyveil.';
    return false;
  }
};

const readPreviewShelf = () => {
  try {
    const saved = JSON.parse(localStorage.getItem(PREVIEW_SHELF_KEY) || '[]');
    if (!Array.isArray(saved)) throw new TypeError('The preview shelf must be a list.');
    return new Set(saved.filter((slug) => typeof slug === 'string'));
  } catch (error) {
    console.error('The local preview shelf could not be read.', error);
    $('#shelf-status').textContent = 'This browser could not open the local preview shelf. Greyveil account data is not affected.';
    return new Set();
  }
};

const updatePreviewShelf = () => {
  const container = $('#shelf-items');
  container.replaceChildren();
  const books = catalogue.books.filter((book) => savedBookSlugs.has(bookSlug(book.title)));
  if (!books.length) {
    container.append(make('p', 'shelf-empty', 'Your shelf is quiet. Save a book below to keep it nearby.'));
    return;
  }

  for (const book of books) {
    const row = make('div', 'shelf-item');
    const link = make('a', 'shelf-item-link', book.title);
    link.href = detailUrl(book);
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    const remove = make('button', 'shelf-remove', 'Remove');
    remove.type = 'button';
    remove.setAttribute('aria-label', `Remove ${book.title} from this browser's shelf`);
    remove.addEventListener('click', () => togglePreviewBook(book, false));
    row.append(link, remove);
    container.append(row);
  }
  $('#shelf-status').textContent = `${books.length} ${books.length === 1 ? 'title' : 'titles'} saved in this browser only—not in your Greyveil account.`;
};

const togglePreviewBook = (book, save) => {
  const slug = bookSlug(book.title);
  if (save) savedBookSlugs.add(slug);
  else savedBookSlugs.delete(slug);
  try {
    localStorage.setItem(PREVIEW_SHELF_KEY, JSON.stringify([...savedBookSlugs]));
    $('#shelf-status').textContent = savedBookSlugs.has(slug)
      ? `${book.title} is saved to this browser’s shelf.`
      : `${book.title} was removed from this browser’s shelf.`;
  } catch (error) {
    console.error('The local preview shelf could not be saved.', error);
    $('#shelf-status').textContent = 'This browser could not save your shelf. Your Greyveil account remains unchanged.';
    savedBookSlugs.delete(slug);
  }
  renderBooks();
  updatePreviewShelf();
};

const renderReadingHistory = () => {
  const container = $('#reading-history-list');
  const history = readLocalList(READING_HISTORY_KEY, '#privacy-status').slice(0, 20);
  container.replaceChildren();
  if (!history.length) {
    container.append(make('p', 'shelf-empty', 'Books you open from Greyveil will appear here.'));
    return;
  }
  history.forEach((entry) => {
    const row = make('div', 'history-item');
    const link = make('a', 'shelf-item-link', entry.title);
    link.href = entry.url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    const date = make('time', 'history-date', new Date(entry.visitedAt).toLocaleDateString());
    date.dateTime = entry.visitedAt;
    row.append(link, date);
    container.append(row);
  });
};

const recordReadingHistory = (book) => {
  const history = readLocalList(READING_HISTORY_KEY, '#privacy-status');
  const entry = {
    title: book.title,
    url: detailUrl(book),
    visitedAt: new Date().toISOString(),
  };
  const next = [entry, ...history.filter((item) => item.title !== entry.title)].slice(0, 20);
  if (writeLocalList(READING_HISTORY_KEY, next, '#privacy-status')) renderReadingHistory();
};

const renderReflections = () => {
  const container = $('#reflection-list');
  const reflections = readLocalList(REFLECTIONS_KEY, '#privacy-status');
  container.replaceChildren();
  if (!reflections.length) {
    container.append(make('p', 'shelf-empty', 'Letters you choose to keep on this device appear here.'));
    return;
  }
  reflections.forEach((entry) => {
    const row = make('article', 'saved-reflection');
    const heading = make('div', 'saved-reflection-head');
    heading.append(make('strong', '', entry.prompt || 'A private reflection'));
    const remove = make('button', 'shelf-remove', 'Delete');
    remove.type = 'button';
    remove.setAttribute('aria-label', 'Delete this private reflection from this device');
    remove.addEventListener('click', () => {
      const remaining = readLocalList(REFLECTIONS_KEY, '#privacy-status').filter((item) => item.id !== entry.id);
      if (writeLocalList(REFLECTIONS_KEY, remaining, '#privacy-status')) renderReflections();
    });
    heading.append(remove);
    row.append(heading, make('p', '', entry.body), make('time', 'history-date', new Date(entry.savedAt).toLocaleDateString()));
    container.append(row);
  });
};

const renderKeptLines = () => {
  const container = $('#lines-list');
  const lines = readLocalList(LINES_KEY, '#privacy-status');
  container.replaceChildren();
  if (!lines.length) {
    container.append(make('p', 'shelf-empty', 'Lines you choose to keep appear here.'));
    return;
  }
  lines.forEach((entry) => {
    const article = make('article', 'kept-line');
    article.append(make('p', '', `“${entry.line}”`), make('span', 'panel-tag', entry.source));
    const remove = make('button', 'shelf-remove', 'Delete');
    remove.type = 'button';
    remove.setAttribute('aria-label', 'Delete this saved line from this device');
    remove.addEventListener('click', () => {
      const remaining = readLocalList(LINES_KEY, '#privacy-status').filter((item) => item.id !== entry.id);
      if (writeLocalList(LINES_KEY, remaining, '#line-status')) renderKeptLines();
    });
    article.append(remove);
    container.append(article);
  });
};

const initializeLocalWriting = () => {
  const heard = $('#heard-note');
  try {
    heard.value = localStorage.getItem(HEARD_DRAFT_KEY) || '';
    $('#heard-count').textContent = `${heard.value.length} / 1600`;
    if (heard.value) $('#heard-status').textContent = 'Draft restored from this browser only. It has not been sent to Greyveil.';
  } catch (error) {
    console.error('The private Feel Heard draft could not be restored.', error);
    $('#heard-status').textContent = 'This browser could not restore the private draft. Nothing was sent to Greyveil.';
  }
  heard.addEventListener('input', () => {
    $('#heard-count').textContent = `${heard.value.length} / 1600`;
    try {
      localStorage.setItem(HEARD_DRAFT_KEY, heard.value);
      $('#heard-status').textContent = 'Saved privately in this browser only. Nothing was sent to Greyveil.';
    } catch (error) {
      console.error('The private Feel Heard draft could not be saved.', error);
      $('#heard-status').textContent = 'This browser could not save the private draft. Nothing was sent to Greyveil.';
    }
  });
  $('#clear-heard').addEventListener('click', () => {
    heard.value = '';
    $('#heard-count').textContent = '0 / 1600';
    try {
      localStorage.removeItem(HEARD_DRAFT_KEY);
      $('#heard-status').textContent = 'Private draft cleared from this browser.';
    } catch (error) {
      console.error('The private Feel Heard draft could not be cleared.', error);
      $('#heard-status').textContent = 'This browser could not clear the saved draft.';
    }
    heard.focus();
  });

  const letter = $('#reflection');
  letter.addEventListener('input', () => {
    $('#reflection-count').textContent = `${letter.value.length} / 1600`;
    $('#reflection-status').textContent = 'Not saved. Choose “Keep this letter” to store it on this device.';
  });
  $('#reflection-prompt').addEventListener('change', (event) => {
    if (!event.currentTarget.value) return;
    letter.placeholder = event.currentTarget.value;
    letter.focus();
    $('#reflection-status').textContent = 'Prompt selected. Your words are not saved until you choose to keep them.';
  });
  $('#clear-reflection').addEventListener('click', () => {
    letter.value = '';
    $('#reflection-count').textContent = '0 / 1600';
    $('#reflection-status').textContent = 'Cleared from this page. No saved reflection was changed.';
    letter.focus();
  });
  $('#save-reflection').addEventListener('click', () => {
    const body = letter.value.trim();
    if (!body) {
      $('#reflection-status').textContent = 'Write a few words before saving a letter.';
      letter.focus();
      return;
    }
    const reflections = readLocalList(REFLECTIONS_KEY, '#privacy-status');
    reflections.unshift({
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      prompt: $('#reflection-prompt').value || 'A letter to your future self',
      body,
      savedAt: new Date().toISOString(),
    });
    if (writeLocalList(REFLECTIONS_KEY, reflections.slice(0, 50), '#reflection-status')) {
      letter.value = '';
      $('#reflection-count').textContent = '0 / 1600';
      $('#reflection-status').textContent = 'Saved only in this browser. You can review or delete it in My Space.';
      renderReflections();
    }
  });

  $('#clear-local-data').addEventListener('click', () => {
    if (!window.confirm('Clear Greyveil bookmarks, history, and private writing saved in this browser? This cannot be undone.')) return;
    try {
      [PREVIEW_SHELF_KEY, READING_HISTORY_KEY, REFLECTIONS_KEY, LINES_KEY, HEARD_DRAFT_KEY].forEach((key) => localStorage.removeItem(key));
      savedBookSlugs = new Set();
      heard.value = '';
      $('#reflection').value = '';
      $('#line-form').reset();
      $('#reflection-count').textContent = '0 / 1600';
      $('#heard-count').textContent = '0 / 1600';
      $('#heard-status').textContent = 'Private draft cleared from this browser.';
      $('#reflection-status').textContent = 'Private letter cleared from this browser.';
      $('#line-status').textContent = 'Saved lines cleared from this browser.';
      $('#privacy-status').textContent = 'Browser-saved Greyveil data cleared from this device. Your Greyveil account and purchases are unchanged.';
      updatePreviewShelf();
      renderReadingHistory();
      renderReflections();
      renderKeptLines();
    } catch (error) {
      console.error('Greyveil browser data could not be cleared.', error);
      $('#privacy-status').textContent = 'This browser could not clear all saved data. Your Greyveil account and purchases are unchanged.';
    }
  });

  renderReadingHistory();
  renderReflections();
  renderKeptLines();

  $('#line-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const source = $('#line-source').value.trim();
    const line = $('#kept-line').value.trim();
    if (!source || !line) {
      $('#line-status').textContent = 'Add a source and a line before saving.';
      return;
    }
    const lines = readLocalList(LINES_KEY, '#line-status');
    lines.unshift({
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      source,
      line,
      savedAt: new Date().toISOString(),
    });
    if (writeLocalList(LINES_KEY, lines.slice(0, 100), '#line-status')) {
      event.currentTarget.reset();
      $('#line-status').textContent = 'Saved only in this browser. You can delete it here or clear local data in My Space.';
      renderKeptLines();
    }
  });
};

const signInUrl = () => {
  const next = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  const url = new URL('https://greyveileditions.site/auth/login/');
  url.searchParams.set('next', next || '/');
  return url.href;
};

const statusMessage = (selector, message) => {
  const node = $(selector);
  if (node) node.textContent = message;
};

const renderCommunityStories = (stories) => {
  const container = $('#community-stories-list');
  container.replaceChildren();
  if (!stories.length) {
    container.append(make('p', 'community-status', 'No reader stories have been approved for public sharing yet. Private submissions remain private.'));
    return;
  }
  stories.forEach((story) => {
    const article = make('article', 'community-story');
    article.append(make('span', 'panel-tag', 'A STORY SHARED WITH PERMISSION'));
    article.append(make('h3', '', story.title));
    article.append(make('p', 'community-story-copy', story.story));
    article.append(make('p', 'community-byline', `${story.byline} · ${new Date(story.published_at).toLocaleDateString()}`));
    const report = make('details', 'story-report');
    const summary = make('summary', '', 'Report this story');
    const form = document.createElement('form');
    form.className = 'story-report-form';
    const reasonLabel = make('label', '', 'Reason for reporting');
    const reason = document.createElement('select');
    reason.name = 'reason';
    reason.required = true;
    [
      ['privacy', 'Privacy or consent concern'],
      ['safety', 'Safety concern'],
      ['copyright', 'Copyright concern'],
      ['other', 'Another concern'],
    ].forEach(([value, label]) => {
      const option = make('option', '', label);
      option.value = value;
      reason.append(option);
    });
    reasonLabel.append(reason);
    const detailLabel = make('label', '', 'Additional context (optional)');
    const detail = document.createElement('textarea');
    detail.name = 'details';
    detail.maxLength = 1000;
    detailLabel.append(detail);
    const submit = make('button', 'button button-outline', 'Send private report');
    submit.type = 'submit';
    const feedback = make('p', 'panel-note', '');
    feedback.setAttribute('role', 'status');
    form.append(reasonLabel, detailLabel, submit, feedback);
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (!currentReader) {
        feedback.textContent = 'Sign in to send a private report.';
        window.open(signInUrl(), '_blank', 'noopener');
        return;
      }
      submit.disabled = true;
      let error;
      try {
        ({ error } = await supabaseClient.from('story_reports').insert({
          story_id: story.id,
          reporter_id: currentReader.id,
          reason: reason.value,
          details: detail.value.trim() || null,
        }));
      } catch (requestError) {
        console.error('A Greyveil story report request failed.', requestError);
        feedback.textContent = 'Your report could not be sent. Please try again or contact Greyveil.';
        submit.disabled = false;
        return;
      }
      submit.disabled = false;
      if (error) {
        console.error('A Greyveil story report could not be sent.', error);
        feedback.textContent = error.code === '23505'
          ? 'You have already reported this story.'
          : 'Your report could not be sent. Please try again or contact Greyveil.';
        return;
      }
      feedback.textContent = 'Your report was sent privately to the Greyveil editorial team.';
      submit.disabled = true;
    });
    report.append(summary, form);
    article.append(report);
    container.append(article);
  });
};

const renderMyStories = (submissions) => {
  const container = $('#my-stories-list');
  container.replaceChildren();
  if (!submissions.length) {
    container.append(make('p', 'panel-note', 'No story submissions are attached to this account.'));
    return;
  }
  submissions.forEach((submission) => {
    const article = make('article', 'submission-item');
    const status = {
      pending: 'Awaiting editorial review',
      in_review: 'Private review in progress',
      responded: 'A personal response is available',
      published: submission.publicationWithdrawn
        ? 'Public permission withdrawn; this story is no longer listed'
        : 'Published with your permission',
      declined: 'Reviewed; not approved for publication',
    }[submission.status] || 'Submission status unavailable';
    article.append(make('p', 'panel-tag', status));
    article.append(make('h4', '', submission.title));
    article.append(make('p', 'submission-meta', `Sent ${new Date(submission.created_at).toLocaleDateString()} · Response request: ${responseCategoryLabels[submission.response_request] || 'Listening'} · ${submission.is_anonymous ? 'Anonymous public display preference' : 'Public byline display preference'}`));
    if (submission.moderation_response) {
      const notice = make('div', 'submission-response');
      notice.append(make('strong', '', 'Editorial status note'), make('p', '', submission.moderation_response));
      article.append(notice);
    }

    if (submission.responses.length) {
      const responses = make('section', 'submission-responses');
      responses.append(make('h5', '', 'Personal editor responses'));
      submission.responses.forEach((response) => {
        const responseCard = make('article', 'personal-response');
        responseCard.append(make('p', 'panel-tag', `${responseCategoryLabels[response.response_category] || 'Personal response'} · Written by a Greyveil editor`));
        responseCard.append(make('time', 'history-date', new Date(response.created_at).toLocaleDateString()));
        responseCard.append(make('p', 'personal-response-copy', response.response_text));
        if (response.response_origin !== 'personal') {
          responseCard.append(make('p', 'panel-note', 'This response was not identified as personally written by an editor.'));
        }
        const recommendations = (response.recommended_book_slugs || [])
          .map((slug) => catalogue?.books.find((book) => bookSlug(book.title) === slug))
          .filter(Boolean);
        if (recommendations.length) {
          const reading = make('div', 'response-reading');
          reading.append(make('strong', '', 'Optional Greyveil reading suggestions'));
          recommendations.forEach((book) => {
            const link = make('a', '', `${book.title} ↗`);
            link.href = detailUrl(book);
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
            link.addEventListener('click', () => recordReadingHistory(book));
            reading.append(link);
          });
          responseCard.append(reading);
        }
        const essays = (response.recommended_essay_slugs || [])
          .map((slug) => editorialNotes.find((note) => note.slug === slug))
          .filter(Boolean);
        if (essays.length) {
          const reading = make('div', 'response-reading');
          reading.append(make('strong', '', 'Optional Greyveil Reading Room essays'));
          essays.forEach((essay) => {
            const essayIndex = editorialNotes.indexOf(essay);
            const link = make('a', '', `${essay.kicker} ↗`);
            link.href = '#mind';
            link.addEventListener('click', (event) => {
              event.preventDefault();
              selectEditorialNote(essayIndex);
              $('#mind').scrollIntoView({ behavior: 'smooth', block: 'start' });
            });
            reading.append(link);
          });
          responseCard.append(reading);
        }
        if (response.read_at) {
          responseCard.append(make('p', 'panel-note', `Read ${new Date(response.read_at).toLocaleDateString()}`));
        } else {
          const markRead = make('button', 'shelf-remove', 'Mark response as read');
          markRead.type = 'button';
          markRead.addEventListener('click', async () => {
            markRead.disabled = true;
            let error;
            try {
              ({ error } = await supabaseClient.from('story_responses')
                .update({ read_at: new Date().toISOString() })
                .eq('id', response.id)
                .eq('story_id', submission.id)
                .is('read_at', null));
            } catch (requestError) {
              console.error('The personal response read status could not be updated.', requestError);
              markRead.disabled = false;
              statusMessage('#story-status', 'The response could not be marked as read. No response content was changed.');
              return;
            }
            if (error) {
              console.error('The personal response read status could not be updated.', error);
              markRead.disabled = false;
              statusMessage('#story-status', 'The response could not be marked as read. No response content was changed.');
              return;
            }
            await loadMyStories();
          });
          responseCard.append(markRead);
        }
        responses.append(responseCard);
      });
      article.append(responses);
    } else {
      article.append(make('p', 'panel-note', 'No personal editor response is available for this submission.'));
    }

    if (submission.public_consent && !submission.publicationWithdrawn) {
      const withdraw = make('button', 'shelf-remove', 'Withdraw public-sharing permission');
      withdraw.type = 'button';
      withdraw.addEventListener('click', async () => {
        if (!window.confirm('Withdraw public-sharing permission? If the story is published, it will be removed from the public collection. Your private submission remains unless you also delete it.')) return;
        withdraw.disabled = true;
        let error;
        try {
          ({ error } = await supabaseClient.rpc('greyveil_withdraw_story_publication', { p_story_id: submission.id }));
        } catch (requestError) {
          console.error('Public-sharing permission could not be withdrawn.', requestError);
          withdraw.disabled = false;
          statusMessage('#story-status', 'Public-sharing permission could not be withdrawn. Please try again.');
          return;
        }
        if (error) {
          console.error('Public-sharing permission could not be withdrawn.', error);
          withdraw.disabled = false;
          statusMessage('#story-status', 'Public-sharing permission could not be withdrawn. Please try again.');
          return;
        }
        statusMessage('#story-status', 'Public-sharing permission withdrawn. The original consent record is retained, and this story will no longer appear in the public collection.');
        await loadMyStories();
        await loadCommunityStories();
      });
      article.append(withdraw);
    }

    const remove = make('button', 'shelf-remove', 'Delete submission');
    remove.type = 'button';
    remove.addEventListener('click', async () => {
      if (!window.confirm('Permanently delete this submission, its responses and notes? If published, it will also be removed from the public collection.')) return;
      remove.disabled = true;
      let error;
      try {
        ({ error } = await supabaseClient.from('story_submissions').delete().eq('id', submission.id).eq('author_id', currentReader.id));
      } catch (requestError) {
        console.error('The Greyveil story deletion request failed.', requestError);
        remove.disabled = false;
        statusMessage('#story-status', 'The story could not be deleted. Please try again or contact Greyveil.');
        return;
      }
      if (error) {
        console.error('The Greyveil story submission could not be deleted.', error);
        remove.disabled = false;
        statusMessage('#story-status', 'The story could not be deleted. Please try again or contact Greyveil.');
        return;
      }
      statusMessage('#story-status', 'Your story and its public copy have been deleted.');
      await loadMyStories();
      await loadCommunityStories();
    });
    article.append(remove);
    container.append(article);
  });
};

const loadMyStories = async () => {
  if (!currentReader || !supabaseClient) return;
  const container = $('#my-stories-list');
  container.replaceChildren(make('p', 'panel-note', 'Loading your private submissions…'));
  let data;
  let error;
  try {
    ({ data, error } = await supabaseClient
      .from('story_submissions')
      .select('id, title, status, moderation_response, created_at, response_request, is_anonymous, public_consent')
      .eq('author_id', currentReader.id)
      .order('created_at', { ascending: false }));
  } catch (requestError) {
    console.error('Greyveil story-submission status request failed.', requestError);
    container.replaceChildren(make('p', 'panel-note', 'Submission status is unavailable. The stories were not changed.'));
    return;
  }
  if (error) {
    console.error('Greyveil story-submission status could not be loaded.', error);
    container.replaceChildren(make('p', 'panel-note', 'Submission status is unavailable. The stories were not changed.'));
    return;
  }
  const submissions = data || [];
  if (!submissions.length) {
    renderMyStories([]);
    return;
  }
  const storyIds = submissions.map((submission) => submission.id);
  let responses;
  let withdrawals;
  try {
    const [responseResult, withdrawalResult] = await Promise.all([
      supabaseClient.from('story_responses')
        .select('id, story_id, response_category, response_text, response_origin, recommended_book_slugs, recommended_essay_slugs, created_at, read_at')
        .in('story_id', storyIds)
        .order('created_at', { ascending: false }),
      supabaseClient.from('story_publication_withdrawals')
        .select('story_id')
        .in('story_id', storyIds),
    ]);
    if (responseResult.error) throw responseResult.error;
    if (withdrawalResult.error) throw withdrawalResult.error;
    responses = responseResult.data || [];
    withdrawals = withdrawalResult.data || [];
  } catch (requestError) {
    console.error('Private Greyveil response history could not be loaded.', requestError);
    container.replaceChildren(make('p', 'panel-note', 'Your submissions are available, but response history or privacy status could not be loaded. Please try again.'));
    return;
  }
  const withdrawnIds = new Set(withdrawals.map((entry) => entry.story_id));
  const responsesByStory = new Map();
  responses.forEach((response) => {
    const list = responsesByStory.get(response.story_id) || [];
    list.push(response);
    responsesByStory.set(response.story_id, list);
  });
  renderMyStories(submissions.map((submission) => ({
    ...submission,
    publicationWithdrawn: withdrawnIds.has(submission.id),
    responses: responsesByStory.get(submission.id) || [],
  })));
};

const renderEditorialQueue = () => {
  const container = $('#editorial-queue');
  const query = $('#inbox-search').value.trim().toLocaleLowerCase();
  const statusFilter = $('#inbox-filter').value;
  const submissions = editorialSubmissions.filter((submission) => {
    const matchesStatus = !statusFilter || submission.status === statusFilter;
    const haystack = [
      submission.title,
      submission.story,
      submission.author_display_name,
      submission.response_request,
      submission.status,
    ].join(' ').toLocaleLowerCase();
    return matchesStatus && (!query || haystack.includes(query));
  });
  container.replaceChildren();
  if (!submissions.length) {
    container.append(make('p', 'panel-note', editorialSubmissions.length
      ? 'No submissions match these filters.'
      : 'No story submissions are in the private inbox.'));
    return;
  }
  submissions.forEach((submission) => {
    const item = make('article', 'moderation-item');
    const open = make('button', 'inbox-open-story');
    open.type = 'button';
    open.setAttribute('aria-expanded', String(selectedEditorialSubmissionId === submission.id));
    open.append(
      make('span', 'panel-tag', `${submission.status.toUpperCase()} · ${new Date(submission.created_at).toLocaleDateString()}`),
      make('strong', '', submission.title),
      make('span', 'moderation-byline', `${submission.is_anonymous ? 'Anonymous display requested' : submission.author_display_name || 'No public byline'} · Public permission ${submission.public_consent ? 'recorded' : 'not given'}${submission.publicationWithdrawn ? ' · withdrawn' : ''}`),
    );
    open.addEventListener('click', () => openEditorialSubmission(submission.id));
    item.append(open);
    container.append(item);
  });
};

const openEditorialSubmission = async (storyId) => {
  const submission = editorialSubmissions.find((entry) => entry.id === storyId);
  if (!submission) return;
  selectedEditorialSubmissionId = storyId;
  $('#inbox-detail').hidden = false;
  $('#inbox-story-title').textContent = submission.title;
  $('#inbox-story-text').textContent = submission.story;
  $('#inbox-story-meta').replaceChildren(
    make('p', '', `Status: ${submission.status.replace('_', ' ')} · Submitted ${new Date(submission.created_at).toLocaleString()}`),
    make('p', '', `Response requested: ${responseCategoryLabels[submission.response_request] || 'Listening'}`),
    make('p', '', `Name for public display: ${submission.is_anonymous ? 'Anonymous' : submission.author_display_name || 'A Greyveil reader'}`),
    make('p', '', `Private review consent recorded: ${submission.private_consent_at ? new Date(submission.private_consent_at).toLocaleString() : 'timestamp unavailable'}`),
    make('p', '', `Separate public-sharing consent: ${submission.public_consent ? `recorded ${submission.public_consent_at ? new Date(submission.public_consent_at).toLocaleString() : ''}` : 'not given'}${submission.publicationWithdrawn ? ' · subsequently withdrawn' : ''}`),
    make('p', '', `Submission ID: ${submission.id}`),
  );
  $('#internal-note-status').textContent = '';
  $('#response-status').textContent = '';
  $('#internal-note').value = '';
  $('#response-text').value = '';
  $('#response-category').value = submission.response_request || 'listening';
  renderInboxModerationActions(submission);
  renderEditorialQueue();

  const notesContainer = $('#inbox-notes-list');
  const responseContainer = $('#inbox-response-history');
  notesContainer.replaceChildren(make('p', 'panel-note', 'Loading private notes…'));
  responseContainer.replaceChildren(make('p', 'panel-note', 'Loading personal response history…'));
  let notes;
  let responses;
  try {
    const [notesResult, responsesResult] = await Promise.all([
      supabaseClient.from('story_internal_notes')
        .select('id, author_id, note, created_at')
        .eq('story_id', storyId)
        .order('created_at', { ascending: false }),
      supabaseClient.from('story_responses')
        .select('id, responder_id, response_category, response_text, recommended_book_slugs, recommended_essay_slugs, created_at, read_at')
        .eq('story_id', storyId)
        .order('created_at', { ascending: false }),
    ]);
    if (notesResult.error) throw notesResult.error;
    if (responsesResult.error) throw responsesResult.error;
    notes = notesResult.data || [];
    responses = responsesResult.data || [];
  } catch (requestError) {
    console.error('The private submission history could not be loaded.', requestError);
    notesContainer.replaceChildren(make('p', 'panel-note', 'Private notes could not be loaded.'));
    responseContainer.replaceChildren(make('p', 'panel-note', 'Personal response history could not be loaded.'));
    return;
  }
  notesContainer.replaceChildren();
  if (!notes.length) notesContainer.append(make('p', 'panel-note', 'No private internal notes yet.'));
  notes.forEach((note) => {
    const entry = make('article', 'inbox-history-item');
    entry.append(make('p', '', note.note), make('time', 'history-date', new Date(note.created_at).toLocaleString()));
    notesContainer.append(entry);
  });
  responseContainer.replaceChildren();
  if (!responses.length) responseContainer.append(make('p', 'panel-note', 'No personal responses have been sent.'));
  responses.forEach((response) => {
    const entry = make('article', 'inbox-history-item');
    const suggestedBooks = (response.recommended_book_slugs || [])
      .map((slug) => catalogue?.books.find((book) => bookSlug(book.title) === slug)?.title)
      .filter(Boolean);
    const suggestedEssays = (response.recommended_essay_slugs || [])
      .map((slug) => editorialNotes.find((essay) => essay.slug === slug)?.kicker)
      .filter(Boolean);
    entry.append(
      make('p', 'panel-tag', `${responseCategoryLabels[response.response_category] || 'Personal response'} · ${new Date(response.created_at).toLocaleString()}`),
      make('p', '', response.response_text),
      make('p', 'panel-note', response.read_at ? `Reader marked this response read ${new Date(response.read_at).toLocaleString()}.` : 'Not yet marked as read by the reader.'),
    );
    if (suggestedBooks.length || suggestedEssays.length) {
      entry.append(make('p', 'panel-note', `Suggested reading: ${[...suggestedBooks, ...suggestedEssays].join(' · ')}`));
    }
    responseContainer.append(entry);
  });
  renderInboxModerationActions(submission);
};

const renderInboxModerationActions = (submission) => {
  const actions = $('#inbox-moderation-actions');
  actions.replaceChildren();
  const makeAction = (label, status, className) => {
    const button = make('button', className, label);
    button.type = 'button';
    button.addEventListener('click', () => moderateSubmission(submission, status, button));
    actions.append(button);
  };
  if (submission.status !== 'in_review' && submission.status !== 'published') {
    makeAction('Mark private review in progress', 'in_review', 'button button-outline');
  }
  if (submission.public_consent && !submission.publicationWithdrawn && submission.status !== 'published') {
    makeAction('Approve for public sharing', 'published', 'button button-dark');
  }
  if (submission.status !== 'declined' && submission.status !== 'published') {
    makeAction('Decline public publication', 'declined', 'button button-outline');
  }
  if (!submission.public_consent || submission.publicationWithdrawn) {
    actions.append(make('p', 'panel-note', 'Public approval is unavailable: separate consent is absent or has been withdrawn.'));
  }
};

const moderateSubmission = async (submission, status, button) => {
  if (!currentReader || button.disabled) return;
  if (status === 'published' && (!submission.public_consent || submission.publicationWithdrawn)) return;
  button.disabled = true;
  let error;
  try {
    ({ error } = await supabaseClient.rpc('greyveil_admin_update_story_status', {
      p_story_id: submission.id,
      p_status: status,
    }));
  } catch (requestError) {
    console.error('The Greyveil story moderation request failed.', requestError);
    statusMessage('#inbox-status', 'The submission status could not be changed. No public story was created.');
    button.disabled = false;
    return;
  }
  if (error) {
    console.error('The Greyveil story could not be moderated.', error);
    statusMessage('#inbox-status', 'The submission status could not be changed. Check administrator access and consent.');
    button.disabled = false;
    return;
  }
  statusMessage('#inbox-status', `Submission status updated to ${status.replace('_', ' ')}.`);
  await Promise.all([loadEditorialQueue(), loadCommunityStories(), loadMyStories()]);
  if (editorialSubmissions.some((entry) => entry.id === submission.id)) await openEditorialSubmission(submission.id);
};

const loadEditorialQueue = async () => {
  const pageSize = 500;
  const submissions = [];
  let offset = 0;
  try {
    while (true) {
      const { data, error } = await supabaseClient
        .from('story_submissions')
        .select('id, author_id, title, story, author_display_name, is_anonymous, response_request, private_consent_at, public_consent, public_consent_at, status, moderation_response, created_at')
        .order('created_at', { ascending: true })
        .range(offset, offset + pageSize - 1);
      if (error) throw error;
      submissions.push(...(data || []));
      if (!data || data.length < pageSize) break;
      offset += pageSize;
    }
    if (submissions.length) {
      const { data: withdrawals, error } = await supabaseClient
        .from('story_publication_withdrawals')
        .select('story_id')
        .in('story_id', submissions.map((submission) => submission.id));
      if (error) throw error;
      const withdrawnIds = new Set((withdrawals || []).map((entry) => entry.story_id));
      submissions.forEach((submission) => {
        submission.publicationWithdrawn = withdrawnIds.has(submission.id);
      });
    }
  } catch (requestError) {
    console.error('Greyveil story-moderation queue request failed.', requestError);
    $('#editorial-queue').replaceChildren(make('p', 'panel-note', 'The private Human Inbox could not be loaded. Check the installed Greyveil 2.0 schema and administrator access.'));
    return false;
  }
  editorialSubmissions = submissions;
  renderEditorialQueue();
  if (selectedEditorialSubmissionId && editorialSubmissions.some((entry) => entry.id === selectedEditorialSubmissionId)) {
    renderInboxModerationActions(editorialSubmissions.find((entry) => entry.id === selectedEditorialSubmissionId));
  } else if (selectedEditorialSubmissionId) {
    selectedEditorialSubmissionId = null;
    $('#inbox-detail').hidden = true;
  }
  return true;
};

const initializeEditorialControls = () => {
  $('#inbox-search').addEventListener('input', renderEditorialQueue);
  $('#inbox-filter').addEventListener('change', renderEditorialQueue);
  $('#refresh-inbox').addEventListener('click', async () => {
    statusMessage('#inbox-status', 'Refreshing private submissions and reader reports…');
    const [queueReady, reportsReady] = await Promise.all([loadEditorialQueue(), loadEditorialReports()]);
    statusMessage('#inbox-status', queueReady && reportsReady
      ? 'Human Inbox and reader reports refreshed.'
      : 'One or more private inbox views could not be refreshed. See the messages below.');
  });
  $('#close-inbox-detail').addEventListener('click', () => {
    selectedEditorialSubmissionId = null;
    $('#inbox-detail').hidden = true;
    renderEditorialQueue();
  });
  $('#internal-note-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!selectedEditorialSubmissionId) return;
    const button = event.currentTarget.querySelector('button[type="submit"]');
    button.disabled = true;
    let data;
    let error;
    try {
      ({ data, error } = await supabaseClient.rpc('greyveil_admin_save_story_note', {
        p_story_id: selectedEditorialSubmissionId,
        p_note: $('#internal-note').value.trim(),
      }));
    } catch (requestError) {
      console.error('The private editorial note could not be saved.', requestError);
      statusMessage('#internal-note-status', 'The private note could not be saved. Please try again.');
      button.disabled = false;
      return;
    }
    button.disabled = false;
    if (error) {
      console.error('The private editorial note could not be saved.', error);
      statusMessage('#internal-note-status', 'The private note could not be saved. Check administrator access and try again.');
      return;
    }
    event.currentTarget.reset();
    await openEditorialSubmission(selectedEditorialSubmissionId);
    statusMessage('#internal-note-status', 'Private note saved for authorised editors.');
  });
  $('#personal-response-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!selectedEditorialSubmissionId) return;
    const button = $('#send-personal-response');
    const recommendations = Array.from($('#response-recommendations').selectedOptions).map((option) => option.value);
    const essayRecommendations = Array.from($('#response-essay-recommendations').selectedOptions).map((option) => option.value);
    if (recommendations.length > 3 || essayRecommendations.length > 3) {
      statusMessage('#response-status', 'Choose no more than three reading suggestions.');
      return;
    }
    button.disabled = true;
    let error;
    try {
      ({ error } = await supabaseClient.rpc('greyveil_admin_respond_to_story', {
        p_story_id: selectedEditorialSubmissionId,
        p_category: $('#response-category').value,
        p_response: $('#response-text').value.trim(),
        p_recommended_book_slugs: recommendations,
        p_recommended_essay_slugs: essayRecommendations,
      }));
    } catch (requestError) {
      console.error('The private personal response could not be sent.', requestError);
      statusMessage('#response-status', 'The response was not sent. Check the installed Greyveil 2.0 schema and try again.');
      button.disabled = false;
      return;
    }
    button.disabled = false;
    if (error) {
      console.error('The private personal response could not be sent.', error);
      statusMessage('#response-status', 'The response was not sent. Check administrator access and the selected book suggestions.');
      return;
    }
    $('#response-text').value = '';
    await Promise.all([loadEditorialQueue(), loadMyStories()]);
    if (selectedEditorialSubmissionId) await openEditorialSubmission(selectedEditorialSubmissionId);
    statusMessage('#response-status', 'Personal response saved and delivered to the reader’s private My Space. No email or immediate response was promised.');
  });
  $('#delete-submission').addEventListener('click', async (event) => {
    const submission = editorialSubmissions.find((entry) => entry.id === selectedEditorialSubmissionId);
    if (!submission || !window.confirm('Permanently delete this submission, its responses, notes and reports? This cannot be undone.')) return;
    const button = event.currentTarget;
    button.disabled = true;
    let error;
    try {
      ({ error } = await supabaseClient.from('story_submissions').delete().eq('id', submission.id));
    } catch (requestError) {
      console.error('The administrator story deletion failed.', requestError);
      statusMessage('#inbox-status', 'The story could not be deleted. No data was changed.');
      button.disabled = false;
      return;
    }
    if (error) {
      console.error('The administrator story deletion failed.', error);
      statusMessage('#inbox-status', 'The story could not be deleted. Check administrator permissions and try again.');
      button.disabled = false;
      return;
    }
    selectedEditorialSubmissionId = null;
    $('#inbox-detail').hidden = true;
    statusMessage('#inbox-status', 'Submission and its linked private records were deleted.');
    await Promise.all([loadEditorialQueue(), loadEditorialReports(), loadCommunityStories()]);
  });
};

const loadEditorialReports = async () => {
  const container = $('#editorial-reports');
  let data;
  let error;
  try {
    ({ data, error } = await supabaseClient
      .from('story_reports')
      .select('id, story_id, reporter_id, reason, details, status, created_at')
      .eq('status', 'open')
      .order('created_at', { ascending: true }));
  } catch (requestError) {
    console.error('Greyveil story-report request failed.', requestError);
    container.replaceChildren(make('p', 'panel-note', 'Reader reports could not be loaded.'));
    return false;
  }
  if (error) {
    console.error('Greyveil story reports could not be loaded.', error);
    container.replaceChildren(make('p', 'panel-note', 'Reader reports could not be loaded.'));
    return false;
  }
  container.replaceChildren();
  if (!data?.length) {
    container.append(make('p', 'panel-note', 'No reader reports are awaiting review.'));
    return true;
  }
  data.forEach((report) => {
    const article = make('article', 'moderation-item');
    article.append(make('p', 'panel-tag', `${report.reason.toUpperCase()} · ${new Date(report.created_at).toLocaleDateString()}`));
    article.append(make('p', 'moderation-story', report.details || 'No additional context supplied.'));
    const resolve = make('button', 'button button-outline', 'Mark report reviewed');
    resolve.type = 'button';
    resolve.addEventListener('click', async () => {
      resolve.disabled = true;
      let updateError;
      try {
        ({ error: updateError } = await supabaseClient.from('story_reports')
          .update({ status: 'resolved', reviewed_at: new Date().toISOString() })
          .eq('id', report.id));
      } catch (requestError) {
        console.error('The Greyveil report review request failed.', requestError);
        resolve.disabled = false;
        return;
      }
      if (updateError) {
        console.error('The Greyveil story report could not be updated.', updateError);
        resolve.disabled = false;
        return;
      }
      await loadEditorialReports();
    });
    article.append(resolve);
    container.append(article);
  });
  return true;
};

const populateRecommendationOptions = () => {
  const select = $('#response-recommendations');
  const essaySelect = $('#response-essay-recommendations');
  if (!select || !essaySelect || !catalogue?.books) return;
  select.replaceChildren();
  catalogue.books.forEach((book) => {
    const option = make('option', '', book.title);
    option.value = bookSlug(book.title);
    select.append(option);
  });
  essaySelect.replaceChildren();
  editorialNotes.forEach((essay) => {
    const option = make('option', '', essay.kicker);
    option.value = essay.slug;
    essaySelect.append(option);
  });
};

const initializeGreyveilServices = async () => {
  const login = $('.story-login');
  login.href = signInUrl();
  if (!siteAssetsAvailable) {
    statusMessage('#story-status', 'This standalone design preview does not connect to Greyveil accounts or send stories. Nothing is saved or sent.');
    statusMessage('#community-status', 'Public reader stories are not loaded in this standalone design preview.');
    statusMessage('#inbox-status', 'The authorised Human Inbox is not connected in this standalone design preview.');
    return;
  }
  try {
    const auth = await import('../assets/js/supabase-client.js');
    supabaseClient = auth.supabase;
    const { data, error } = await supabaseClient.auth.getUser();
    if (error && error.name !== 'AuthSessionMissingError') throw error;
    currentReader = data?.user || null;

    if (currentReader) {
      login.hidden = true;
      statusMessage('#story-status', 'Checking the private story service…');
      await loadMyStories();
      const { data: profile, error: profileError } = await supabaseClient
        .from('profiles')
        .select('role')
        .eq('id', currentReader.id)
        .maybeSingle();
      if (profileError) {
        console.error('Greyveil editorial permissions could not be checked.', profileError);
      } else if (['admin', 'super_admin'].includes(profile?.role)) {
        $('#editorial-desk').hidden = false;
        $('#editorial-desk-link').hidden = false;
        initializeEditorialControls();
        populateRecommendationOptions();
        statusMessage('#inbox-status', 'Administrator access confirmed. Private submissions remain protected by Supabase row-level security.');
        await Promise.all([loadEditorialQueue(), loadEditorialReports()]);
      }
    } else {
      statusMessage('#story-status', 'Sign in to send a story privately and manage its status or deletion. Your writing on this form is not saved or sent.');
    }
  } catch (error) {
    console.error('Greyveil story services could not be initialized.', error);
    $('#story-submit').disabled = true;
    statusMessage('#story-status', 'Greyveil story services are not available here. Nothing was saved or sent.');
  }

  if (!supabaseClient) {
    statusMessage('#community-status', 'Greyveil’s story service could not be reached. No reader stories are shown.');
    return;
  }
  await loadCommunityStories();
};

const loadCommunityStories = async () => {
  if (!supabaseClient) return;
  storyServiceReady = false;
  $('#story-submit').disabled = true;
  let data;
  let error;
  try {
    ({ data, error } = await supabaseClient.rpc('get_public_greyveil_stories'));
  } catch (requestError) {
    console.error('The Greyveil public story request failed.', requestError);
    statusMessage('#community-status', 'The public story collection is temporarily unavailable. No unreviewed or private stories are shown.');
    $('#story-submit').disabled = true;
    statusMessage('#story-status', 'Greyveil story submissions are not available here. Nothing was saved or sent.');
    return;
  }
  if (error) {
    console.error('Approved public Greyveil stories could not be loaded.', error);
    const notConfigured = error.code === 'PGRST202' || error.code === 'PGRST205';
    statusMessage('#community-status', notConfigured
      ? 'The Supabase story service is not configured. No unreviewed or private stories are shown.'
      : 'The public story collection is temporarily unavailable. No unreviewed or private stories are shown.');
    $('#story-submit').disabled = true;
    statusMessage('#story-status', notConfigured
      ? 'The Greyveil story service is not installed. The required Supabase migration has not been applied. Nothing was saved or sent.'
      : 'Greyveil story submissions are temporarily unavailable. Nothing was saved or sent.');
    return;
  }
  storyServiceReady = true;
  $('#story-submit').disabled = !currentReader;
  statusMessage('#story-status', currentReader
    ? 'Your submission stays private until reviewed. Public publication also requires your separate permission above.'
    : 'Sign in to send a story privately and manage its status or deletion. Your writing on this form is not saved or sent.');
  renderCommunityStories(data || []);
};

const renderBooks = () => {
  const query = $('#book-search').value.trim().toLocaleLowerCase();
  const selectedSeries = $('#series-filter').value;
  const filtered = catalogue.books.filter((book) => {
    const text = `${book.title} ${book.series} ${book.volume} ${book.core_question} ${book.key_topics} ${book.reader_situation}`.toLocaleLowerCase();
    return (!selectedSeries || book.series === selectedSeries) && (!query || text.includes(query));
  });
  const grid = $('#book-grid');
  grid.replaceChildren();
  $('#results-count').textContent = `${filtered.length} of ${catalogue.books.length} titles in the existing editorial guide`;

  if (!filtered.length) {
    const empty = make('p', 'empty-state', 'No titles match this search. Try another word or series.');
    grid.append(empty);
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const book of filtered) {
    const card = make('article', 'book-card');
    const cover = make('div', 'book-cover');
    const placeholder = make('div', 'cover-placeholder');
    placeholder.append(make('span', '', 'GREYVEIL EDITIONS · STORIES THAT STAY WITHIN'), make('strong', '', book.title), make('span', '', book.series));
    cover.append(placeholder);
    const imageSource = coverUrl(book);
    if (imageSource) {
      const image = make('img');
      image.src = imageSource;
      image.alt = `${book.title} book cover`;
      image.loading = 'lazy';
      image.addEventListener('error', () => image.remove(), { once: true });
      cover.append(image);
    }

    const meta = make('div', 'book-meta');
    meta.append(make('span', '', `VOL. ${book.volume} · ${book.series_book_number ? String(book.series_book_number).padStart(2, '0') : String(book.journey_number).padStart(2, '0')}`));
    card.append(cover, meta, make('h3', 'book-title', book.title), make('p', 'book-question', book.core_question));
    const link = make('a', 'book-link', 'Explore this title ↗');
    link.href = detailUrl(book);
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.setAttribute('aria-label', `Open ${book.title} on the existing Greyveil website in a new tab`);
    link.addEventListener('click', () => recordReadingHistory(book));
    const save = make('button', 'save-book', savedBookSlugs.has(bookSlug(book.title)) ? 'Saved to this browser ✓' : 'Keep nearby +');
    save.type = 'button';
    save.setAttribute('aria-pressed', String(savedBookSlugs.has(bookSlug(book.title))));
    save.setAttribute('aria-label', `${savedBookSlugs.has(bookSlug(book.title)) ? 'Remove' : 'Save'} ${book.title} ${savedBookSlugs.has(bookSlug(book.title)) ? 'from' : 'to'} this browser’s shelf`);
    save.addEventListener('click', () => togglePreviewBook(book, !savedBookSlugs.has(bookSlug(book.title))));
    const actions = make('div', 'book-actions');
    actions.append(link, save);
    card.append(actions);
    fragment.append(card);
  }
  grid.append(fragment);
};

const renderMatch = () => {
  const value = $('#concern-select').value;
  const result = $('#match-result');
  result.replaceChildren();
  if (value === '') {
    result.append(make('span', 'result-placeholder', 'A place to start will appear here.'));
    return;
  }

  const match = catalogue.matches[Number(value)];
  const booksByNumber = new Map(catalogue.books.map((book) => [Number(book.journey_number), book]));
  const primary = booksByNumber.get(Number(match.primary_journey_number));
  if (!primary) {
    result.append(make('p', '', 'This recommendation is being reviewed in the existing editorial guide.'));
    return;
  }

  result.append(make('span', 'result-label', 'A PLACE TO BEGIN'));
  result.append(make('h3', '', primary.title));
  result.append(make('p', '', primary.core_question));
  if (match.primary_anchor) result.append(make('p', '', `Chapter reference: ${match.primary_anchor}`));
  if (match.editorial_status === 'CHAPTER_ANCHOR_LOCATED_NOT_SEMANTICALLY_APPROVED') {
    result.append(make('p', 'match-review-note', 'The chapter reference is located; editorial suitability is still under review.'));
  }
  const link = make('a', '', `Discover ${primary.title} on Greyveil ↗`);
  link.href = detailUrl(primary);
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  result.append(link);
};

const topicSearch = (topic) => {
  const label = String(topic.topic || '').split('/')[0].trim();
  $('#book-search').value = label;
  $('#series-filter').value = '';
  renderBooks();
  const featured = $('#explore-feature');
  featured.replaceChildren(
    make('span', 'explore-feature-index', 'AN EDITORIAL READING THREAD'),
    make('h3', '', topic.topic),
    make('p', '', `Start with ${topic.primary_recommendation || 'the existing collection'}. ${topic.other_books ? `Then continue with ${topic.other_books}.` : ''}`.trim()),
  );
  const link = make('a', 'underlined-link', 'See matching books in the library ↓');
  link.href = '#library';
  featured.append(link);
  $('#library').scrollIntoView({ behavior: 'smooth', block: 'start' });
};

const initTopics = () => {
  const topics = catalogue.topics || [];
  const container = $('#topic-buttons');
  container.replaceChildren();
  topics.forEach((topic, index) => {
    const button = make('button', 'topic-chip', topic.topic);
    button.type = 'button';
    button.setAttribute('aria-pressed', 'false');
    button.addEventListener('click', () => {
      container.querySelectorAll('.topic-chip').forEach((chip) => chip.setAttribute('aria-pressed', 'false'));
      button.setAttribute('aria-pressed', 'true');
      topicSearch(topic);
    });
    container.append(button);
  });
};

const editorialNotes = [
  {
    slug: 'identity-stories',
    kicker: 'IDENTITY & THE STORIES WE TELL',
    title: 'A thought can be<br><em>loud without being true.</em>',
    body: 'We narrate ourselves through unfinished sentences: what someone meant, what we should have said, what a silence might contain. Noticing the narrator does not mean silencing it. It means making room for the story and for the person who is listening.',
    book: 'The Paradox of Awareness',
  },
  {
    slug: 'memory-and-return',
    kicker: 'MEMORY & THE SHAPE OF WHAT REMAINS',
    title: 'Remembering is not<br><em>the same as returning.</em>',
    body: 'A memory may keep its details while the person holding it changes. Returning to an old moment can reveal not only what happened, but what we needed then—and what we understand now.',
    book: 'The Loop Within',
  },
  {
    slug: 'understanding-begins',
    kicker: 'RELATIONSHIPS & DIFFERENT POINTS OF VIEW',
    title: 'Understanding begins<br><em>where certainty softens.</em>',
    body: 'Two people can care about the same thing and still meet it from different histories. Listening does not require surrendering your own view; it leaves room to see what the other person sees.',
    book: 'When Understanding Begins',
  },
];

const selectEditorialNote = (index) => {
  const note = editorialNotes[index];
  if (!note) return;
  document.querySelectorAll('[data-note]').forEach((button) => {
    button.setAttribute('aria-selected', String(Number(button.dataset.note) === index));
  });
  $('#mind-note').setAttribute('aria-labelledby', `note-tab-${index}`);
  $('#note-number').innerHTML = `${String(index + 1).padStart(2, '0')}<span> / A GREYVEIL NOTE</span>`;
  $('#note-kicker').textContent = note.kicker;
  $('#note-title').innerHTML = note.title;
  $('#note-body').textContent = note.body;
  const book = catalogue.books.find((item) => item.title === note.book);
  const link = $('#note-book-link');
  link.textContent = `Explore ${note.book} `;
  const arrow = make('span', '', '↗');
  arrow.setAttribute('aria-hidden', 'true');
  link.append(arrow);
  link.href = book ? detailUrl(book) : '#library';
  link.target = book ? '_blank' : '';
  link.rel = book ? 'noopener noreferrer' : '';
};

const init = async () => {
  const response = await fetch('./catalogue.json', { cache: 'no-store' });
  if (!response.ok) throw new Error(`Catalogue request failed: ${response.status}`);
  catalogue = await response.json();
  populateRecommendationOptions();
  if (!Array.isArray(catalogue.books) || !Array.isArray(catalogue.matches)) {
    throw new Error('The catalogue has an unexpected shape.');
  }

  savedBookSlugs = readPreviewShelf();
  initTopics();
  const seriesNames = [...new Set(catalogue.books.map((book) => book.series))];
  for (const series of seriesNames) {
    const option = make('option', '', series);
    option.value = series;
    $('#series-filter').append(option);
  }

  catalogue.matches.forEach((match, index) => {
    const option = make('option', '', match.reader_concern);
    option.value = String(index);
    $('#concern-select').append(option);
  });

  $('#book-search').addEventListener('input', renderBooks);
  $('#series-filter').addEventListener('change', renderBooks);
  $('#concern-select').addEventListener('change', renderMatch);
  document.querySelectorAll('[data-note]').forEach((button) => {
    button.addEventListener('click', () => selectEditorialNote(Number(button.dataset.note)));
    button.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
      event.preventDefault();
      const direction = event.key === 'ArrowRight' ? 1 : -1;
      const next = (Number(button.dataset.note) + direction + editorialNotes.length) % editorialNotes.length;
      const nextButton = $(`#note-tab-${next}`);
      selectEditorialNote(next);
      nextButton.focus();
    });
  });
  document.querySelectorAll('[data-mind-topic]').forEach((link) => {
    link.addEventListener('click', () => {
      $('#book-search').value = link.dataset.mindTopic;
      $('#series-filter').value = '';
      renderBooks();
    });
  });
  document.querySelectorAll('[data-collection]').forEach((button) => {
    button.addEventListener('click', () => {
      const terms = button.dataset.collection.split(' ');
      $('#book-search').value = terms[0];
      $('#series-filter').value = '';
      renderBooks();
      $('#library').scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });
  renderBooks();
  updatePreviewShelf();
};

const siteHeader = $('.site-header');
const updateSiteHeader = () => siteHeader.classList.toggle('is-scrolled', window.scrollY > 24);
updateSiteHeader();
window.addEventListener('scroll', updateSiteHeader, { passive: true });

$('.menu-toggle').addEventListener('click', (event) => {
  const button = event.currentTarget;
  const nav = $('#primary-nav');
  const open = button.getAttribute('aria-expanded') !== 'true';
  button.setAttribute('aria-expanded', String(open));
  button.textContent = open ? 'Close' : 'Menu';
  nav.classList.toggle('is-open', open);
});

$('#primary-nav').addEventListener('click', (event) => {
  if (event.target.closest('a')) {
    $('.menu-toggle').setAttribute('aria-expanded', 'false');
    $('.menu-toggle').textContent = 'Menu';
    $('#primary-nav').classList.remove('is-open');
  }
});

$('#next-prompt').addEventListener('click', () => {
  const prompts = [
    'What are you ready to see differently?',
    'What would you say if you did not need to make it sound resolved?',
    'What part of this feels like yours to carry—and what might not be?',
    'When did you last feel most like yourself?',
    'What would listening, rather than fixing, look like here?',
  ];
  const current = $('#studio-prompt').textContent;
  const alternatives = prompts.filter((prompt) => prompt !== current);
  $('#studio-prompt').textContent = alternatives[Math.floor(Math.random() * alternatives.length)];
});

document.querySelectorAll('[data-timeline-prompt]').forEach((button) => {
  button.addEventListener('click', () => {
    const prompt = button.dataset.timelinePrompt;
    document.querySelectorAll('[data-timeline-prompt]').forEach((step) => {
      step.setAttribute('aria-pressed', String(step === button));
    });
    $('#timeline-prompt').textContent = prompt;
    $('#studio-prompt').textContent = prompt;
  });
});

$('#story-submission').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('#story-receipt-space').hidden = true;
  if (!supabaseClient || !storyServiceReady) {
    statusMessage('#story-status', 'Greyveil story submissions are not available here. Nothing was saved or sent.');
    return;
  }
  if (!currentReader) {
    statusMessage('#story-status', 'Sign in through Greyveil to send this story. Your form has not been saved or sent.');
    window.open(signInUrl(), '_blank', 'noopener');
    return;
  }
  if (!$('#story-private-consent').checked) {
    statusMessage('#story-status', 'Please confirm that Greyveil may receive this story privately for review.');
    return;
  }
  const submit = $('#story-submit');
  submit.disabled = true;
  statusMessage('#story-status', 'Sending your story privately for review…');
  let submissionId;
  let error;
  try {
    ({ data: submissionId, error } = await supabaseClient.rpc('greyveil_submit_story', {
      p_title: $('#story-title').value.trim(),
      p_story: $('#story-text').value.trim(),
      p_author_display_name: $('#story-byline').value.trim() || null,
      p_is_anonymous: $('#story-anonymous').checked,
      p_response_request: $('#response-request').value,
      p_public_consent: $('#story-public-consent').checked,
    }));
  } catch (requestError) {
    console.error('The Greyveil story submission request failed.', requestError);
    submit.disabled = false;
    statusMessage('#story-status', 'The story was not sent. The Greyveil submission service may need setup; your text remains in the form. Please try again later.');
    return;
  }
  submit.disabled = false;
  if (error || !submissionId) {
    console.error('The Greyveil story submission could not be sent.', error || new Error('The submission service returned no record identifier.'));
    statusMessage('#story-status', 'The story was not sent. The Greyveil submission service may need setup; your text remains in the form. Please try again later.');
    return;
  }
  event.currentTarget.reset();
  statusMessage('#story-status', 'Your story was saved privately. No response time or outcome is guaranteed. You can review its status, any personal editor response, change public-sharing permission or delete it in My Space.');
  $('#story-receipt-space').hidden = false;
  await loadMyStories();
});

initializeLocalWriting();
initializeSiteAssets();
initializeGreyveilServices();

init().catch((error) => {
  console.error('Greyveil 2.0 preview could not load its existing catalogue.', error);
  $('#results-count').textContent = 'The catalogue did not load. Check that the preview server is running, then refresh.';
  $('#book-grid').replaceChildren(make('p', 'empty-state', 'Catalogue unavailable. Try refreshing the preview.'));
  $('#match-result').replaceChildren(make('p', '', 'Reader Match needs the existing catalogue to load.'));
});
