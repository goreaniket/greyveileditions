import { createClient } from 'npm:@supabase/supabase-js@2'

import { corsHeaders, handleCors } from '../_shared/cors.ts'
import {
  DispatchError,
  GENERATION_REF,
  GENERATION_WORKFLOW,
  parseRepository,
  requireAdminRole,
  requireBearerToken,
  requireDispatchableJob,
  requireJobId,
} from '../_shared/generation-dispatch.ts'

const json = (status, body, request) => new Response(JSON.stringify(body), {
  status,
  headers: { ...corsHeaders(request), 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
})

const errorResponse = (error, request) => {
  const problem = error instanceof DispatchError
    ? error
    : new DispatchError(500, 'The generation worker could not be dispatched.', 'dispatch_failed')
  const message = problem.status >= 500
    ? 'The generation worker could not be dispatched. The existing job state was preserved.'
    : problem.message
  return json(problem.status, { success: false, error: { code: problem.code, message } }, request)
}

const requireEnv = (name) => {
  const value = Deno.env.get(name)?.trim()
  if (!value) throw new DispatchError(500, 'Worker dispatch is not configured.', 'server_config_missing')
  return value
}

const serviceClient = () => createClient(
  requireEnv('SUPABASE_URL'),
  requireEnv('SUPABASE_SERVICE_ROLE_KEY'),
  { auth: { persistSession: false, autoRefreshToken: false } },
)

const parseBody = async (request) => {
  try {
    return await request.json()
  } catch (_error) {
    throw new DispatchError(400, 'Request body must be valid JSON.', 'invalid_json')
  }
}

export const handleRequest = async (request) => {
  const preflight = handleCors(request)
  if (preflight) return preflight
  if (request.method !== 'POST') {
    return json(405, { success: false, error: { code: 'method_not_allowed', message: 'Use POST.' } }, request)
  }

  try {
    const token = requireBearerToken(request.headers.get('authorization'))
    const admin = serviceClient()
    const { data: auth, error: authError } = await admin.auth.getUser(token)
    if (authError || !auth.user) {
      throw new DispatchError(401, 'Your session could not be verified.', 'authentication_required')
    }

    const body = await parseBody(request)
    const jobId = requireJobId(body)
    const { data: profile, error: profileError } = await admin
      .from('profiles')
      .select('role')
      .eq('id', auth.user.id)
      .maybeSingle()
    if (profileError) {
      throw new DispatchError(503, 'Admin access could not be checked.', 'authorization_unavailable')
    }
    requireAdminRole(profile?.role)

    const { data: job, error: jobError } = await admin
      .from('book_generation_jobs')
      .select('id,status,worker_token')
      .eq('id', jobId)
      .maybeSingle()
    if (jobError) {
      throw new DispatchError(503, 'Generation job state could not be checked.', 'job_state_unavailable')
    }
    requireDispatchableJob(job, jobId)

    const { owner, repo } = parseRepository(requireEnv('GITHUB_REPOSITORY'))
    const githubToken = requireEnv('GITHUB_ACTIONS_TOKEN')
    const response = await fetch(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/workflows/${GENERATION_WORKFLOW}/dispatches`,
      {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${githubToken}`,
          'Content-Type': 'application/json',
          'User-Agent': 'greyveil-generation-dispatcher',
          'X-GitHub-Api-Version': '2026-03-10',
        },
        body: JSON.stringify({ ref: GENERATION_REF, inputs: { job_id: jobId } }),
      },
    )
    if (response.status !== 204) {
      throw new DispatchError(502, 'GitHub did not accept the worker dispatch.', 'github_dispatch_failed')
    }

    return json(202, { success: true, job_id: jobId }, request)
  } catch (error) {
    return errorResponse(error, request)
  }
}

Deno.serve(handleRequest)
