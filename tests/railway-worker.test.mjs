import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const text = (path) => readFile(new URL(path, import.meta.url), 'utf8')

test('Railpack starts the explicit continuous Railway worker', async () => {
  const [rawConfig, pythonVersion] = await Promise.all([
    text('../railpack.json'),
    text('../.python-version'),
  ])
  const config = JSON.parse(rawConfig)
  assert.equal(config.$schema, 'https://schema.railpack.com')
  assert.equal(config.deploy.startCommand, 'python tools/book-generator/run_generation_worker.py --loop')
  assert.equal('healthcheckPath' in config.deploy, false)
  assert.equal('cronSchedule' in config.deploy, false)
  for (const privatePath of [
    '.env', 'generated', 'output', 'tmp', 'projects/**/chapters',
    'assets/documents/source', 'supabase', 'tests', 'tools/book-generator/tests',
  ]) {
    assert.ok(config.exclude.includes(privatePath), `${privatePath} must be excluded from the worker image`)
  }
  assert.equal(config.exclude.some((pattern) => pattern.startsWith('assets/books')), false)
  assert.equal(pythonVersion.trim(), '3.12')
})

test('runtime requirements are intentionally pinned and production-only', async () => {
  const requirements = (await text('../requirements.txt')).trim().split(/\r?\n/).sort()
  assert.deepEqual(requirements, [
    'Pillow==12.3.0',
    'pypdf==6.10.0',
    'python-docx==1.2.0',
    'reportlab==4.4.9',
  ].sort())
})

test('Vercel remains static and cannot start the Python worker', async () => {
  const [vercelConfig, vercelIgnore, railpackConfig] = await Promise.all([
    text('../vercel.json'),
    text('../.vercelignore'),
    text('../railpack.json'),
  ])
  assert.doesNotMatch(vercelConfig, /run_generation_worker|railway|python/i)
  assert.match(vercelIgnore, /^tools\/$/m)
  assert.match(vercelIgnore, /^railpack\.json$/m)
  assert.match(vercelIgnore, /^requirements\.txt$/m)
  assert.match(vercelIgnore, /^\.python-version$/m)
  assert.match(railpackConfig, /run_generation_worker\.py --loop/)
})

test('continuous mode shares the one-job claim, heartbeat, generation, and publication path', async () => {
  const worker = await text('../tools/book-generator/run_generation_worker.py')
  assert.match(worker, /modes\.add_argument\("--once"/)
  assert.match(worker, /modes\.add_argument\("--job"/)
  assert.match(worker, /modes\.add_argument\("--loop"/)
  assert.match(worker, /outcome = process\(None\)/)
  assert.match(worker, /job = claim_one\(target_job_id\)/)
  assert.match(worker, /heartbeat = ClaimHeartbeat\(job\)/)
  assert.match(worker, /if job\["status"\] == "PUBLISH_REQUESTED":\s+promote\(job\)\s+else:\s+run\(job\)/)
})
