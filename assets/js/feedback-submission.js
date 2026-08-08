import { supabase } from './supabase-client.js'

const getFormValue = (formData, name) => (formData.get(name) || '').toString().trim()

const getCurrentUserId = async () => {
  const { data, error } = await supabase.auth.getUser()

  if (error && error.name !== 'AuthSessionMissingError') {
    console.info('Feedback auth check continued as guest.', {
      name: error.name,
      message: error.message,
      status: error.status,
    })
  }

  return data?.user?.id || null
}

export const buildFeedbackRow = async (form) => {
  const formData = new FormData(form)
  const ratingValue = getFormValue(formData, 'rating')
  const rating = Number(ratingValue)

  if (!ratingValue || !Number.isFinite(rating)) {
    throw new TypeError('Feedback rating must be a number.')
  }

  return {
    'Date & time': new Date().toISOString(),
    Name: getFormValue(formData, 'name'),
    Email: getFormValue(formData, 'email'),
    'Reviews ': getFormValue(formData, 'feedback'),
    Collection: getFormValue(formData, 'collection'),
    Series: getFormValue(formData, 'series'),
    Book: getFormValue(formData, 'book'),
    'Occupation ': getFormValue(formData, 'occupation'),
    Rate: rating,
    user_id: await getCurrentUserId(),
  }
}

export const submitFeedback = async (form) => {
  const row = await buildFeedbackRow(form)
  const { error } = await supabase.from('feedbacks').insert(row)

  if (error) {
    throw error
  }

  return row
}

export const clearFeedbackEntryFields = (form) => {
  const fieldNames = ['name', 'email', 'feedback', 'occupation', 'rating']

  fieldNames.forEach((name) => {
    if (form.elements[name]) form.elements[name].value = ''
  })
}
