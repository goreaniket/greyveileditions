import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const importSource = async (path, { mocks = '', before = '' } = {}) => {
  let source = await readFile(new URL(path, import.meta.url), 'utf8')
  source = source.replace(/^import(?:[\s\S]*?from\s+)?['"][^'"]+['"]\s*;?\s*$/gm, '')
  if (before) source = source.split(before)[0]
  const url = `data:text/javascript;base64,${Buffer.from(`${mocks}\n${source}`).toString('base64')}`
  return import(url)
}

test('entitlement snapshot shares one access fetch across page consumers', async () => {
  globalThis.__greyveilQueryCounts = {}
  const mocks = `
    const queryData = {
      collections: [], volumes: [], series: [], books: [], book_access: [], orders: [],
      temporary_access_passes: [], temporary_access_pass_activations: []
    };
    const supabase = { from(table) {
      globalThis.__greyveilQueryCounts[table] = (globalThis.__greyveilQueryCounts[table] || 0) + 1;
      const builder = {
        select() { return builder; }, order() { return builder; }, eq() { return builder; }, gt() { return builder; },
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
  for (const table of ['collections', 'volumes', 'series', 'books', 'book_access', 'orders', 'temporary_access_passes', 'temporary_access_pass_activations']) {
    assert.equal(globalThis.__greyveilQueryCounts[table], 1, `${table} should load once`)
  }

  await access.getEntitlementSnapshot()
  assert.equal(globalThis.__greyveilQueryCounts.orders, 1)
  assert.equal(globalThis.__greyveilQueryCounts.temporary_access_pass_activations, 1)
  access.invalidateEntitlementSnapshot('test-refresh')
  await access.getEntitlementSnapshot()
  assert.equal(globalThis.__greyveilQueryCounts.orders, 2)
  assert.equal(globalThis.__greyveilQueryCounts.temporary_access_pass_activations, 2)
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

test('checkout links preserve explicit product selection and a safe return path', async () => {
  const commerce = await importSource('../assets/js/commerce.js', {
    mocks: 'const supabase = {};',
  })
  const ids = {
    book: '10000000-0000-4000-8000-000000000001',
    series: '20000000-0000-4000-8000-000000000001',
    collection: '7b5292b0-5487-454a-a171-bfe46e3f6729',
  }
  for (const type of ['book', 'series', 'collection']) {
    const url = commerce.checkoutUrlForPayload({ purchase_type: type, [`${type}_id`]: ids[type] }, '/projects/source/?view=all')
    assert.match(url, /^\/checkout\//)
    const selection = commerce.checkoutSelectionFromSearch(url.slice(url.indexOf('?')))
    assert.equal(selection.purchaseType, type)
    assert.equal(selection.targetId, ids[type])
    assert.equal(selection.returnPath, '/projects/source/?view=all')
  }
  const externalReturn = commerce.checkoutUrlForPayload({ purchase_type: 'collection', collection_id: ids.collection }, '//example.com')
  assert.equal(commerce.checkoutSelectionFromSearch(externalReturn.slice(externalReturn.indexOf('?'))).returnPath, '/')
})

test('dedicated checkout owns coupon preview and delays order creation until final pay', async () => {
  const [html, source, purchases, main, auth, authProfile, styles] = await Promise.all([
    readFile(new URL('../checkout/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../assets/js/checkout.js', import.meta.url), 'utf8'),
    readFile(new URL('../assets/js/purchases.js', import.meta.url), 'utf8'),
    readFile(new URL('../assets/js/main.js', import.meta.url), 'utf8'),
    readFile(new URL('../assets/js/auth.js', import.meta.url), 'utf8'),
    readFile(new URL('../assets/js/auth-profile.js', import.meta.url), 'utf8'),
    readFile(new URL('../assets/css/style.css', import.meta.url), 'utf8'),
  ])
  assert.match(html, /Order Summary/)
  assert.match(html, /Customer/)
  assert.match(html, /Coupon code <span>\(optional\)<\/span>/)
  assert.match(html, /Final Confirmation/)
  assert.match(source, /apiPost\('\/api\/validate-coupon'/)
  assert.match(source, /payButton\.addEventListener\('click'/)
  assert.match(source, /edgeFunctionPost\('create-order'/)
  assert.match(source, /edgeFunctionPost\('verify-payment'/)
  assert.ok(source.indexOf("payButton.addEventListener('click'") < source.indexOf("edgeFunctionPost('create-order'"))
  assert.match(source, /window\.location\.replace\(`\/auth\/login\/\?next=/)
  assert.match(auth, /preserveAuthReturnLinks/)
  assert.doesNotMatch(purchases, /api\/create-order/)
  assert.doesNotMatch(purchases, /getCurrentUser/)
  assert.match(purchases, /checkoutUrlForPayload/)
  assert.equal((purchases.match(/document\.addEventListener\('click', handlePurchaseClick\)/g) || []).length, 1)
  assert.match(main, /versionedPurchaseAssetUrl\("purchases\.js"\)/)
  assert.match(main, /matchingButtons\.slice\(1\)/)
  assert.match(html, /main\.js\?v=20260819-commerce-stabilization/)
  assert.match(html, /checkout\.js\?v=20260819-commerce-stabilization/)
  assert.match(styles, /\.checkout-page \[hidden\][\s\S]+display: none !important/)
  assert.match(main, /Buy Full Series/)
  assert.match(main, /Buy Full Collection/)
  assert.match(auth, /data-account-profile-form/)
  assert.match(auth, /updateOwnDisplayName\(\{ supabase, user: activeUser, displayName \}\)/)
  assert.match(authProfile, /\.from\('profiles'\)[\s\S]+\.update\(\{ display_name/)
})

test('checkout opens Razorpay with trusted Book, Series, and Collection orders', async () => {
  globalThis.__greyveilRazorpayOptions = []
  const checkout = await importSource('../assets/js/checkout.js', {
    before: 'const initCheckout',
    mocks: `
      const supabase = {};
      const apiPost = async () => ({ paid: true });
      const getText = (value, fallback = '') => String(value ?? '').trim() || fallback;
      const loadRazorpayCheckout = async () => class RazorpayMock {
        constructor(options) { this.options = options; globalThis.__greyveilRazorpayOptions.push(options); }
        on() {}
        open() { this.options.modal.ondismiss(); }
      };
      const getEntitlementSnapshot = async () => ({});
      const hierarchyForBook = () => ({});
    `,
  })
  const user = { id: '40000000-0000-4000-8000-000000000001', email: 'reader@example.com' }
  for (const [index, item] of [
    { type: 'book', amount: 14900 },
    { type: 'series', amount: 59900 },
    { type: 'collection', amount: 129900 },
  ].entries()) {
    const result = await checkout.openRazorpay({
      user,
      profile: { display_name: 'Reader' },
      itemName: `Greyveil ${item.type}`,
      order: {
        key_id: 'rzp_test_key', order_id: `order_${item.type}`,
        local_order_id: `local_${index}`, amount: item.amount, currency: 'INR',
      },
    })
    const options = globalThis.__greyveilRazorpayOptions.at(-1)
    assert.deepEqual(result, { dismissed: true })
    assert.equal(options.order_id, `order_${item.type}`)
    assert.equal(options.amount, item.amount)
    assert.equal(options.currency, 'INR')
  }
})

test('admin management renders real coupon and announcement tables with storage uploads', async () => {
  const [html, source, sql] = await Promise.all([
    readFile(new URL('../admin/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../assets/js/admin-platform.js', import.meta.url), 'utf8'),
    readFile(new URL('../supabase/platform-architecture-upgrade.sql', import.meta.url), 'utf8'),
  ])
  assert.match(source, /coupon_usages/)
  assert.match(source, /admin-platform-table/)
  assert.match(source, /ANNOUNCEMENT_IMAGE_BUCKET = 'announcement-images'/)
  assert.match(source, /supabase\.storage\.from\(ANNOUNCEMENT_IMAGE_BUCKET\)\.upload/)
  assert.match(source, /announcementStatus/)
  assert.match(html, /image\/png,image\/jpeg,image\/webp/)
  assert.match(sql, /insert into storage\.buckets/)
  assert.match(sql, /Admins upload announcement images/)
  assert.match(sql, /Users update their own profile/)
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

test('public reader and purchase surfaces do not present an entitlement wait or book checkout', async () => {
  const [reader, main, purchases, api] = await Promise.all([
    readFile(new URL('../assets/js/reader.js', import.meta.url), 'utf8'),
    readFile(new URL('../assets/js/main.js', import.meta.url), 'utf8'),
    readFile(new URL('../assets/js/purchases.js', import.meta.url), 'utf8'),
    readFile(new URL('../api/_lib/greyveil-api.js', import.meta.url), 'utf8'),
  ])
  assert.doesNotMatch(reader, /Checking access\.\.\.|"Checking access"/)
  assert.match(main, /decision\.publicReadable/)
  assert.match(main, /data-purchase-type="book"/)
  assert.match(purchases, /detail\.reason === 'public'/)
  assert.match(api, /public_book_not_purchasable/)
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
