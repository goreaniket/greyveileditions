import { isLocalDevelopmentLocation } from './site-config.js'

const errorText = (error) => `${error?.code || ''} ${error?.message || ''}`.toLowerCase()

export const friendlyAuthMessage = (error, fallback = 'The account service could not complete the request.') => {
  const message = errorText(error)
  const status = Number(error?.status || 0)

  if (message.includes('invalid login credentials')) {
    return 'The email or password is not correct.'
  }

  if (message.includes('email not confirmed')) {
    return 'Please confirm your email before signing in.'
  }

  if (message.includes('already registered') || message.includes('already exists') || message.includes('user_already_exists')) {
    return 'An account already exists for this email. Try signing in instead.'
  }

  if (message.includes('invalid email') || message.includes('email_address_invalid')) {
    return 'Enter a valid email address and try again.'
  }

  if (message.includes('signup disabled') || message.includes('signup_disabled')) {
    return 'New account registration is temporarily unavailable.'
  }

  if (status === 429 || message.includes('rate limit') || message.includes('over_email_send_rate_limit')) {
    return 'Too many email requests were made. Please wait a few minutes and try again.'
  }

  if (message.includes('weak password') || message.includes('weak_password') || message.includes('password should')) {
    return 'Please use a stronger password and try again.'
  }

  if (message.includes('smtp') || message.includes('email provider') || message.includes('sending confirmation email')) {
    return 'We could not send the confirmation email. Please try again shortly.'
  }

  if (message.includes('database') || message.includes('db error') || message.includes('saving new user') || message.includes('trigger')) {
    return 'We could not finish setting up your account. Please try again or contact support.'
  }

  if (message.includes('network') || message.includes('fetch') || message.includes('offline')) {
    return 'We could not reach the account service. Please try again.'
  }

  if (message.includes('password')) {
    return 'Please use a valid password and try again.'
  }

  if (status >= 500 || message.includes('unexpected_failure')) {
    return 'The account service is temporarily unavailable. Please try again shortly.'
  }

  return fallback
}

export const logAuthDiagnostic = (
  operation,
  error,
  location = window.location,
  logger = console.error,
) => {
  if (!error || !isLocalDevelopmentLocation(location)) return

  logger('Greyveil authentication request failed.', {
    operation,
    message: String(error?.message || 'Unknown authentication error'),
    status: error?.status ?? null,
    code: error?.code ?? null,
  })
}
