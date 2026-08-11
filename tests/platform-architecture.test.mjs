import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const importSource = async (path, { mocks = '', before = '' } = {}) => {
  let source = await readFile(new URL(path, import.meta.url), 'utf8')
  source = source.replace(/^import .*$/gm, '')
  if (before) source = source.split(before)[0]
  const url = `data:text/javascript;base64,${Buffer.from(`${mocks}\n${source}`).toString('base64')}`
  return import(url)
}

test('entitlement snapshot shares one access fetch across page consumers', async () => {
  globalThis.__greyveilQueryCounts = {}
  const mocks = `
    const queryData = {
      collections: [], volumes: [], series: [], books: [], book_access: [], orders: []
    };
    const supabase = { from(table) {
      globalThis.__greyveilQueryCounts[table] = (globalThis.__greyveilQueryCounts[table] || 0) + 1;
      const builder = {
        select() { return builder; }, order() { return builder; }, eq() { return builder; },
        then(resolve) { return Promise.resolve({ data: queryData[table] || [], error: null }).then(resolve); }
      };
      return builder;
    }};
    const getCurrentUser = async () => ({ id: '40000000-0000-4000-8000-000000000001' });
    const getCurrentProfile = async () => ({ role: 'customer', display_name: 'Reader' });
  `
  const access = await importSource('../assets/js/content-access.js', { mocks })
  const snapshots = await Promise.all([
    access.getEntitlementSnapshot(),
    access.getEntitlementSnapshot(),
    access.getEntitlementSnapshot(),
  ])
  assert.equal(snapshots[0], snapshots[1])
  assert.equal(snapshots[1], snapshots[2])
  for (const table of ['collections', 'volumes', 'series', 'books', 'book_access', 'orders']) {
    assert.equal(globalThis.__greyveilQueryCounts[table], 1, `${table} should load once`)
  }

  await access.getEntitlementSnapshot()
  assert.equal(globalThis.__greyveilQueryCounts.orders, 1)
  access.invalidateEntitlementSnapshot('test-refresh')
  await access.getEntitlementSnapshot()
  assert.equal(globalThis.__greyveilQueryCounts.orders, 2)
})

test('managed RIZZ pricing remains server-calculated for every product type', async () => {
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-key'
  const api = await import('../api/_lib/greyveil-api.js')
  globalThis.fetch = async (input) => {
    const url = new URL(String(input))
    const path = url.pathname
    let rows = []
    if (path.endsWith('/coupons') && url.searchParams.get('code') === 'eq.RIZZ') rows = [{
      id: '60000000-0000-4000-8000-000000000001',
      code: 'RIZZ',
      active: true,
      discount_type: 'fixed_final_price',
      discount_value: 0,
      fixed_final_price: 100,
      applicable_purchase_types: ['book', 'series', 'collection'],
      applies_to_all_products: true,
    }]
    return new Response(JSON.stringify(rows), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const cases = [
    ['book', 14900],
    ['series', 59900],
    ['series', 49900],
    ['collection', 129900],
  ]
  for (const [purchaseType, amount] of cases) {
    const purchase = { purchaseType, targetId: `${purchaseType}-target`, amount, currency: 'INR' }
    const discounted = await api.resolveCouponPricing(purchase, 'rIzZ', 'user-id')
    assert.equal(discounted.originalAmount, amount)
    assert.equal(discounted.amount, 100)
    assert.equal(discounted.discountAmount, amount - 100)
    assert.equal(discounted.couponCode, 'RIZZ')

    const invalid = await api.resolveCouponPricing(purchase, 'NOPE', 'user-id')
    assert.equal(invalid.amount, amount)
    assert.equal(invalid.couponCode, null)
  }
})

test('library grouping preserves Collection to Series to Book hierarchy', async () => {
  const auth = await importSource('../assets/js/auth.js', {
    mocks: 'const supabase = {};',
    before: 'const page = document.body.dataset.authPage',
  })
  const collection = { id: 'collection-1', title: 'Greyveil Collection' }
  const seriesA = { id: 'series-a', title: 'Series A' }
  const seriesB = { id: 'series-b', title: 'Series B' }
  const groups = auth.groupLibraryItems([
    { collection, series: seriesA, book: { id: 1, title: 'Book One', book_number: 1 } },
    { collection, series: seriesA, book: { id: 2, title: 'Book Two', book_number: 2 } },
    { collection, series: seriesB, book: { id: 3, title: 'Book Three', book_number: 1 } },
  ])
  assert.equal(groups.length, 1)
  assert.equal(groups[0].label, 'Greyveil Collection')
  assert.deepEqual(groups[0].series.map((item) => item.label), ['Series A', 'Series B'])
  assert.deepEqual(groups[0].series[0].items.map((item) => item.book.title), ['Book One', 'Book Two'])
})

test('public review route matcher supports Greyveil book URLs', async () => {
  const reviews = await importSource('../assets/js/reviews.js', {
    mocks: 'const supabase = {}; const canReadBook = () => false; const getEntitlementSnapshot = async () => ({}); const hierarchyForBook = () => ({});',
  })
  assert.equal(reviews.bookSlugFromPath('/projects/human-mind/books/the-last-shift.html'), 'the-last-shift')
  assert.equal(reviews.bookSlugFromPath('/projects/human-mind/books/the-last-shift/'), 'the-last-shift')
  assert.equal(reviews.bookSlugFromPath('/projects/human-mind/books/the-last-shift/index.html'), 'the-last-shift')
  assert.equal(reviews.bookSlugFromPath('/projects/human-mind/books/the-last-shift/reader/'), '')
})

test('migration retains purchase validation and trusted platform policies', async () => {
  const sql = await readFile(new URL('../supabase/platform-architecture-upgrade.sql', import.meta.url), 'utf8')
  for (const shape of [
    /purchase_type = 'book'[\s\S]+book_id is not null[\s\S]+series_id is null[\s\S]+collection_id is null/,
    /purchase_type = 'series'[\s\S]+book_id is null[\s\S]+series_id is not null[\s\S]+collection_id is null/,
    /purchase_type = 'collection'[\s\S]+book_id is null[\s\S]+series_id is null[\s\S]+collection_id is not null/,
  ]) assert.match(sql, shape)
  assert.match(sql, /Only a super admin may change roles/)
  assert.match(sql, /The final super admin cannot be removed/)
  assert.match(sql, /pg_advisory_xact_lock/)
  assert.match(sql, /Super admins (?:insert|update|delete) coupons/)
  assert.match(sql, /applies_to_all_products/)
  assert.match(sql, /Valid book access is required to review this book/)
  assert.match(sql, /moderation_status = 'approved'/)
  assert.match(sql, /greyveil_announcement_visible/)
  assert.match(sql, /notify pgrst, 'reload schema'/i)
})
