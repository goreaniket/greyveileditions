import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { collectReaderResources } from '../tools/upload-reader-content.mjs'

const source = (path) => readFile(new URL(path, import.meta.url), 'utf8')

const importSource = async (path, mocks = '') => {
  let text = await source(path)
  text = text.replace(/^import(?:[\s\S]*?from\s+)?['"][^'"]+['"]\s*;?\s*$/gm, '')
  return import(`data:text/javascript;base64,${Buffer.from(`${mocks}\n${text}`).toString('base64')}`)
}

test('private reader upload inventory contains every manifest-referenced JSON resource', async () => {
  const resources = await collectReaderResources()
  assert.equal(new Set(resources.map((item) => item.slug)).size, 14)
  assert.equal(resources.length, 366)
  assert.ok(resources.every((item) => item.resource === 'book.json' || /^chapters\/[a-z0-9][a-z0-9._-]*\.json$/i.test(item.resource)))
  assert.ok(resources.every((item) => item.data.length > 0))
})

test('reader access matrix preserves public, paid, private, admin, expiry, and revocation rules', async () => {
  const access = await importSource('../assets/js/content-access.js', `
    const supabase = {};
    const getCurrentProfile = async () => null;
    const getCurrentUser = async () => null;
  `)
  const base = {
    collection: { id: 'collection', visibility: 'public', is_active: true },
    volume: { id: 'volume', collection_id: 'collection', visibility: 'public', is_active: true },
    series: { id: 'series', collection_id: 'collection', volume_id: 'volume', visibility: 'public', is_active: true },
  }
  const publicHierarchy = { ...base, book: { id: 1, series_id: 'series', visibility: 'public', is_public: true, is_active: true } }
  const legacyPublicHierarchy = {
    ...base,
    collection: { ...base.collection, visibility: 'private' },
    book: { id: 4, series_id: 'series', visibility: 'paid', is_public: true, is_active: true },
  }
  const paidHierarchy = { ...base, book: { id: 2, series_id: 'series', visibility: 'paid', is_public: false, is_active: true } }
  const privateHierarchy = { ...base, book: { id: 3, series_id: 'series', visibility: 'private', is_public: false, is_active: true } }
  const guest = { user: null, role: 'guest' }
  const customer = { user: { id: 'customer' }, role: 'customer' }
  const admin = { user: { id: 'admin' }, role: 'admin' }
  const collectionPass = {
    id: 'collection-pass',
    active: true,
    scope_type: 'collection',
    collection_id: 'collection',
  }
  const activeActivation = {
    pass_id: collectionPass.id,
    user_id: customer.user.id,
    expires_at: '2099-01-01T00:00:00Z',
  }

  assert.equal(access.canReadBook(publicHierarchy, guest), true)
  assert.equal(access.canReadBook(legacyPublicHierarchy, guest), true)
  assert.equal(access.canReadBook(paidHierarchy, guest), false)
  assert.equal(access.canReadBook(paidHierarchy, customer), false)
  assert.equal(access.canReadBook({ ...paidHierarchy, grants: [{ book_id: 2, is_visible: true, can_read: true }] }, customer), true)
  assert.equal(access.canReadBook({ ...paidHierarchy, grants: [{ book_id: 2, is_visible: true, can_read: true, expires_at: '2000-01-01T00:00:00Z' }] }, customer), false)
  assert.equal(access.canReadBook({ ...paidHierarchy, grants: [{ book_id: 2, is_visible: false, can_read: true }] }, customer), false)
  assert.equal(access.canReadBook({
    ...paidHierarchy,
    accessPasses: [collectionPass],
    passActivations: [activeActivation],
  }, customer), true)
  assert.equal(access.canReadBook({
    ...paidHierarchy,
    accessPasses: [collectionPass],
    passActivations: [{ ...activeActivation, expires_at: '2000-01-01T00:00:00Z' }],
  }, customer), false)
  assert.equal(access.canReadBook({
    ...paidHierarchy,
    accessPasses: [{ ...collectionPass, collection_id: 'another-collection' }],
    passActivations: [activeActivation],
  }, customer), false)
  assert.equal(access.canReadBook({
    ...paidHierarchy,
    accessPasses: [collectionPass],
    passActivations: [{ ...activeActivation, user_id: 'another-user' }],
  }, customer), false)
  assert.equal(access.canReadBook(privateHierarchy, customer), false)
  assert.equal(access.canReadBook(privateHierarchy, admin), true)
})

