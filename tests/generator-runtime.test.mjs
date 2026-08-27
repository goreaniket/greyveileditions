import assert from 'node:assert/strict'
import { access, readFile } from 'node:fs/promises'
import test from 'node:test'

const text = (path) => readFile(new URL(path, import.meta.url), 'utf8')

test('Railway runtime is retired and the worker has no continuous production poller', async () => {
  await assert.rejects(access(new URL('../railpack.json', import.meta.url)))
  const [worker, vercelIgnore] = await Promise.all([
    text('../tools/book-generator/run_generation_worker.py'),
    text('../.vercelignore'),
  ])
  assert.doesNotMatch(worker, /--loop|GREYVEIL_WORKER_POLL_SECONDS|run_loop|Railway/i)
  assert.doesNotMatch(vercelIgnore, /railpack|Railway/i)
})

test('worker keeps exact-job and local one-shot execution only', async () => {
  const worker = await text('../tools/book-generator/run_generation_worker.py')
  assert.match(worker, /modes\.add_argument\("--once"/)
  assert.match(worker, /modes\.add_argument\("--job"/)
  assert.match(worker, /outcome = process_one\(args\.job\)/)
  assert.match(worker, /job = claim_one\(target_job_id\)/)
  assert.match(worker, /heartbeat = ClaimHeartbeat\(job\)/)
  assert.match(worker, /with bounded_job_processing\(\):/)
  assert.match(worker, /if job\["status"\] == "PUBLISH_REQUESTED":\s+promote\(job\)\s+else:\s+run\(job\)/)
})

test('runtime requirements remain pinned and Vercel cannot start the Python worker', async () => {
  const [requirements, vercelConfig, vercelIgnore] = await Promise.all([
    text('../requirements.txt'),
    text('../vercel.json'),
    text('../.vercelignore'),
  ])
  assert.deepEqual(requirements.trim().split(/\r?\n/).sort(), [
    'Pillow==12.3.0',
    'pypdf==6.10.0',
    'python-docx==1.2.0',
    'reportlab==4.4.9',
  ].sort())
  assert.doesNotMatch(vercelConfig, /run_generation_worker|railway|python/i)
  for (const ignored of ['tools/', '.github/', 'requirements.txt', '.python-version']) {
    assert.match(vercelIgnore, new RegExp(`^${ignored.replace('.', '\\.')}$`, 'm'))
  }
})
