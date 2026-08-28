import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const source = (path) => readFile(new URL(path, import.meta.url), 'utf8')

test('Founder Publishing loads catalog selectors from live tables and reports failures', async () => {
  const founder = await source('../assets/js/founder-publishing.js')
  assert.match(founder, /key: 'collections', table: 'collections'/)
  assert.match(founder, /fallback: 'id,title,slug,visibility'/)
  assert.match(founder, /could not be loaded: \$\{text\(error\?\.message/)
  assert.match(founder, /data-catalog-select/)
  assert.match(founder, /syncCatalogSelectors/)
  assert.doesNotMatch(founder, /Human Mind Collection/)
})

test('Collection-scoped passes require a selected collection while Library scope clears that requirement', async () => {
  const founder = await source('../assets/js/founder-publishing.js')
  assert.match(founder, /form\.elements\.collection\.disabled = library/)
  assert.match(founder, /form\.elements\.collection\.required = !library/)
  assert.match(founder, /collection_id: library \? null : form\.elements\.collection\.value \|\| null/)
  assert.match(founder, /Choose a collection-scoped pass or select Library\./)
})

test('catalog refreshes are event-driven and do not come from generation polling', async () => {
  const [founder, admin] = await Promise.all([
    source('../assets/js/founder-publishing.js'), source('../assets/js/admin.js'),
  ])
  const refreshJobs = founder.slice(founder.indexOf('const refreshJobs'), founder.indexOf('const refreshPasses'))
  assert.match(founder, /window\.addEventListener\('greyveil:catalog-changed'/)
  assert.match(admin, /type: 'collection'/)
  assert.match(admin, /type: 'series'/)
  assert.doesNotMatch(refreshJobs, /refreshCatalog|renderCatalogPanel|renderPassesPanel/)
})

test('public enhancement shares session reads and renders catalog mounts from the canonical payload', async () => {
  const [client, auth, commerce, pass, announcements, main, access, home, projects, mind, css] = await Promise.all([
    source('../assets/js/supabase-client.js'), source('../assets/js/auth.js'), source('../assets/js/commerce.js'),
    source('../assets/js/access-pass.js'), source('../assets/js/announcements.js'), source('../assets/js/main.js'),
    source('../assets/js/content-access.js'), source('../index.html'), source('../projects/index.html'),
    source('../projects/human-mind/index.html'), source('../assets/css/style.css'),
  ])
  assert.match(client, /export const getCurrentSessionOnce/)
  assert.match(auth, /getCurrentSessionOnce/)
  assert.match(commerce, /getCurrentSessionOnce/)
  assert.match(pass, /if \(!host\) return/)
  assert.match(announcements, /let announcementsInit = null/)
  assert.match(announcements, /if \(!announcements\.length\) return/)
  assert.match(access, /supabase\.rpc\(PUBLIC_CATALOG_RPC\)/)
  assert.match(access, /fetchContentHierarchyFromTables/)
  assert.match(main, /renderCatalogSurfaces\(hierarchy, access, context, lookup\)/)
  assert.match(home, /data-catalog-series/)
  assert.match(projects, /data-catalog-collection="human-paradox-collection"/)
  assert.match(mind, /data-catalog-books="human-mind"/)
  assert.doesNotMatch(mind, /<article class="book-card/)
  assert.doesNotMatch(main, /node\.hidden = true;/)
  assert.doesNotMatch(css, /body:not\(\[data-access-state="resolved"\]\) \.project-card/)
})

test('informational routes skip catalog hydration while Account shares the unversioned entitlement module', async () => {
  const [main, auth, account] = await Promise.all([
    source('../assets/js/main.js'), source('../assets/js/auth.js'), source('../account/index.html'),
  ])
  assert.match(main, /if \(!records\.length && !directTarget && !mounts\.length\) \{\s*setAccessResolved\(runId\);\s*return;/)
  assert.match(auth, /import\('\.\/content-access\.js'\)/)
  assert.doesNotMatch(main, /purchasePipelineVersion|versionedPurchaseAssetUrl/)
  assert.match(account, /<script type="module" src="\/assets\/js\/auth\.js"><\/script>/)
})

test('public catalog RPC returns metadata only and filters private inactive hierarchy for non-admins', async () => {
  const sql = await source('../supabase/public-catalog-payload.sql')
  assert.match(sql, /create or replace function public\.greyveil_public_catalog\(\)/)
  assert.equal((sql.match(/\('human-(?:mind|paradox|fiction)', 'Human /g) || []).length, 14)
  assert.match(sql, /phase-2-github-actions-e2e-20260827/)
  assert.match(sql, /security definer/)
  assert.match(sql, /lower\(coalesce\(book\.visibility, 'paid'\)\) <> 'private'/)
  assert.match(sql, /coalesce\(book\.is_active, true\)/)
  assert.match(sql, /grant execute on function public\.greyveil_public_catalog\(\) to anon, authenticated/)
  assert.doesNotMatch(sql, /book_files|book_covers|storage\.objects|storage_path/)
})
