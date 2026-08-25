const EMAIL_LOCAL_PATTERN = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/i
const EMAIL_DOMAIN_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i

export const validFeedbackEmail = (value) => {
  if (typeof value !== 'string') return null

  const email = value.trim()
  if (!email || email.length > 254 || /[\u0000-\u0020\u007f]/.test(email)) return null

  const parts = email.split('@')
  if (parts.length !== 2) return null

  const [localPart, domain] = parts
  if (!localPart || localPart.length > 64 || !EMAIL_LOCAL_PATTERN.test(localPart)) return null
  if (localPart.startsWith('.') || localPart.endsWith('.') || localPart.includes('..')) return null
  if (!domain || domain.length > 253 || !EMAIL_DOMAIN_PATTERN.test(domain)) return null

  return email
}

export const feedbackEmailMailto = (value) => {
  const email = validFeedbackEmail(value)
  if (!email) return null

  const [localPart, domain] = email.split('@')
  return `mailto:${encodeURIComponent(localPart)}@${domain}`
}

export const createFeedbackEmailLink = (value, documentRef = document) => {
  const email = validFeedbackEmail(value)
  if (!email) return null

  const link = documentRef.createElement('a')
  link.className = 'feedback-detail-email'
  link.textContent = email
  link.setAttribute('href', feedbackEmailMailto(email))
  return link
}
