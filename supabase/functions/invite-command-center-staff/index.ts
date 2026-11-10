import { createClient } from 'npm:@supabase/supabase-js@2'
import { corsHeaders, handleCors, PRODUCTION_ORIGIN } from '../_shared/cors.ts'
import { HttpError, requireEnv, serviceClient } from '../_shared/payment.ts'

const json = (status: number, body: unknown, request: Request) => new Response(JSON.stringify(body), {
  status,
  headers: { ...corsHeaders(request), 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
})

const fail = (error: unknown, request: Request) => {
  if (error instanceof HttpError) {
    return json(error.status, { success: false, error: { code: error.code, message: error.message } }, request)
  }
  console.error('Greyveil staff invitation failed.', error)
  return json(500, {
    success: false,
    error: { code: 'invitation_failed', message: 'The staff invitation could not be completed.' },
  }, request)
}

Deno.serve(async (request) => {
  const cors = handleCors(request)
  if (cors) return cors
  if (request.method !== 'POST') {
    return json(405, { success: false, error: { code: 'method_not_allowed', message: 'Use POST.' } }, request)
  }

  try {
    const bearer = request.headers.get('authorization') || ''
    const token = bearer.match(/^Bearer\s+(.+)$/i)?.[1]?.trim()
    if (!token) throw new HttpError(401, 'Please sign in to continue.', 'authentication_required')
    if (Number(request.headers.get('content-length') || 0) > 4096) {
      throw new HttpError(413, 'The invitation request is too large.', 'request_too_large')
    }

    const rawBody = await request.text()
    if (new TextEncoder().encode(rawBody).length > 4096) {
      throw new HttpError(413, 'The invitation request is too large.', 'request_too_large')
    }
    let body: Record<string, unknown> | null = null
    try { body = JSON.parse(rawBody) } catch (_error) { body = null }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new HttpError(400, 'Send an email address and staff role.', 'invalid_request')
    }
    const email = String(body.email || '').trim().toLowerCase()
    const role = String(body.role || '').trim()
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new HttpError(400, 'Enter a valid staff email address.', 'invalid_email')
    }
    const allowedRoles = new Set(['super_admin', 'human_support', 'content_editor', 'finance_admin', 'moderator'])
    if (!allowedRoles.has(role)) throw new HttpError(400, 'Choose a valid staff role.', 'invalid_role')

    const admin = serviceClient()
    const { data: authData, error: authError } = await admin.auth.getUser(token)
    if (authError || !authData.user) throw new HttpError(401, 'Your session could not be verified.', 'authentication_required')

    const caller = createClient(requireEnv('SUPABASE_URL'), requireEnv('SUPABASE_ANON_KEY'), {
      global: { headers: { Authorization: `Bearer ${token}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    })
    const { error: permissionError } = await caller.rpc('greyveil_command_center_require', {
      p_permission: 'staff.manage',
      p_require_mfa: true,
    })
    if (permissionError) {
      throw new HttpError(403, 'Only an authorized, MFA-verified Owner can invite command-centre staff.', 'permission_denied')
    }

    const { data: inviteData, error: inviteError } = await admin.auth.admin.inviteUserByEmail(email, {
      redirectTo: `${PRODUCTION_ORIGIN}/auth/accept-invite/`,
    })
    if (inviteError || !inviteData.user) {
      console.error('Supabase Auth did not issue the requested staff invitation.', inviteError)
      throw new HttpError(409, 'Supabase Auth could not send this invitation. Check the email and existing account status.', 'invitation_not_sent')
    }

    const { error: assignmentError } = await admin.from('greyveil_staff_access').upsert({
      user_id: inviteData.user.id,
      staff_role: role,
      active: true,
      invited_by: authData.user.id,
      updated_at: new Date().toISOString(),
      revoked_at: null,
    }, { onConflict: 'user_id' })
    if (assignmentError) {
      console.error('Invitation was sent, but staff access could not be assigned.', assignmentError)
      throw new HttpError(500, 'The invitation email was sent, but staff access was not assigned. Assign the role after the recipient accepts.', 'invited_without_role')
    }

    const { error: auditError } = await admin.from('greyveil_command_audit').insert({
      actor_id: authData.user.id,
      action: 'staff.invitation.sent',
      target_type: 'user',
      target_id: inviteData.user.id,
      details: { role },
    })
    if (auditError) {
      console.error('Staff invitation was sent, but its audit record could not be saved.', auditError)
      throw new HttpError(500, 'The invitation and role were created, but the audit record failed. Review the system audit configuration.', 'audit_record_failed')
    }

    return json(200, { success: true, message: 'Secure staff invitation sent.', role }, request)
  } catch (error) {
    return fail(error, request)
  }
})
