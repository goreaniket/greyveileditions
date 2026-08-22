import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const text = (path) => readFile(new URL(path, import.meta.url), 'utf8')
const activeStates = new Set([
  'IMPORTING', 'NORMALIZING', 'VALIDATING_SOURCE', 'GENERATING_PDF',
  'GENERATING_EPUB', 'GENERATING_DOCX', 'VALIDATING_OUTPUTS', 'PUBLISH_REQUESTED',
])
const leaseMilliseconds = 30 * 60 * 1000

const heartbeat = (job, token, now) => {
  if (job.workerToken !== token || !activeStates.has(job.status)) return false
  job.heartbeatAt = now
  return true
}

const claim = (job, token, now) => {
  const unclaimed = job.workerToken === null && ['QUEUED', 'PUBLISH_REQUESTED'].includes(job.status)
  const stale = activeStates.has(job.status) && job.heartbeatAt < now - leaseMilliseconds
  if (!unclaimed && !stale) return false
  job.workerToken = token
  job.claimedAt = now
  job.heartbeatAt = now
  return true
}

test('heartbeat RPC is service-role-only, token-fenced, and active-state-scoped', async () => {
  const sql = await text('../supabase/repair-generation-worker-heartbeat.sql')
  const fn = sql.match(/create or replace function public\.greyveil_worker_heartbeat_generation_job\([\s\S]*?\$\$;/i)?.[0]
  assert.ok(fn)
  assert.match(fn, /returns boolean language plpgsql security definer set search_path = public/i)
  assert.match(fn, /auth\.role\(\) <> 'service_role'/i)
  assert.match(fn, /id = target_job_id/i)
  assert.match(fn, /worker_token = claim_token/i)
  assert.match(fn, /set heartbeat_at = now\(\)/i)
  for (const state of activeStates) assert.match(fn, new RegExp(`'${state}'`))
  for (const state of ['DRAFT', 'QUEUED', 'AWAITING_REVIEW', 'READY_TO_PUBLISH', 'PUBLISHED', 'FAILED', 'CANCELLED']) {
    assert.doesNotMatch(fn, new RegExp(`'${state}'`))
  }
  assert.match(sql, /revoke all on function public\.greyveil_worker_heartbeat_generation_job\(uuid, uuid\) from public/i)
  assert.match(sql, /revoke all on function public\.greyveil_worker_heartbeat_generation_job\(uuid, uuid\) from anon/i)
  assert.match(sql, /revoke all on function public\.greyveil_worker_heartbeat_generation_job\(uuid, uuid\) from authenticated/i)
  assert.match(sql, /grant execute on function public\.greyveil_worker_heartbeat_generation_job\(uuid, uuid\) to service_role/i)
})

test('healthy heartbeat prevents false reclaim while a dead worker remains reclaimable', () => {
  const job = {
    status: 'GENERATING_PDF',
    workerToken: 'worker-a',
    claimedAt: 0,
    heartbeatAt: 0,
  }
  assert.equal(heartbeat(job, 'worker-a', 15 * 60 * 1000), true)
  assert.equal(heartbeat(job, 'wrong-token', 20 * 60 * 1000), false)
  assert.equal(claim(job, 'worker-b', 31 * 60 * 1000), false)
  assert.equal(heartbeat(job, 'worker-a', 35 * 60 * 1000), true)
  assert.equal(claim(job, 'worker-b', 60 * 60 * 1000), false)

  assert.equal(claim(job, 'worker-b', 66 * 60 * 1000), true)
  assert.equal(job.workerToken, 'worker-b')
})

test('inactive jobs reject heartbeat and the authoritative 30-minute reclaim rule is unchanged', async () => {
  const [workflow, repair] = await Promise.all([
    text('../supabase/founder-publishing-workflow.sql'),
    text('../supabase/repair-generation-worker-heartbeat.sql'),
  ])
  for (const status of ['READY_TO_PUBLISH', 'FAILED', 'CANCELLED', 'AWAITING_REVIEW']) {
    const job = { status, workerToken: 'worker-a', heartbeatAt: 0 }
    assert.equal(heartbeat(job, 'worker-a', 1), false)
  }
  assert.match(workflow, /heartbeat_at < now\(\) - interval '30 minutes'/i)
  assert.match(workflow, /for update skip locked limit 1/i)
  assert.match(workflow, /book_generation_jobs_claim_idx[\s\S]*\(status, heartbeat_at, created_at\)/i)
  assert.doesNotMatch(repair, /create\s+(?:unique\s+)?index|alter table|create trigger/i)
})

test('heartbeat cannot reopen or overwrite READY and PUBLISHED final transitions', () => {
  for (const finalStatus of ['READY_TO_PUBLISH', 'PUBLISHED']) {
    const job = {
      status: finalStatus === 'PUBLISHED' ? 'PUBLISH_REQUESTED' : 'VALIDATING_OUTPUTS',
      workerToken: 'worker-a',
      heartbeatAt: 0,
    }
    assert.equal(heartbeat(job, 'worker-a', 100), true)
    job.status = finalStatus
    job.workerToken = null
    const finalHeartbeat = job.heartbeatAt
    assert.equal(heartbeat(job, 'worker-a', 101), false)
    assert.equal(job.status, finalStatus)
    assert.equal(job.workerToken, null)
    assert.equal(job.heartbeatAt, finalHeartbeat)
  }
})

test('worker heartbeat wraps long stages and preserves claim-token fencing', async () => {
  const worker = await text('../tools/book-generator/run_generation_worker.py')
  assert.match(worker, /HEARTBEAT_INTERVAL_SECONDS = 5 \* 60/)
  assert.match(worker, /HEARTBEAT_MAX_SILENCE_SECONDS = 20 \* 60/)
  assert.match(worker, /HEARTBEAT_REQUEST_TIMEOUT_SECONDS = 10/)
  assert.match(worker, /threading\.Thread\([\s\S]*daemon=True/)
  assert.match(worker, /except BaseException:[\s\S]*Generation claim heartbeat stopped unexpectedly/)
  assert.match(worker, /greyveil_worker_heartbeat_generation_job/)
  assert.match(worker, /timeout_seconds=HEARTBEAT_REQUEST_TIMEOUT_SECONDS/)
  assert.match(worker, /for stage, flag in \(\("GENERATING_PDF"[\s\S]*require_live_claim\(job\)/)
  assert.match(worker, /for kind, file in \{\*\*files[\s\S]*require_live_claim\(job\)/)
  assert.match(worker, /worker_token.*job\['_claim_token'\]/)
  assert.match(worker, /finally:[\s\S]*heartbeat\.stop\(\)[\s\S]*job\.pop\("_heartbeat", None\)/)
})
