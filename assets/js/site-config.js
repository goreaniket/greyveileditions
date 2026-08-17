export const PRODUCTION_ORIGIN = 'https://greyveileditions.site'

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]'])

export const isLocalDevelopmentLocation = (location = window.location) => {
  try {
    return LOCAL_HOSTNAMES.has(new URL(location.href || location.origin).hostname)
  } catch (_error) {
    return false
  }
}

export const appOrigin = (location = window.location) => {
  return isLocalDevelopmentLocation(location) ? location.origin : PRODUCTION_ORIGIN
}

export const appUrl = (path, location = window.location) => {
  return new URL(path, `${appOrigin(location)}/`).href
}

export const safeReturnPath = (value, fallback = '') => {
  const candidate = String(value || '').trim()
  return candidate.startsWith('/') && !candidate.startsWith('//') ? candidate : fallback
}
