export const GENERATION_WORKFLOW = 'greyveil-generation-worker.yml'
export const GENERATION_REF = 'master'
export const DISPATCHABLE_STATUSES = new Set(['QUEUED', 'PUBLISH_REQUESTED'])
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export class DispatchError extends Error {
  constructor(status, message, code = 'dispatch_failed') {
    super(message)
    this.status = status
    this.code = code
  }
}

export const requireBearerToken = (authorization) => {
  const match = String(authorization || '').match(/^Bearer\s+(\S+)$/i)
  if (!match) throw new DispatchError(401, 'Please sign in to continue.', 'authentication_required')
  return match[1]
}

export const requireJobId = (body) => {
  const jobId = typeof body?.job_id === 'string' ? body.job_id.trim() : ''
  if (!UUID_PATTERN.test(jobId)) {
    throw new DispatchError(400, 'Choose a valid generation job.', 'invalid_job_id')
  }
  return jobId
}

export const requireAdminRole = (role) => {
  if (!['admin', 'super_admin'].includes(role)) {
    throw new DispatchError(403, 'Admin access is required.', 'admin_required')
  }
}

export const requireDispatchableJob = (job, jobId) => {
  if (!job || job.id !== jobId) {
    throw new DispatchError(404, 'Generation job was not found.', 'job_not_found')
  }
  if (!DISPATCHABLE_STATUSES.has(job.status) || job.worker_token !== null) {
    throw new DispatchError(409, 'This generation job is not waiting for a worker.', 'job_not_dispatchable')
  }
  return job
}

export const parseRepository = (value) => {
  const match = String(value || '').trim().match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/)
  if (!match) throw new DispatchError(500, 'Worker dispatch is not configured.', 'server_config_missing')
  return { owner: match[1], repo: match[2] }
}
