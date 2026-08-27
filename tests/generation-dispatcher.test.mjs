import assert from 'node:assert/strict'
import { access, readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  GENERATION_REF,
  GENERATION_WORKFLOW,
  parseRepository,
  requireAdminRole,
  requireBearerToken,
  requireDispatchableJob,
  requireJobId,
} from '../supabase/functions/_shared/generation-dispatch.ts'

const source = (path) => readFile(new URL(path, import.meta.url), 'utf8')
const jobId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'

test('dispatcher validation denies anonymous, non-admin, malformed, random, and active jobs', () => {
  assert.throws(() => requireBearerToken(''), (error) => error.status === 401 && error.code === 'authentication_required')
  assert.throws(() => requireAdminRole('customer'), (error) => error.status === 403 && error.code === 'admin_required')
  assert.throws(() => requireJobId({ job_id: '../not-a-job' }), (error) => error.status === 400 && error.code === 'invalid_job_id')
  assert.throws(() => requireJobId({ job_id: jobId.toUpperCase() }), (error) => error.status === 400)
  assert.throws(() => requireDispatchableJob(null, jobId), (error) => error.status === 404 && error.code === 'job_not_found')
  assert.throws(
    () => requireDispatchableJob({ id: jobId, status: 'IMPORTING', worker_token: jobId }, jobId),
    (error) => error.status === 409 && error.code === 'job_not_dispatchable',
  )
})

test('valid database-backed Admin and Super Admin jobs support generation and publication', () => {
  assert.equal(requireBearerToken('Bearer valid-user-jwt'), 'valid-user-jwt')
  for (const role of ['admin', 'super_admin']) assert.doesNotThrow(() => requireAdminRole(role))
  for (const status of ['QUEUED', 'PUBLISH_REQUESTED']) {
    const job = { id: jobId, status, worker_token: null }
    assert.equal(requireDispatchableJob(job, requireJobId({ job_id: jobId })), job)
  }
})

test('Edge function targets the detected repository workflow, master ref, and exact job input', async () => {
  const [edge, config] = await Promise.all([
    source('../supabase/functions/dispatch-generation-worker/index.ts'),
    source('../supabase/config.toml'),
  ])

  assert.equal(GENERATION_WORKFLOW, 'greyveil-generation-worker.yml')
  assert.equal(GENERATION_REF, 'master')
  assert.deepEqual(parseRepository('goreaniket/greyveileditions'), { owner: 'goreaniket', repo: 'greyveileditions' })
  assert.match(edge, /api\.github\.com\/repos\/\$\{encodeURIComponent\(owner\)\}\/\$\{encodeURIComponent\(repo\)\}\/actions\/workflows\/\$\{GENERATION_WORKFLOW\}\/dispatches/)
  assert.match(edge, /body: JSON\.stringify\(\{ ref: GENERATION_REF, inputs: \{ job_id: jobId \} \}\)/)
  assert.match(edge, /!response\.ok/)
  assert.match(config, /\[functions\.dispatch-generation-worker\]\s*\nverify_jwt = true/)
})

test('GitHub credential stays server-side and failures never expose upstream details', async () => {
  const [edge, helper, frontend] = await Promise.all([
    source('../supabase/functions/dispatch-generation-worker/index.ts'),
    source('../supabase/functions/_shared/generation-dispatch.ts'),
    source('../assets/js/founder-publishing.js'),
  ])

  assert.match(edge, /requireEnv\('GITHUB_ACTIONS_TOKEN'\)/)
  assert.match(edge, /requireEnv\('GITHUB_REPOSITORY'\)/)
  assert.match(edge, /Authorization: `Bearer \$\{githubToken\}`/)
  assert.match(edge, /redirect: 'error'/)
  assert.doesNotMatch(`${edge}\n${helper}`, /console\.(?:log|error)|Authorization.*(?:echo|print)/i)
  assert.doesNotMatch(frontend, /GITHUB_ACTIONS_TOKEN|githubToken|api\.github\.com|Authorization: `Bearer/)
  assert.match(edge, /problem\.status >= 500[\s\S]+The generation worker could not be dispatched\. The existing job state was preserved\./)
  assert.match(frontend, /DISPATCH_FAILURE_MESSAGE = 'The job state was preserved, but automatic GitHub worker dispatch failed\./)
  const browserDispatcher = frontend.slice(frontend.indexOf('const dispatchGenerationWorker'), frontend.indexOf('const uploadInput'))
  assert.doesNotMatch(browserDispatcher, /error\.message|throw error/)
})

test('frontend dispatches only after authoritative queue, detection, retry, and publish transitions', async () => {
  const frontend = await source('../assets/js/founder-publishing.js')
  const queue = frontend.slice(frontend.indexOf('const queue = async'), frontend.indexOf('const jobAction = async'))
  const actions = frontend.slice(frontend.indexOf('const jobAction = async'), frontend.indexOf('const bindJobAction'))
  const detection = frontend.slice(frontend.indexOf("detect.addEventListener('click'"), frontend.indexOf("card.addEventListener('submit'"))

  assert.ok(queue.indexOf("greyveil_admin_queue_generation_job") < queue.indexOf('await dispatchGenerationWorker(jobId)'))
  assert.ok(actions.indexOf("greyveil_admin_publish_generation_job") < actions.indexOf('await dispatchGenerationWorker(job.id)'))
  assert.ok(actions.indexOf("greyveil_admin_queue_generation_job") < actions.lastIndexOf('await dispatchGenerationWorker(job.id)'))
  assert.ok(detection.indexOf('greyveil_admin_request_generation_detection') < detection.indexOf('await dispatchGenerationWorker(job.id)'))
  assert.ok(detection.indexOf('card.dataset.jobId = job.id') < detection.indexOf('await dispatchGenerationWorker(job.id)'))
  assert.match(frontend, /const job = card\.dataset\.jobId[\s\S]+card\.dataset\.jobId = job\.id/)
  assert.match(frontend, /activeDispatches\.has\(id\)/)
  assert.match(frontend, /button\.disabled = true[\s\S]+button\.disabled = false/)
  assert.match(frontend, /Retry Worker Dispatch/)
})

test('claim fencing remains intact and dispatcher adds no deployable book artifacts', async () => {
  const [workerSql, vercelIgnore, edge, workflow] = await Promise.all([
    source('../supabase/founder-publishing-workflow.sql'),
    source('../.vercelignore'),
    source('../supabase/functions/dispatch-generation-worker/index.ts'),
    source('../.github/workflows/greyveil-generation-worker.yml'),
  ])

  assert.match(workerSql, /for update skip locked limit 1/i)
  assert.match(workerSql, /worker_token is null and status in \('QUEUED', 'PUBLISH_REQUESTED'\)/)
  await assert.rejects(access(new URL('../railpack.json', import.meta.url)))
  assert.match(vercelIgnore, /^supabase\/$/m)
  assert.doesNotMatch(`${edge}\n${workflow}`, /actions\/upload-artifact|git (?:add|commit|push)|(?:public|assets)\/(?:.*\.(?:pdf|epub|docx|zip))/i)
})
