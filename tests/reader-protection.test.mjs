import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { glob } from 'node:fs/promises'
import test from 'node:test'

const source = (path) => readFile(new URL(path, import.meta.url), 'utf8')

test('reader watermark uses only safe display identity and the current book title', async () => {
  const reader = await source('../assets/js/reader.js')
  assert.match(reader, /profile\?\.display_name/)
  assert.match(reader, /user\?\.user_metadata\?\.display_name/)
  assert.match(reader, /Greyveil Editions/)
  assert.match(reader, /book\?\.title/)
  assert.match(reader, /\\u2022/)

  const watermarkFunction = reader.slice(
    reader.indexOf('const watermarkTextForDecision'),
    reader.indexOf('const watermarkOffsetForPage')
  )
  assert.doesNotMatch(watermarkFunction, /\.email|\.role|\.id\b|uuid|phone/i)
})

test('reader repeats a session-varying watermark on every rendered page', async () => {
  const reader = await source('../assets/js/reader.js')
  assert.match(reader, /watermarkSessionSeed = Math\.floor\(Math\.random\(\) \* 1000000\)/)
  assert.match(reader, /querySelectorAll\("\.book-page"\)/)
  assert.match(reader, /reader-watermark-layer/)
  assert.match(reader, /length: 9/)
  assert.ok(reader.indexOf('pagesRoot.append(fragment)') < reader.indexOf('applyReaderWatermarks()', reader.indexOf('pagesRoot.append(fragment)')))
})

test('auth changes clear personal identity immediately and access lifecycle keeps rechecking', async () => {
  const reader = await source('../assets/js/reader.js')
  const authHandler = reader.slice(reader.indexOf('const handleReaderAuthChange'), reader.indexOf('const bindReaderAccessRefresh'))
  assert.match(authHandler, /context: \{ user: null, profile: null \}/)
  assert.match(authHandler, /recheckReaderAccess\(\{ force: true \}\)/)
  assert.match(reader, /onAuthStateChange\(handleReaderAuthChange\)/)
  assert.match(reader, /visibilitychange/)
  assert.match(reader, /window\.addEventListener\("focus"/)
  assert.match(reader, /window\.setInterval\(\(\) => recheckReaderAccess\(\), ACCESS_RECHECK_DELAY\)/)
  assert.match(reader, /if \(decision\.allowed && decision\.reason === "public"\)[\s\S]+getAccessContext\(\)/)
})

test('copy, selection, drag, context menu, and print deterrence remain scoped to book content', async () => {
  const [reader, css] = await Promise.all([
    source('../assets/js/reader.js'),
    source('../assets/css/reader.css'),
  ])
  for (const eventName of ['copy', 'cut', 'dragstart', 'contextmenu']) {
    assert.match(reader, new RegExp(`addEventListener\\("${eventName}"`))
  }
  assert.match(reader, /event\.ctrlKey \|\| event\.metaKey/)
  assert.match(reader, /String\(event\.key\)\.toLowerCase\(\) === "p"/)
  assert.match(reader, /\.book-page__content/)
  assert.match(reader, /input, textarea, select, button/)
  assert.match(reader, /\.feedback-panel/)
  assert.match(css, /user-select: none/)
  assert.match(css, /\.feedback-panel[\s\S]+user-select: text/)
  assert.match(css, /@media print[\s\S]+\.reader-watermark-layer/)
  assert.doesNotMatch(css, /touch-action:\s*none/)
})

test('every reader route loads the protected shared assets', async () => {
  const projectRoot = new URL('../projects/', import.meta.url)
  const readerEntries = []
  for await (const entry of glob('**/reader/index.html', { cwd: projectRoot })) readerEntries.push(entry)
  assert.equal(readerEntries.length, 14)
  for (const entry of readerEntries) {
    const html = await readFile(new URL(entry.replaceAll('\\', '/'), projectRoot), 'utf8')
    assert.match(html, /reader\.css\?v=20260812-protection/)
    assert.match(html, /reader\.js\?v=20260812-protection/)
  }
})

test('raw reader JSON is still public deployment material and requires a future private-delivery migration', async () => {
  const [book, chapter, vercelIgnore] = await Promise.all([
    source('../assets/books/the-last-shift/book.json'),
    source('../assets/books/the-last-shift/chapters/08-chapter-01.json'),
    source('../.vercelignore'),
  ])
  assert.match(book, /"units"/)
  assert.match(chapter, /"elements"/)
  assert.doesNotMatch(vercelIgnore, /^assets\/books\/$/m)
  assert.doesNotMatch(vercelIgnore, /chapters\/\*\.json/)
})

test('Vercel excludes private publishing outputs and generator-only cover masters', async () => {
  const vercelIgnore = await source('../.vercelignore')
  for (const pattern of [
    'generated/',
    'output/',
    'projects/**/chapters/WORD/',
    'assets/books/**/cover/front-cover-print.png',
    'assets/books/**/cover/cover-source.png',
    'assets/books/**/design-spec.json',
  ]) assert.match(vercelIgnore, new RegExp(pattern.replaceAll('*', '\\*').replaceAll('/', '\\/')))
  assert.doesNotMatch(vercelIgnore, /front-cover\.webp/)
  assert.doesNotMatch(vercelIgnore, /chapters\/\*\.json/)
})

test('file permissions and safe deletes are independently enforced by RLS', async () => {
  const [sql, admin] = await Promise.all([
    source('../supabase/admin-publishing-step-1.sql'),
    source('../assets/js/admin.js'),
  ])
  assert.match(sql, /book_id bigint not null references public\.books\(id\)/)
  assert.match(sql, /file_type = 'pdf'/)
  assert.match(sql, /greyveil_is_super_admin\(\)/)
  assert.match(sql, /not exists \([\s\S]+from public\.volumes/)
  assert.match(sql, /not exists \([\s\S]+from public\.series/)
  assert.match(sql, /not exists \([\s\S]+from public\.books/)
  assert.match(admin, /createSignedUrl\(record\.storage_path, 60\)/)
  assert.match(admin, /const token = kind === 'book' \? 'DELETE BOOK' : 'DELETE'/)
  assert.match(admin, /Delete blocked: \$\{deleteDependencyText\(kind, counts\)\}/)
})
