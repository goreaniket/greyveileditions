export const SIGNUP_OUTCOMES = Object.freeze({
  FAILED: 'failed',
  EXISTING_ACCOUNT: 'existing-account',
  SIGNED_IN: 'signed-in',
  CONFIRMATION_REQUIRED: 'confirmation-required',
})

const unexpectedSignupError = () => Object.assign(
  new Error('Signup completed without returning an Auth user.'),
  { code: 'signup_result_invalid' },
)

export const signupOutcomeFor = ({ data = null, error = null } = {}) => {
  if (error) return { outcome: SIGNUP_OUTCOMES.FAILED, error }
  if (!data?.user) {
    return { outcome: SIGNUP_OUTCOMES.FAILED, error: unexpectedSignupError() }
  }
  if (Array.isArray(data.user.identities) && data.user.identities.length === 0) {
    return { outcome: SIGNUP_OUTCOMES.EXISTING_ACCOUNT, user: data.user }
  }
  if (data.session) {
    return { outcome: SIGNUP_OUTCOMES.SIGNED_IN, user: data.user, session: data.session }
  }
  return { outcome: SIGNUP_OUTCOMES.CONFIRMATION_REQUIRED, user: data.user }
}

export const normalizeDisplayName = (value) => String(value ?? '')
  .trim()
  .replace(/\s+/g, ' ')

export const isValidDisplayName = (value) => {
  const displayName = normalizeDisplayName(value)
  return displayName.length >= 2
    && displayName.length <= 80
    && !/[\u0000-\u001f\u007f]/.test(displayName)
}

const updateDenied = (error) => {
  const message = `${error?.code || ''} ${error?.message || ''}`.toLowerCase()
  return Number(error?.status || 0) === 401
    || Number(error?.status || 0) === 403
    || message.includes('42501')
    || message.includes('permission denied')
    || message.includes('row-level security')
    || message.includes('rls')
}

const failedUpdate = (reason, stage, error = null) => ({
  ok: false,
  reason,
  stage,
  error,
})

export const updateOwnDisplayName = async ({ supabase, user, displayName }) => {
  if (!user?.id) return failedUpdate('authentication-required', 'authentication')

  const normalizedName = normalizeDisplayName(displayName)
  if (!isValidDisplayName(normalizedName)) return failedUpdate('invalid-name', 'validation')

  let updateResult
  try {
    updateResult = await supabase
      .from('profiles')
      .update({ display_name: normalizedName })
      .eq('id', user.id)
      .select('id')
      .maybeSingle()
  } catch (error) {
    return failedUpdate(updateDenied(error) ? 'update-denied' : 'update-failed', 'profile-update', error)
  }

  if (updateResult?.error) {
    return failedUpdate(
      updateDenied(updateResult.error) ? 'update-denied' : 'update-failed',
      'profile-update',
      updateResult.error,
    )
  }
  if (!updateResult?.data?.id) return failedUpdate('profile-missing', 'profile-update')

  let profileResult
  try {
    profileResult = await supabase
      .from('profiles')
      .select('id, display_name, role')
      .eq('id', user.id)
      .maybeSingle()
  } catch (error) {
    return failedUpdate('refresh-failed', 'profile-refresh', error)
  }

  if (profileResult?.error) {
    return failedUpdate('refresh-failed', 'profile-refresh', profileResult.error)
  }
  if (!profileResult?.data?.id) return failedUpdate('refresh-failed', 'profile-refresh')

  let updatedUser = user
  let metadataError = null
  try {
    const metadataResult = await supabase.auth.updateUser({
      data: { display_name: profileResult.data.display_name },
    })
    metadataError = metadataResult?.error || null
    updatedUser = metadataResult?.data?.user || user
  } catch (error) {
    metadataError = error
  }

  return {
    ok: true,
    displayName: profileResult.data.display_name,
    profile: profileResult.data,
    user: updatedUser,
    metadataError,
  }
}
