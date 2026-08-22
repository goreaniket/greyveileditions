import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const text = (path) => readFile(new URL(path, import.meta.url), 'utf8')

test('original DOCX fidelity audit blocks unsupported source before normalized source and exports', async () => {
  const importer = await text('../tools/book-generator/greyveil/importer.py')
  const worker = await text('../tools/book-generator/run_generation_worker.py')
  const sourceGuard = importer.indexOf('if parsed["source_errors"]:')
  const sourceWrite = importer.indexOf('write_imported_source(')
  const workerImportCheck = worker.indexOf('if result.status != "imported":')
  const workerExports = worker.indexOf('for stage, flag in (("GENERATING_PDF"')
  assert.ok(sourceGuard > 0 && sourceGuard < sourceWrite)
  assert.ok(workerImportCheck > 0 && workerImportCheck < workerExports)
  assert.match(importer, /document\.iter_inner_content\(\)/)
  assert.match(importer, /Word table that cannot yet be published safely/)
  assert.match(importer, /embedded image or drawing that cannot yet be published safely/)
})

test('WebP input contract is aligned while DOCX receives a deterministic PNG derivative', async () => {
  const [admin, worker, importer, sql] = await Promise.all([
    text('../assets/js/founder-publishing.js'),
    text('../tools/book-generator/run_generation_worker.py'),
    text('../tools/book-generator/greyveil/importer.py'),
    text('../supabase/founder-publishing-workflow.sql'),
  ])
  assert.match(admin, /image\/png,image\/jpeg,image\/webp/)
  assert.match(worker, /cover\\\.\(png\|jpe\?g\|webp\)/)
  assert.match(importer, /"\.webp": "WEBP"/)
  assert.match(importer, /print_name = "front-cover-print\.png"/)
  assert.match(importer, /image\.verify\(\)/)
  assert.match(sql, /'image\/png', 'image\/jpeg', 'image\/webp'/)
})

test('source-fidelity repair leaves queue, claim, and promotion implementations unchanged', async () => {
  const worker = await text('../tools/book-generator/run_generation_worker.py')
  const runBody = worker.slice(worker.indexOf('def run(job: dict)'), worker.indexOf('def candidate_entry'))
  const promotionBody = worker.slice(worker.indexOf('def promote(job: dict)'), worker.indexOf('def claim_one'))
  assert.doesNotMatch(runBody, /book-files|book-covers|greyveil_worker_finalize_generation_publication/)
  assert.match(promotionBody, /greyveil_worker_finalize_generation_publication/)
})
