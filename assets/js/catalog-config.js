const cleanSlug = (value) => String(value || '').trim().toLowerCase()

export const seriesDetailPath = (series) => {
  const slug = cleanSlug(series?.slug)
  return slug ? `/projects/${slug}/` : ''
}

export const bookDetailPath = (book, series) => {
  const bookSlug = cleanSlug(book?.slug)
  const seriesSlug = cleanSlug(series?.slug)
  if (!bookSlug || !seriesSlug) return ''
  const volumeTwoSeries = new Set(['inner-experience', 'lived-experience', 'expanded-experience'])
  return volumeTwoSeries.has(seriesSlug)
    ? `/projects/human-experience/books/${bookSlug}/`
    : `/projects/${seriesSlug}/books/${bookSlug}.html`
}

export const bookReaderPath = (book, series) => {
  const bookSlug = cleanSlug(book?.slug)
  const seriesSlug = cleanSlug(series?.slug)
  return bookSlug && seriesSlug ? `/projects/${seriesSlug}/books/${bookSlug}/reader/` : ''
}

export const bookCoverPath = (book) => {
  const slug = cleanSlug(book?.slug)
  return slug ? `/assets/books/${slug}/cover/front-cover.webp` : ''
}

export const SERIES_ARTWORK_PATHS = Object.freeze({
  'human-mind': '/assets/images/the human mind.jpeg',
  'human-fiction': '/assets/images/the human fiction.jpeg',
  'human-paradox': '/assets/images/the human paradox.jpeg',
})

export const seriesCoverPath = (series) => {
  const slug = cleanSlug(series?.slug)
  return SERIES_ARTWORK_PATHS[slug]
    || (slug ? `/assets/images/${slug.replaceAll('-', ' ')}.jpeg` : '')
}

export const COVER_FALLBACK_PATH = '/assets/images/greyveil-logo.png'

export const bindCoverFallback = (image) => {
  if (!image) return
  image.addEventListener('error', () => {
    if (image.dataset.coverFallbackApplied) return
    image.dataset.coverFallbackApplied = 'true'
    image.classList.add('catalog-cover-fallback')
    image.src = COVER_FALLBACK_PATH
  }, { once: true })
}
