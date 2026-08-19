import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const source = await readFile(new URL('../assets/js/founder-publishing.js', import.meta.url), 'utf8')
const refreshJobs = source.slice(source.indexOf('const refreshJobs'), source.indexOf('const refreshPasses'))

test('generation polling replaces only the live jobs region', () => {
  assert.match(refreshJobs, /book_generation_jobs/)
  assert.match(refreshJobs, /renderJobsPanel\(\)/)
  assert.doesNotMatch(refreshJobs, /renderCreator|renderCatalogPanel|renderPassesPanel|host\.replaceChildren/)
})

test('typed 1-Day Pass values survive a generation job poll', () => {
  assert.match(source, /const form = protectForm\(el\('form', 'admin-access-grid'\)\)/)
  assert.match(source, /const renderJobsPanel = \(\) => \{ if \(jobsHost\) jobsHost\.replaceChildren\(renderJobs\(\)\) \}/)
  assert.doesNotMatch(refreshJobs, /passSummaryHost|temporary_access_passes/)
})

test('new book metadata and selected uploads are outside the polling render path', () => {
  assert.match(source, /field\('manuscript', 'Manuscript \(\.docx\)', 'file'/)
  assert.match(source, /field\('cover', 'Cover image', 'file'/)
  assert.match(source, /const renderCreator = \(\)/)
  assert.doesNotMatch(refreshJobs, /renderCreator|host\.replaceChildren/)
})

test('unsaved Book, Series, and Collection prices are protected from unrelated refreshes', () => {
  assert.match(source, /const row = protectForm\(el\('form', 'admin-platform-item'\)\)/)
  assert.doesNotMatch(refreshJobs, /renderCatalogPanel/)
})

test('explicit saves establish a clean baseline without clearing input on failure', () => {
  assert.match(source, /updateCatalogBaseline\(item, p, visibility\.value\); row\.dataset\.dirty = 'false'/)
  assert.match(source, /form\.dataset\.dirty = 'false'; setStatus\(status, '1-Day Pass saved\.'/)
  assert.doesNotMatch(source, /\.reset\(\)/)
})

test('polling cannot overlap, stale job responses are ignored, and forms are not rebound by polling', () => {
  assert.match(source, /if \(jobsLoading\) return/)
  assert.match(source, /const request = \+\+jobsRequest/)
  assert.match(source, /if \(request !== jobsRequest\) return/)
  assert.match(source, /document\.hidden/)
  assert.doesNotMatch(refreshJobs, /addEventListener/)
})
