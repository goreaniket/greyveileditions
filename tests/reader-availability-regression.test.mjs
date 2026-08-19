import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const require = createRequire(import.meta.url)
const {
  handleReaderContentRequest,
  resolveReaderResourceSet,
  validatePublishedSource,
} = require('../api/_lib/reader-delivery.js')

const slug = 'existing-greyveil-book'
const authorization = (reason) => ({
  book_id: 1,
  book_slug: slug,
  book_title: 'Existing Greyveil Book',
  effective_visibility: reason === 'public' ? 'public' : 'paid',
  allowed: true,
  reason,
})
const request = { body: { book_slug: slug, resources: ['book.json'] }, token: 'session-token' }
const legacyManifest = Buffer.from(JSON.stringify({ id: slug, title: 'Existing Greyveil Book', units: [] }))

const servicesFor = (decision, overrides = {}) => ({
  resolveViewerId: async (token) => token ? 'viewer-id' : null,
  authorize: async () => decision,
  findPublishedSource: async () => null,
  downloadPublishedSource: async () => { throw new Error('published source should not be read') },
  downloadLegacyResource: async () => legacyManifest,
  ...overrides,
})

test('admin can open an existing legacy Book Reader', async () => {
  const result = await handleReaderContentRequest(request, servicesFor(authorization('admin')))
  assert.equal(result.status, 200)
  assert.equal(result.body.source, 'legacy')
  assert.equal(result.body.resources['book.json'].id, slug)
})

test('normal entitled customer can open the Reader', async () => {
  const result = await handleReaderContentRequest(request, servicesFor(authorization('entitled')))
  assert.equal(result.status, 200)
  assert.equal(result.body.book.slug, slug)
})

test('public Book works logged out', async () => {
  let resolvedToken = 'not-called'
  const result = await handleReaderContentRequest(
    { ...request, token: '' },
    servicesFor(authorization('public'), {
      resolveViewerId: async (token) => { resolvedToken = token; return null },
    }),
  )
  assert.equal(result.status, 200)
  assert.equal(resolvedToken, '')
})

test('unauthorized paid Book remains denied before any source read', async () => {
  let sourceReads = 0
  const result = await handleReaderContentRequest(request, servicesFor({
    ...authorization('access_required'),
    allowed: false,
  }, {
    findPublishedSource: async () => { sourceReads += 1; return null },
    downloadLegacyResource: async () => { sourceReads += 1; return legacyManifest },
  }))
  assert.equal(result.status, 403)
  assert.equal(result.body.error.code, 'access_required')
  assert.equal(sourceReads, 0)
})

test('existing legacy Book resolves without a publication-version row', async () => {
  const result = await resolveReaderResourceSet({
    bookId: 1,
    bookSlug: slug,
    resources: ['book.json'],
    findPublishedSource: async () => null,
    downloadPublishedSource: async () => { throw new Error('unexpected published lookup') },
    downloadLegacyResource: async () => legacyManifest,
  })
  assert.equal(result.source, 'legacy')
  assert.equal(result.resources['book.json'].title, 'Existing Greyveil Book')
})

const storedZip = (name, content) => {
  const fileName = Buffer.from(name)
  const data = Buffer.from(content)
  const local = Buffer.alloc(30 + fileName.length + data.length)
  local.writeUInt32LE(0x04034b50, 0)
  local.writeUInt16LE(20, 4)
  local.writeUInt16LE(0, 8)
  local.writeUInt32LE(data.length, 18)
  local.writeUInt32LE(data.length, 22)
  local.writeUInt16LE(fileName.length, 26)
  fileName.copy(local, 30)
  data.copy(local, 30 + fileName.length)

  const central = Buffer.alloc(46 + fileName.length)
  central.writeUInt32LE(0x02014b50, 0)
  central.writeUInt16LE(20, 4)
  central.writeUInt16LE(20, 6)
  central.writeUInt16LE(0, 10)
  central.writeUInt32LE(data.length, 20)
  central.writeUInt32LE(data.length, 24)
  central.writeUInt16LE(fileName.length, 28)
  fileName.copy(central, 46)

  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(1, 8)
  end.writeUInt16LE(1, 10)
  end.writeUInt32LE(central.length, 12)
  end.writeUInt32LE(local.length, 16)
  return Buffer.concat([local, central, end])
}

test('new versioned published Book resolves its canonical source archive', async () => {
  const version = '123e4567-e89b-42d3-a456-426614174000'
  const archive = storedZip(`${slug}/book.json`, legacyManifest)
  const result = await resolveReaderResourceSet({
    bookId: 1,
    bookSlug: slug,
    resources: ['book.json'],
    findPublishedSource: async () => ({
      file_type: 'source',
      storage_path: `published/${slug}/${version}/source/${slug}-source.zip`,
      file_size: archive.length,
    }),
    downloadPublishedSource: async () => archive,
    downloadLegacyResource: async () => { throw new Error('legacy source must not replace a published version') },
  })
  assert.equal(result.source, 'published')
  assert.equal(result.resources['book.json'].id, slug)
})

test('candidate or unpublished source paths cannot be served', () => {
  assert.throws(() => validatePublishedSource({
    file_type: 'source',
    storage_path: 'jobs/123/source/candidate-source.zip',
    file_size: 100,
  }, slug), (error) => error.code === 'published_reference_invalid')
  assert.throws(() => validatePublishedSource({
    file_type: 'source',
    storage_path: `published/${slug}/not-a-version/source/${slug}-source.zip`,
    file_size: 100,
  }, slug), (error) => error.code === 'published_reference_invalid')
})

test('slow session initialization is awaited before the Reader API request', async () => {
  const reader = await readFile(new URL('../assets/js/reader.js', import.meta.url), 'utf8')
  const fetchReader = reader.slice(reader.indexOf('const fetchReaderContent'), reader.indexOf('const readerAccessCopy'))
  assert.ok(fetchReader.indexOf('await getCurrentSessionOnce()') < fetchReader.indexOf('fetch("/api/reader-content"'))
  assert.match(fetchReader, /sessionData\?\.session\?\.access_token/)
  assert.doesNotMatch(fetchReader, /supabase\.functions\.invoke/)
})

test('Reader keeps distinct internal delivery failure categories', async () => {
  const reader = await readFile(new URL('../assets/js/reader.js', import.meta.url), 'utf8')
  for (const category of [
    'authorization_denied',
    'book_not_found',
    'source_missing',
    'published_reference_missing',
    'network_error',
    'reader_api_failed',
  ]) assert.match(reader, new RegExp(`category: "${category}"`))
})
