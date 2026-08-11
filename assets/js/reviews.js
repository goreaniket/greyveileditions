import { supabase } from './supabase-client.js'
import { canReadBook, getEntitlementSnapshot, hierarchyForBook } from './content-access.js'

const getText = (value, fallback = '') => String(value ?? '').trim() || fallback
const create = (tag, className = '', text = '') => {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text) node.textContent = text
  return node
}
const formatDate = (value) => {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '' : new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium' }).format(date)
}

export const bookSlugFromPath = (path) => {
  const match = String(path || '').match(/\/books\/([^/]+?)(?:\.html|\/index\.html|\/)?$/i)
  return match ? decodeURIComponent(match[1]) : ''
}

const currentBookSlug = () => bookSlugFromPath(window.location.pathname)

const reviewCard = (review) => {
  const card = create('article', 'reader-review')
  const heading = create('div', 'reader-review__heading')
  heading.append(
    create('strong', '', 'Verified Reader'),
    create('span', 'reader-review__rating', `${review.rating} / 5`)
  )
  card.append(
    heading,
    create('p', '', review.review_text),
    create('time', '', formatDate(review.updated_at || review.created_at))
  )
  return card
}

const setReviewStatus = (node, message = '', type = '') => {
  node.textContent = message
  node.dataset.status = type
}

export const initBookReviews = async () => {
  const slug = currentBookSlug()
  const main = document.querySelector('main')
  if (!slug || !main || document.querySelector('[data-book-reviews]')) return

  try {
    const snapshot = await getEntitlementSnapshot()
    const book = snapshot.hierarchy.books.find((item) => item.slug === slug)
    if (!book) return
    const bookHierarchy = hierarchyForBook(
      book,
      snapshot.hierarchy.seriesItems,
      snapshot.hierarchy.collections,
      snapshot.hierarchy.volumes
    )
    const { data: reviews, error } = await supabase
      .from('book_reviews')
      .select('id, user_id, book_id, rating, review_text, moderation_status, created_at, updated_at')
      .eq('book_id', book.id)
      .eq('moderation_status', 'approved')
      .order('created_at', { ascending: false })
    if (error) return

    const section = create('section', 'section page-shell book-reviews')
    section.dataset.bookReviews = ''
    const heading = create('div', 'section-heading book-reviews__heading')
    const titleBlock = create('div')
    titleBlock.append(create('p', 'eyebrow', 'Reader Reviews'), create('h2', '', 'What Readers Say'))
    const summary = create('div', 'book-reviews__summary')
    const approved = reviews || []
    const average = approved.length
      ? approved.reduce((total, review) => total + Number(review.rating), 0) / approved.length
      : 0
    summary.append(
      create('strong', '', approved.length ? average.toFixed(1) : '-'),
      create('span', '', `${approved.length} ${approved.length === 1 ? 'review' : 'reviews'}`)
    )
    heading.append(titleBlock, summary)
    section.append(heading)

    const eligible = snapshot.context.user?.id && canReadBook({
      ...bookHierarchy,
      grants: snapshot.grants,
      paidOrders: snapshot.paidOrders,
    }, snapshot.context)

    if (eligible) {
      const { data: ownReview } = await supabase
        .from('book_reviews')
        .select('id, rating, review_text, moderation_status')
        .eq('user_id', snapshot.context.user.id)
        .eq('book_id', book.id)
        .maybeSingle()
      const form = create('form', 'book-review-form')
      form.innerHTML = `
        <div class="book-review-form__heading">
          <h3>${ownReview ? 'Edit Your Review' : 'Review This Book'}</h3>
          <span>${ownReview ? `Status: ${ownReview.moderation_status}` : 'Reviews are moderated before publication.'}</span>
        </div>
        <label><span>Rating</span><select name="rating" required>${[5, 4, 3, 2, 1].map((rating) => `<option value="${rating}">${rating} / 5</option>`).join('')}</select></label>
        <label><span>Review</span><textarea name="review_text" rows="5" minlength="10" maxlength="4000" required></textarea></label>
        <div class="book-review-form__actions"><button class="button primary" type="submit">${ownReview ? 'Update Review' : 'Submit Review'}</button><p class="form-status" role="status" aria-live="polite"></p></div>
      `
      form.elements.rating.value = String(ownReview?.rating || 5)
      form.elements.review_text.value = ownReview?.review_text || ''
      form.addEventListener('submit', async (event) => {
        event.preventDefault()
        const button = form.querySelector('button[type="submit"]')
        const status = form.querySelector('[role="status"]')
        button.disabled = true
        setReviewStatus(status, 'Saving your review...', 'info')
        const payload = {
          user_id: snapshot.context.user.id,
          book_id: book.id,
          rating: Number(form.elements.rating.value),
          review_text: getText(form.elements.review_text.value),
          moderation_status: 'pending',
        }
        const result = ownReview?.id
          ? await supabase.from('book_reviews').update(payload).eq('id', ownReview.id)
          : await supabase.from('book_reviews').insert(payload)
        if (result.error) setReviewStatus(status, 'Your review could not be saved. Check your access and try again.', 'error')
        else {
          setReviewStatus(status, 'Review saved and sent for moderation.', 'success')
          button.disabled = true
        }
        if (result.error) button.disabled = false
      })
      section.append(form)
    }

    const list = create('div', 'reader-review-grid')
    approved.forEach((review) => list.append(reviewCard(review)))
    if (!approved.length) list.append(create('p', 'book-reviews__empty', 'No approved reader reviews yet.'))
    section.append(list)
    main.append(section)
  } catch (error) {
    console.info('Book reviews are not available.', { message: error?.message, code: error?.code })
  }
}
