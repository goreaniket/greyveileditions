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

test('public enhancement shares session and profile reads and leaves static catalog copy visible', async () => {
  const [client, auth, commerce, pass, announcements, main, css] = await Promise.all([
    source('../assets/js/supabase-client.js'), source('../assets/js/auth.js'), source('../assets/js/commerce.js'),
    source('../assets/js/access-pass.js'), source('../assets/js/announcements.js'), source('../assets/js/main.js'), source('../assets/css/style.css'),
  ])
  assert.match(client, /export const getCurrentSessionOnce/)
  assert.match(auth, /getCurrentSessionOnce/)
  assert.match(commerce, /getCurrentSessionOnce/)
  assert.match(pass, /if \(!host\) return/)
  assert.match(announcements, /let announcementsInit = null/)
  assert.match(announcements, /if \(!announcements\.length\) return/)
  assert.doesNotMatch(main, /node\.hidden = true;/)
  assert.doesNotMatch(css, /body:not\(\[data-access-state="resolved"\]\) \.project-card/)
})
