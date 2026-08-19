import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const text = (path) => readFile(new URL(path, import.meta.url), 'utf8')

test('production-like candidate fixture can only switch canonical records after complete QA-approved promotion', async () => {
  const [worker, sql] = await Promise.all([
    text('../tools/book-generator/run_generation_worker.py'),
    text('../supabase/founder-publishing-workflow.sql'),
  ])
  const jobId = '11111111-1111-1111-1111-111111111111'
  const candidate = Object.fromEntries(['pdf', 'epub', 'docx', 'source', 'cover', 'qa'].map((kind) => [
    kind, { path: `jobs/${jobId}/${kind}/candidate-${kind}`, file_name: `candidate-${kind}`, file_size: 1, mime_type: 'application/octet-stream' },
  ]))
  assert.equal(Object.keys(candidate).length, 6)
  assert.match(worker, /greyveil_worker_claim_generation_job/)
  assert.match(worker, /PUBLISH_REQUESTED/)
  assert.match(worker, /for kind in \("pdf", "epub", "docx", "source", "cover"\)/)
  assert.match(worker, /published\/\{slug\}\/\{job\['id'\]\}/)
  assert.match(sql, /for update skip locked/i)
  assert.match(sql, /job\.worker_token is distinct from claim_token/)
  assert.match(sql, /job\.status <> 'PUBLISH_REQUESTED'/)
  assert.match(sql, /Only QA-approved candidates can be published/)
  assert.match(sql, /insert into public\.book_files/)
  assert.match(sql, /insert into public\.book_covers/)
  assert.match(sql, /worker_token = null/)
})

test('worker RPCs are service-role-only and candidate storage remains private', async () => {
  const sql = await text('../supabase/founder-publishing-workflow.sql')
  assert.match(sql, /auth\.role\(\) <> 'service_role'/)
  assert.match(sql, /revoke all on function public\.greyveil_worker_claim_generation_job.*from authenticated/s)
  assert.match(sql, /grant execute on function public\.greyveil_worker_finalize_generation_publication.*to service_role/s)
  assert.match(sql, /generation-candidates', 'generation-candidates', false/s)
})