test('Reader preflight uses the shared Pass-aware book resolver', async () => {
  const access = await source('../assets/js/content-access.js')
  const resolver = access.slice(access.indexOf('export const resolveReaderAccess'), access.length)
  assert.match(resolver, /fetchActiveAccessPasses\(\)/)
  assert.match(resolver, /fetchViewerPassActivations\(context\.user\.id\)/)
  assert.match(resolver, /const entitled = canReadBook\(\{/)
  assert.match(resolver, /accessPasses,[\s\S]+passActivations/)
  assert.doesNotMatch(resolver, /const entitled = hasBookEntitlement/)
})

test('database reader resolver is service-only and uses current book_access flags', async () => {
  const sql = await source('../supabase/private-reader-content.sql')
  assert.match(sql, /'reader-content',[\s\S]+false,[\s\S]+application\/json/)
  assert.doesNotMatch(sql, /create policy[\s\S]+reader-content/i)
  assert.match(sql, /viewer_role in \('admin', 'super_admin'\)/)
  assert.ok(sql.indexOf("coalesce(book.is_public, false)") < sql.indexOf("coalesce(series_item.visibility, 'public')) = 'private'"))
  assert.match(sql, /effective_visibility = 'public'/)
  assert.match(sql, /effective_visibility = 'private'/)
  assert.match(sql, /from public\.book_access access/)
  assert.match(sql, /access\.is_visible = true/)
  assert.match(sql, /access\.can_read = true/)
  assert.match(sql, /access\.expires_at is null or access\.expires_at > now\(\)/)
  assert.match(sql, /revoke all on function public\.greyveil_reader_content_authorization\(uuid, text\) from anon/)
  assert.match(sql, /revoke all on function public\.greyveil_reader_content_authorization\(uuid, text\) from authenticated/)
  assert.match(sql, /grant execute on function public\.greyveil_reader_content_authorization\(uuid, text\) to service_role/)
})

test('Reader delivery authenticates before private storage reads and never returns signed URLs', async () => {
  const [edge, api, config] = await Promise.all([
    source('../supabase/functions/reader-content/index.ts'),
    source('../api/reader-content.js'),
    source('../supabase/config.toml'),
  ])
  assert.match(edge, /admin\.auth\.getUser\(token\)/)
  assert.match(edge, /SUPABASE_SECRET_KEYS/)
  assert.match(edge, /SUPABASE_SERVICE_ROLE_KEY/)
  assert.match(edge, /greyveil_reader_content_authorization/)
  assert.match(edge, /RESOURCE_PATTERN/)
  assert.match(edge, /MAX_RESOURCES = 64/)
  assert.match(edge, /admin\.storage\.from\(BUCKET\)\.download/)
  assert.match(edge, /\.eq\('file_type', 'source'\)/)
  assert.match(edge, /published\/\$\{bookSlug\}\/\$\{VERSION_PATTERN\}\/source/)
  assert.match(edge, /return \{ source: 'legacy'/)
  assert.match(edge, /Cache-Control': 'private, no-store, max-age=0'/)
  assert.ok(edge.indexOf(".rpc('greyveil_reader_content_authorization'") < edge.indexOf('await readResources(admin'))
  assert.doesNotMatch(edge, /createSignedUrl|getPublicUrl/)
  assert.doesNotMatch(edge, /service_role.*resources|SUPABASE_SERVICE_ROLE_KEY.*return/i)
  assert.match(api, /greyveil_reader_content_authorization/)
  assert.match(api, /handleReaderContentRequest/)
  assert.match(api, /downloadObject\('reader-content'/)
  assert.match(config, /\[functions\.reader-content\][\s\S]+verify_jwt = false/)
})

test('reader retrieves no manifest or chapter content until access resolution succeeds', async () => {
  const reader = await source('../assets/js/reader.js')
  const loadBook = reader.slice(reader.indexOf('const loadBook = async'), reader.indexOf('const init = async'))
  assert.match(reader, /fetch\("\/api\/reader-content"/)
  assert.match(reader, /await getCurrentSessionOnce\(\)/)
  assert.doesNotMatch(reader, /const fetchJson/)
  assert.ok(loadBook.indexOf('await guardReaderAccess()') < loadBook.indexOf('fetchReaderContent(["book.json"])'))
  assert.ok(loadBook.indexOf('fetchReaderContent(["book.json"])') < loadBook.indexOf('fetchReaderContent(unitResources)'))
  assert.ok(loadBook.lastIndexOf('await guardReaderAccess()') > loadBook.indexOf('fetchReaderContent(unitResources)'))
  assert.doesNotMatch(loadBook, /fetch\(bookResponseUrl/)
  assert.doesNotMatch(reader, /localStorage\.setItem\([^\n]+(?:book|unit|chapter|content)/i)
  assert.doesNotMatch(reader, /indexedDB|caches\.open/)
})

test('admin file permissions, expiring signed URLs, and safe deletes have independent enforcement', async () => {
  const [admin, sql] = await Promise.all([
    source('../assets/js/admin.js'),
    source('../supabase/admin-publishing-step-1.sql'),
  ])
  const permissionSource = admin.match(/const roleCanManageBookFileType = \(role, fileType\) => \{[\s\S]*?\n\}/)?.[0]
  assert.ok(permissionSource)
  const roleCanManage = Function(
    'BOOK_FILE_CONFIGS',
    `${permissionSource}; return roleCanManageBookFileType;`
  )({
    pdf: { superAdminOnly: false },
    epub: { superAdminOnly: true },
    docx: { superAdminOnly: true },
  })
  assert.deepEqual(['pdf', 'epub', 'docx'].map((type) => roleCanManage('admin', type)), [true, false, false])
  assert.deepEqual(['pdf', 'epub', 'docx'].map((type) => roleCanManage('super_admin', type)), [true, true, true])
  assert.deepEqual(['pdf', 'epub', 'docx'].map((type) => roleCanManage('customer', type)), [false, false, false])
  assert.deepEqual(['pdf', 'epub', 'docx'].map((type) => roleCanManage('guest', type)), [false, false, false])
  assert.match(admin, /pdf:[\s\S]+superAdminOnly: false/)
  assert.match(admin, /epub:[\s\S]+superAdminOnly: true/)
  assert.match(admin, /docx:[\s\S]+superAdminOnly: true/)
  assert.match(admin, /role === 'super_admin'/)
  assert.match(admin, /role === 'admin' && !config\.superAdminOnly/)
  assert.match(admin, /SIGNED_URL_TTL_SECONDS = 60/)
  assert.match(admin, /SIGNED_PREVIEW_CLEAR_DELAY = 55000/)
  assert.match(admin, /Preview expired\. Select Preview to refresh it\./)
  assert.match(admin, /button\.disabled = true[\s\S]+\.upload\(/)
  assert.match(sql, /insert into storage\.buckets[\s\S]+'book-covers'[\s\S]+false/)
  assert.match(sql, /insert into storage\.buckets[\s\S]+'book-files'[\s\S]+false/)
  assert.match(sql, /greyveil_is_super_admin\(\)[\s\S]+file_type = 'pdf'/)
  assert.match(sql, /bucket_id = 'book-files'[\s\S]+storage\.filename\(name\) = 'book\.pdf'/)
  assert.match(admin, /const token = kind === 'book' \? 'DELETE BOOK' : 'DELETE'/)
  assert.match(admin, /state\.contentSelection = \{ kind: '', id: '' \}/)
  assert.match(sql, /Admins can delete empty collections/)
  assert.match(sql, /Admins can delete empty volumes/)
  assert.match(sql, /Admins can delete empty series/)
})
