import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const source = (path) => readFile(new URL(path, import.meta.url), 'utf8')

test('founder generation jobs are durable, private, and publish only after QA', async () => {
  const sql = await source('../supabase/founder-publishing-workflow.sql')
  assert.match(sql, /create table if not exists public\.book_generation_jobs/)
  assert.match(sql, /'READY_TO_PUBLISH'/)
  assert.match(sql, /alter table public\.book_generation_jobs enable row level security/)
  assert.match(sql, /Admins read generation jobs/)
  assert.match(sql, /greyveil_admin_publish_generation_job/)
  assert.match(sql, /job\.status <> 'READY_TO_PUBLISH'/)
  assert.match(sql, /\(job\.qa->>'ok'\)::boolean/)
  assert.match(sql, /generation-inputs.*false/s)
  assert.match(sql, /generation-candidates.*false/s)
  assert.match(sql, /if not public\.greyveil_is_admin\(\)/)
  assert.match(sql, /revoke all on function public\.greyveil_admin_publish_generation_job/)
  assert.doesNotMatch(sql, /create policy .*generation.* to anon/i)
})

test('generation runs only through the worker-compatible Python entry point', async () => {
  const [worker, importer] = await Promise.all([
    source('../tools/book-generator/run_generation_worker.py'),
    source('../tools/book-generator/greyveil/importer.py'),
  ])
  assert.match(worker, /SUPABASE_SERVICE_ROLE_KEY/)
  assert.match(worker, /generation-candidates/)
  assert.match(worker, /validate_generated_outputs/)
  assert.match(worker, /READY_TO_PUBLISH/)
  assert.doesNotMatch(worker, /Deno\.serve/)
  assert.match(importer, /metadata_overrides/)
})

test('admin founder workflow keeps commerce saves independent of generation and polls modestly', async () => {
  const [admin, founder] = await Promise.all([
    source('../admin/index.html'), source('../assets/js/founder-publishing.js'),
  ])
  assert.match(admin, /data-admin-tab="publishing"/)
  assert.match(founder, /Save Commerce Changes/)
  assert.match(founder, /greyveil_admin_update_catalog_price/)
  assert.match(founder, /POLL_MS = 8000/)
  assert.match(founder, /greyveil_admin_publish_generation_job/)
  assert.match(founder, /qa\.ok === true/)
})

test('guest pass offer uses the active database pass and preserves checkout target', async () => {
  const [home, pass, commerce] = await Promise.all([
    source('../index.html'), source('../assets/js/access-pass.js'), source('../assets/js/commerce.js'),
  ])
  assert.match(home, /data-access-pass-offer/)
  assert.match(pass, /temporary_access_passes/)
  assert.match(pass, /formatCurrency\(pass\.price_amount\)/)
  assert.match(pass, /temporary_access_pass_activations/)
  assert.match(pass, /temporary_access_pass_id/)
  assert.match(commerce, /'pass'/)
  assert.match(commerce, /temporary_access_pass_id/)
})

test('announcements render a restrained hero highlight and floating placement from the existing system', async () => {
  const [announcements, css] = await Promise.all([
    source('../assets/js/announcements.js'), source('../assets/css/style.css'),
  ])
  assert.match(announcements, /renderHeroHighlight/)
  assert.match(announcements, /renderFloating/)
  assert.match(announcements, /New from Greyveil/)
  assert.match(css, /\.announcement-hero-highlight/)
  assert.match(css, /\.floating-announcement/)
})
