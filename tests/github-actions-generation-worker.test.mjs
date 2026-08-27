import assert from 'node:assert/strict'
import { access, readFile } from 'node:fs/promises'
import test from 'node:test'

const text = (path) => readFile(new URL(path, import.meta.url), 'utf8')

test('on-demand workflow accepts one required UUID job and uses the existing one-job worker', async () => {
  const workflow = await text('../.github/workflows/greyveil-generation-worker.yml')

  assert.match(workflow, /^\s{2}workflow_dispatch:\s*$/m)
  assert.match(workflow, /^\s{6}job_id:\s*\n\s{8}description:.*\n\s{8}required: true\s*\n\s{8}type: string\s*$/m)
  assert.match(workflow, /^\s{4}runs-on: ubuntu-latest\s*$/m)
  assert.match(workflow, /python-version: ["']3\.12["']/)
  assert.match(workflow, /python -m pip install --requirement requirements\.txt/)
  assert.match(workflow, /\^\[0-9a-f\]\{8\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{12\}\$/)
  assert.match(workflow, /python tools\/book-generator\/run_generation_worker\.py --job "\$JOB_ID"/)
  assert.doesNotMatch(workflow, /run_generation_worker\.py --loop/)
})

test('workflow has least privilege, bounded execution, and non-cancelling per-job concurrency', async () => {
  const workflow = await text('../.github/workflows/greyveil-generation-worker.yml')

  assert.match(workflow, /^permissions:\s*\n\s{2}contents: read\s*$/m)
  assert.doesNotMatch(workflow, /^\s+(?:contents|packages|actions): write\s*$/m)
  assert.match(workflow, /^\s{4}timeout-minutes: [1-9][0-9]*\s*$/m)
  assert.match(workflow, /^concurrency:\s*\n\s{2}group: greyveil-generation-\$\{\{ inputs\.job_id \}\}\s*\n\s{2}cancel-in-progress: false\s*$/m)
})

test('Supabase credentials come only from GitHub Secrets and are never printed', async () => {
  const workflow = await text('../.github/workflows/greyveil-generation-worker.yml')

  assert.match(workflow, /^\s{10}SUPABASE_URL: \$\{\{ secrets\.SUPABASE_URL \}\}\s*$/m)
  assert.match(workflow, /^\s{10}SUPABASE_SERVICE_ROLE_KEY: \$\{\{ secrets\.SUPABASE_SERVICE_ROLE_KEY \}\}\s*$/m)
  assert.equal((workflow.match(/secrets\./g) || []).length, 2)
  assert.doesNotMatch(workflow, /(?:echo|printf).*SUPABASE_(?:URL|SERVICE_ROLE_KEY)/i)
  assert.doesNotMatch(workflow, /Razorpay|Resend/i)
})

test('runner artifacts stay ephemeral and worker-only resources stay outside Vercel', async () => {
  const [workflow, worker, vercelIgnore] = await Promise.all([
    text('../.github/workflows/greyveil-generation-worker.yml'),
    text('../tools/book-generator/run_generation_worker.py'),
    text('../.vercelignore'),
  ])

  assert.doesNotMatch(workflow, /actions\/upload-artifact|git (?:add|commit|push)|(?:public|assets)\//i)
  assert.match(worker, /with isolated_job_workspace\(job_id\) as workspace:/)
  assert.match(worker, /"--repo-root", str\(workspace\.repository\)/)
  assert.match(worker, /"--output-dir", str\(workspace\.outputs\)/)
  assert.match(worker, /storage_upload\("generation-candidates"/)
  assert.match(worker, /if job\["status"\] == "PUBLISH_REQUESTED":\s+promote\(job\)/)

  for (const ignored of ['tools/', '.github/', 'requirements.txt', '.python-version']) {
    assert.match(vercelIgnore, new RegExp(`^${ignored.replace('.', '\\.')}$`, 'm'))
  }
  await assert.rejects(access(new URL('../railpack.json', import.meta.url)))
})
