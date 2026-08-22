import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const text = (path) => readFile(new URL(path, import.meta.url), 'utf8')
const queueDefinition = (source) => source.match(
  /create or replace function public\.greyveil_admin_queue_generation_job\([\s\S]*?\)\s*returns public\.book_generation_jobs language plpgsql security definer set search_path = public as \$\$/i,
)?.[0].replace(/\s+/g, ' ').trim().toLowerCase()

test('targeted queue repair replaces the exact existing signature without changing its ACL', async () => {
  const [workflow, repair] = await Promise.all([
    text('../supabase/founder-publishing-workflow.sql'),
    text('../supabase/repair-generation-job-queue-transition.sql'),
  ])
  assert.equal(queueDefinition(repair), queueDefinition(workflow))
  assert.match(repair, /if not public\.greyveil_is_admin\(\)/i)
  assert.doesNotMatch(repair, /drop function|revoke |grant /i)
})

test('targeted queue repair permits only legitimate queue and retry source states', async () => {
  const sql = await text('../supabase/repair-generation-job-queue-transition.sql')
  const guard = sql.match(/job\.status not in \(([^)]+)\)/i)
  assert.ok(guard, 'queue RPC must contain an explicit source-state guard')
  const allowed = new Set([...guard[1].matchAll(/'([A-Z_]+)'/g)].map((match) => match[1]))
  assert.deepEqual([...allowed], ['DRAFT', 'AWAITING_REVIEW', 'FAILED', 'CANCELLED'])
  for (const rejected of [
    'QUEUED',
    'DETECTING',
    'IMPORTING',
    'NORMALIZING',
    'VALIDATING_SOURCE',
    'GENERATING_PDF',
    'GENERATING_EPUB',
    'GENERATING_DOCX',
    'VALIDATING_OUTPUTS',
    'READY_TO_PUBLISH',
    'PUBLISH_REQUESTED',
    'PUBLISHED',
  ]) {
    assert.equal(allowed.has(rejected), false, `${rejected} must not be queueable`)
  }
  assert.match(sql, /for update/i)
  assert.match(sql, /job\.worker_token is not null/i)
  assert.match(sql, /using errcode = '23514'/i)
})

test('queue repair binds inputs and canonicalizes the authoritative slug', async () => {
  const sql = await text('../supabase/repair-generation-job-queue-transition.sql')
  assert.match(sql, /format\('jobs\/%s\/manuscript\.docx', target_job_id::text\)/)
  assert.match(sql, /'\^jobs\/' \|\| target_job_id::text \|\| '\/cover\[\.\]/)
  assert.match(sql, /if job\.book_id is not null then[\s\S]*from public\.books[\s\S]*where books\.id = job\.book_id/)
  assert.match(sql, /jsonb_set\(coalesce\(target_metadata/)
  assert.match(sql, /security definer set search_path = public/i)
})

test('generation retry cannot mutate canonical published metadata or artifact buckets', async () => {
  const worker = await text('../tools/book-generator/run_generation_worker.py')
  const runBody = worker.slice(worker.indexOf('def run(job: dict)'), worker.indexOf('def candidate_entry'))
  const promotionBody = worker.slice(worker.indexOf('def promote(job: dict)'), worker.indexOf('def claim_one'))
  assert.match(runBody, /upload_candidate\(job, kind, file, mime\)/)
  assert.match(worker, /storage_upload\("generation-candidates", path, file, mime, upsert=True\)/)
  assert.match(runBody, /READY_TO_PUBLISH/)
  assert.doesNotMatch(runBody, /book-files|book-covers|greyveil_worker_finalize_generation_publication/)
  assert.match(promotionBody, /book-covers/)
  assert.match(promotionBody, /book-files/)
  assert.match(promotionBody, /greyveil_worker_finalize_generation_publication/)
})

test('candidate retry is same-job upsert while the publish transition remains unchanged', async () => {
  const worker = await text('../tools/book-generator/run_generation_worker.py')
  assert.match(worker, /return f"jobs\/\{canonical_id\}\/\{kind\}\/\{filename\}"/)
  assert.match(worker, /storage_upload\("generation-candidates", path, file, mime, upsert=True\)/)
  assert.match(worker, /if job\["status"\] == "PUBLISH_REQUESTED":[\s\S]*promote\(job\)/)
})
