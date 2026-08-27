import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const text = (path) => readFile(new URL(path, import.meta.url), 'utf8')

test('targeted SQL enforces one active generation job per existing Book', async () => {
  const sql = await text('../supabase/repair-generation-same-book-concurrency.sql')
  assert.match(sql, /create unique index if not exists book_generation_jobs_one_active_per_book_idx\s+on public\.book_generation_jobs \(book_id\)/i)
  assert.match(sql, /where book_id is not null\s+and status not in \('PUBLISHED', 'CANCELLED', 'FAILED'\)/i)
  assert.match(sql, /group by book_id\s+having count\(\*\) > 1/i)
  assert.match(sql, /from public\.books\s+where id = target_book_id\s+for key share/i)
  assert.match(sql, /when unique_violation then\s+raise exception 'A generation job is already active for this Book\.'/i)
  assert.match(sql, /public\.greyveil_is_admin\(\) is distinct from true/i)
  assert.match(sql, /revoke all on function public\.greyveil_admin_create_generation_job\(bigint\) from public, anon, authenticated/i)
  assert.match(sql, /grant execute on function public\.greyveil_admin_create_generation_job\(bigint\) to authenticated/i)
  assert.doesNotMatch(sql, /alter table public\.books|delete from|update public\.books/i)
})

test('new-Book jobs remain compatible while replacement jobs use the Book authority key', async () => {
  const sql = await text('../supabase/repair-generation-same-book-concurrency.sql')
  assert.match(sql, /values \(\s*auth\.uid\(\),\s*target_book_id,\s*case when target_book_id is null then 'create' else 'regenerate' end/i)
  assert.doesNotMatch(sql, /coalesce\(book_id|book_id is null\s+and status/i)
})

test('worker bounds DOCX expansion, files, artifacts, Storage memory, and processing time', async () => {
  const [limits, worker, importer, workflow] = await Promise.all([
    text('../tools/book-generator/greyveil/resource_limits.py'),
    text('../tools/book-generator/run_generation_worker.py'),
    text('../tools/book-generator/greyveil/importer.py'),
    text('../.github/workflows/greyveil-generation-worker.yml'),
  ])
  for (const symbol of [
    'MAX_MANUSCRIPT_BYTES', 'MAX_COVER_BYTES', 'MAX_COVER_PIXELS',
    'MAX_DOCX_ZIP_ENTRIES', 'MAX_DOCX_UNCOMPRESSED_BYTES',
    'MAX_DOCX_ENTRY_BYTES', 'MAX_DOCX_COMPRESSION_RATIO',
    'ARTIFACT_SIZE_LIMITS',
  ]) assert.match(limits, new RegExp(symbol))
  assert.match(importer, /validate_docx_archive\(manuscript_path\)[\s\S]+Document\(manuscript_path\)/)
  assert.match(worker, /while chunk := response\.read\(STORAGE_DOWNLOAD_CHUNK_BYTES\)/)
  assert.match(worker, /if total > max_bytes:/)
  assert.match(worker, /validate_generated_artifact\(kind, file\)/)
  assert.match(worker, /with bounded_job_processing\(\):/)
  assert.match(workflow, /^\s{4}timeout-minutes: 60\s*$/m)
})
