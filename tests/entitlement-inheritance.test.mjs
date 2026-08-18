import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const loadContentAccess = async () => {
  const source = await readFile(new URL('../assets/js/content-access.js', import.meta.url), 'utf8')
  const withoutImports = source.replace(/^import .*$/gm, '')
  const mocks = `
    const supabase = {};
    const getCurrentProfile = async () => null;
    const getCurrentUser = async () => null;
  `
  const url = `data:text/javascript;base64,${Buffer.from(`${mocks}\n${withoutImports}`).toString('base64')}`
  return import(url)
}

const collectionId = '7b5292b0-5487-454a-a171-bfe46e3f6729'
const volumeId = '20000000-0000-4000-8000-000000000001'
const seriesAId = '30000000-0000-4000-8000-000000000001'
const seriesBId = '30000000-0000-4000-8000-000000000002'
const user = { id: '40000000-0000-4000-8000-000000000001' }
const passId = '80000000-0000-4000-8000-000000000001'
const context = { user, role: 'customer' }

const active = { is_active: true, visibility: 'paid' }
const collection = {
  id: collectionId,
  slug: 'human-paradox-collection',
  title: 'The Human Paradox Collection',
  ...active,
  visibility: 'public',
  price_amount: 129900,
}
const volume = { id: volumeId, collection_id: collectionId, slug: 'volume', title: 'Volume', ...active }
const seriesA = { id: seriesAId, volume_id: volumeId, collection_id: null, slug: 'human-mind', title: 'Series A', price_amount: 59900, ...active }
const seriesB = { id: seriesBId, volume_id: volumeId, collection_id: null, slug: 'human-fiction', title: 'Series B', price_amount: 49900, ...active }
const book = (id, seriesId = seriesAId) => ({
  id,
  series_id: seriesId,
  slug: `book-${id}`,
  title: `Book ${id}`,
  is_public: false,
  price_amount: 14900,
  ...active,
})
const books = [book(1), book(2), book(3), book(4, seriesBId)]
const publicBook = {
  ...book(5),
  slug: 'public-book',
  is_public: true,
  visibility: 'paid',
}
const hierarchy = {
  collections: [collection],
  volumes: [volume],
  seriesItems: [seriesA, seriesB],
  books,
}
const paidOrder = (purchaseType, targetId, overrides = {}) => ({
  id: `${purchaseType}-${targetId}`,
  user_id: user.id,
  purchase_type: purchaseType,
  [`${purchaseType}_id`]: targetId,
  status: 'paid',
  ...overrides,
})
const grant = (bookId, overrides = {}) => ({
  user_id: user.id,
  book_id: bookId,
  is_visible: true,
  can_read: true,
  expires_at: null,
  ...overrides,
})

test('paid product orders dynamically inherit future book access', async () => {
  const access = await loadContentAccess()
  const seriesOrder = paidOrder('series', seriesAId)
  const collectionOrder = paidOrder('collection', collectionId)

  for (const currentBook of books.slice(0, 2)) {
    const item = access.hierarchyForBook(currentBook, hierarchy.seriesItems, hierarchy.collections, hierarchy.volumes)
    assert.equal(access.canReadBook({ ...item, paidOrders: [seriesOrder] }, context), true)
  }

  const laterSeriesBook = access.hierarchyForBook(books[2], hierarchy.seriesItems, hierarchy.collections, hierarchy.volumes)
  const laterCollectionBook = access.hierarchyForBook(books[3], hierarchy.seriesItems, hierarchy.collections, hierarchy.volumes)
  assert.equal(access.canReadBook({ ...laterSeriesBook, paidOrders: [seriesOrder] }, context), true)
  assert.equal(access.canReadBook({ ...laterCollectionBook, paidOrders: [collectionOrder] }, context), true)
  assert.equal(access.canReadBook({ ...laterCollectionBook, paidOrders: [seriesOrder] }, context), false)
})

test('active public books are readable without granting parent ownership', async () => {
  const access = await loadContentAccess()
  const publicHierarchy = {
    ...hierarchy,
    books: [publicBook],
  }
  const item = access.hierarchyForBook(publicBook, publicHierarchy.seriesItems, publicHierarchy.collections, publicHierarchy.volumes)
  const guest = { user: null, role: 'guest' }
  const zeroEntitlementUser = { user, role: 'customer' }
  const bookTarget = { purchaseType: 'book', targetId: publicBook.id }
  const seriesTarget = { purchaseType: 'series', targetId: seriesAId }
  const collectionTarget = { purchaseType: 'collection', targetId: collectionId }

  assert.equal(access.visibilityForBook(publicBook), 'public')
  assert.equal(access.canReadBook(item, guest), true)
  assert.equal(access.canReadBook(item, zeroEntitlementUser), true)
  assert.deepEqual(
    access.purchaseEntitlementDetails(bookTarget, publicHierarchy, [], guest, []),
    { entitled: true, reason: 'public' }
  )
  assert.equal(access.hasEffectivePurchaseEntitlement(seriesTarget, publicHierarchy, [], zeroEntitlementUser, []), false)
  assert.equal(access.hasEffectivePurchaseEntitlement(collectionTarget, publicHierarchy, [], zeroEntitlementUser, []), false)

  const privateBook = { ...publicBook, is_public: false, visibility: 'private' }
  const privateItem = { ...item, book: privateBook }
  assert.equal(access.visibilityForBook(privateBook), 'private')
  assert.equal(access.canReadBook(privateItem, guest), false)
  assert.equal(access.canReadBook(privateItem, zeroEntitlementUser), false)
})

test('purchase CTA entitlement follows exact product ownership semantics', async () => {
  const access = await loadContentAccess()
  const collectionTarget = { purchaseType: 'collection', targetId: collectionId }
  const seriesTarget = { purchaseType: 'series', targetId: seriesAId }
  const allBookGrants = books.map((item) => grant(item.id))
  const oneSeriesOrder = paidOrder('series', seriesAId)
  const twoSeriesOrders = [oneSeriesOrder, paidOrder('series', seriesBId)]
  const collectionOrder = paidOrder('collection', collectionId)

  assert.equal(access.hasEffectivePurchaseEntitlement(collectionTarget, hierarchy, [], context, []), false)
  assert.equal(access.hasEffectivePurchaseEntitlement(collectionTarget, hierarchy, [grant(1)], context, []), false)
  assert.equal(access.hasEffectivePurchaseEntitlement(collectionTarget, hierarchy, [grant(1), grant(2)], context, []), false)
  assert.equal(access.hasEffectivePurchaseEntitlement(collectionTarget, hierarchy, [], context, [oneSeriesOrder]), false)
  assert.equal(access.hasEffectivePurchaseEntitlement(collectionTarget, hierarchy, [], context, twoSeriesOrders), false)
  assert.equal(access.hasEffectivePurchaseEntitlement(collectionTarget, hierarchy, allBookGrants, context, []), false)
  assert.equal(access.hasEffectivePurchaseEntitlement(collectionTarget, hierarchy, [], context, [collectionOrder]), true)

  assert.equal(access.hasEffectivePurchaseEntitlement(seriesTarget, hierarchy, allBookGrants, context, []), true)
  assert.equal(access.hasEffectivePurchaseEntitlement(seriesTarget, hierarchy, [], context, [oneSeriesOrder]), true)
  assert.equal(access.hasEffectivePurchaseEntitlement(seriesTarget, hierarchy, [], context, [collectionOrder]), true)
  assert.equal(access.hasEffectivePurchaseEntitlement(collectionTarget, hierarchy, [], { user, role: 'admin' }, []), true)
})

test('site collection CTA uses the canonical live Human Paradox slug', async () => {
  const html = await readFile(new URL('../projects/index.html', import.meta.url), 'utf8')
  assert.match(html, /data-purchase-type="collection"[^>]+data-purchase-slug="human-paradox-collection"/)
  assert.match(html, new RegExp(`data-purchase-collection-id="${collectionId}"`))
  assert.doesNotMatch(html, /data-purchase-slug="the-human-paradox-collection"/)
})

test('book access preserves direct-grant expiry and inherits trusted paid orders', async () => {
  const access = await loadContentAccess()
  const item = access.hierarchyForBook(books[2], hierarchy.seriesItems, hierarchy.collections, hierarchy.volumes)
  const expired = grant(books[2].id, { expires_at: '2020-01-01T00:00:00.000Z' })
  const pending = paidOrder('series', seriesAId, { status: 'pending' })

  assert.equal(access.canReadBook({ ...item, grants: [grant(books[2].id)] }, context), true)
  assert.equal(access.canReadBook({ ...item, grants: [expired] }, context), false)
  assert.equal(access.canReadBook({ ...item, paidOrders: [pending] }, context), false)
  assert.equal(access.canReadBook({ ...item, paidOrders: [paidOrder('series', seriesAId)] }, context), true)
  assert.equal(access.canReadBook({
    ...item,
    paidOrders: [paidOrder('series', seriesAId, { purchase_type: null })],
  }, context), true)
  assert.equal(access.canReadBook({ ...item, paidOrders: [paidOrder('collection', collectionId)] }, context), true)
})

test('server resolver recognizes historical paid scope and rejects direct API duplicates', async () => {
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-key'
  process.env.RAZORPAY_KEY_ID = 'test-key-id'
  process.env.RAZORPAY_KEY_SECRET = 'test-key-secret'

  const api = await import('../api/_lib/greyveil-api.js')
  let orders = []
  let grants = []
  let profileRole = 'customer'
  let razorpayCallCount = 0
  const razorpayRequests = []
  const localOrderPayloads = []
  let passActivations = []
  const accessPass = {
    id: passId,
    slug: 'collection-day-pass',
    title: 'Collection 1-Day Pass',
    active: true,
    price_amount: 9900,
    duration_hours: 24,
    scope_type: 'collection',
    collection_id: collectionId,
  }

  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(String(input))
    if (url.hostname === 'api.razorpay.com') {
      razorpayCallCount += 1
      const request = JSON.parse(options.body)
      razorpayRequests.push(request)
      return new Response(JSON.stringify({
        id: `order_test_${razorpayCallCount}`,
        amount: request.amount,
        currency: request.currency,
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    let rows = []
    if (url.pathname.endsWith('/profiles')) rows = [{ id: user.id, role: profileRole }]
    if (url.pathname.endsWith('/orders')) {
      if (options.method === 'POST') {
        const body = JSON.parse(options.body)
        localOrderPayloads.push(body)
        rows = [{ id: '50000000-0000-4000-8000-000000000001', ...body }]
      } else if (options.method === 'PATCH') {
        rows = [{ id: '50000000-0000-4000-8000-000000000001', ...JSON.parse(options.body) }]
      } else {
        rows = orders
      }
    }
    if (url.pathname.endsWith('/book_access')) rows = grants
    if (url.pathname.endsWith('/temporary_access_pass_activations')) rows = passActivations
    if (url.pathname.endsWith('/temporary_access_passes')) rows = [accessPass]
    if (url.pathname.endsWith('/coupons') && url.searchParams.get('code') === 'eq.RIZZ') rows = [{
      id: '60000000-0000-4000-8000-000000000001',
      code: 'RIZZ',
      active: true,
      discount_type: 'fixed_final_price',
      discount_value: 0,
      fixed_final_price: 100,
      applicable_purchase_types: ['book', 'series', 'collection'],
      applies_to_all_products: true,
    }]
    if (url.pathname.endsWith('/coupon_product_rules')) rows = []
    if (url.pathname.endsWith('/coupon_usages')) {
      rows = options.method === 'POST' ? [{ id: '70000000-0000-4000-8000-000000000001', ...JSON.parse(options.body) }] : []
    }
    if (url.pathname.endsWith('/books')) rows = [...books, publicBook].filter((item) => {
      const idFilter = url.searchParams.get('id')
      const seriesFilter = url.searchParams.get('series_id')
      if (idFilter) return idFilter === `eq.${item.id}`
      if (seriesFilter) return seriesFilter === `eq.${item.series_id}` && item.id !== publicBook.id
      return true
    })
    if (url.pathname.endsWith('/series')) rows = [seriesA, seriesB].filter((item) => {
      const idFilter = url.searchParams.get('id')
      return !idFilter || idFilter === `eq.${item.id}`
    })
    if (url.pathname.endsWith('/volumes')) rows = [volume]
    if (url.pathname.endsWith('/collections')) rows = [collection]

    return new Response(JSON.stringify(rows), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const seriesPurchase = {
    purchaseType: 'series',
    seriesId: seriesAId,
    collectionId: null,
    hierarchy: { collection, volume, series: seriesA },
  }
  const collectionPurchase = {
    purchaseType: 'collection',
    collectionId,
    hierarchy: { collection },
  }
  const bookPurchase = {
    purchaseType: 'book',
    bookId: books[2].id,
    hierarchy: { collection, volume, series: seriesA, book: books[2] },
  }
  const publicBookPurchase = {
    purchaseType: 'book',
    bookId: publicBook.id,
    hierarchy: { collection, volume, series: seriesA, book: publicBook },
  }

  orders = []
  grants = []
  assert.equal((await api.resolveEffectivePurchaseEntitlement(user, collectionPurchase)).entitled, false)
  grants = [grant(books[0].id)]
  assert.equal((await api.resolveEffectivePurchaseEntitlement(user, collectionPurchase)).entitled, false)
  grants = [grant(books[0].id), grant(books[1].id)]
  assert.equal((await api.resolveEffectivePurchaseEntitlement(user, collectionPurchase)).entitled, false)
  grants = books.map((item) => grant(item.id))
  assert.equal((await api.resolveEffectivePurchaseEntitlement(user, collectionPurchase)).entitled, false)
  orders = [paidOrder('series', seriesAId)]
  assert.equal((await api.resolveEffectivePurchaseEntitlement(user, collectionPurchase)).entitled, false)
  orders = [paidOrder('series', seriesAId), paidOrder('series', seriesBId)]
  assert.equal((await api.resolveEffectivePurchaseEntitlement(user, collectionPurchase)).entitled, false)

  orders = []
  grants = []
  const pricing = await api.previewCheckoutPricing(user, {
    purchase_type: 'collection',
    collection_id: collectionId,
  })
  assert.equal(pricing.original_amount, 129900)
  assert.equal(pricing.final_amount, 129900)

  collection.price_amount = 131900
  const updatedPricing = await api.previewCheckoutPricing(user, {
    purchase_type: 'collection',
    collection_id: collectionId,
  })
  assert.equal(updatedPricing.final_amount, 131900)
  collection.price_amount = 129900

  const checkoutCases = [
    { type: 'book', id: books[2].id, amount: 14900, payload: { purchase_type: 'book', book_id: books[2].id, amount: 1 } },
    { type: 'series', id: seriesAId, amount: 59900, payload: { purchase_type: 'series', series_id: seriesAId } },
    { type: 'series', id: seriesBId, amount: 49900, payload: { purchase_type: 'series', series_id: seriesBId } },
    { type: 'collection', id: collectionId, amount: 129900, payload: { purchase_type: 'collection', collection_id: collectionId } },
  ]
  for (const checkoutCase of checkoutCases) {
    const createdOrder = await api.createCheckoutOrder(user, checkoutCase.payload)
    const localOrder = localOrderPayloads.at(-1)
    const razorpayOrder = razorpayRequests.at(-1)
    assert.equal(createdOrder.amount, checkoutCase.amount)
    assert.equal(createdOrder.currency, 'INR')
    assert.equal(localOrder.purchase_type, checkoutCase.type)
    assert.equal(String(localOrder[`${checkoutCase.type}_id`]), String(checkoutCase.id))
    assert.equal(localOrder.book_id === null ? null : String(localOrder.book_id), checkoutCase.type === 'book' ? String(checkoutCase.id) : null)
    assert.equal(localOrder.series_id === null ? null : String(localOrder.series_id), checkoutCase.type === 'series' ? String(checkoutCase.id) : null)
    assert.equal(localOrder.collection_id === null ? null : String(localOrder.collection_id), checkoutCase.type === 'collection' ? String(checkoutCase.id) : null)
    assert.equal(razorpayOrder.amount, checkoutCase.amount)
    assert.equal(razorpayOrder.currency, 'INR')
  }
  assert.equal(razorpayCallCount, checkoutCases.length)

  const historicalBookAmount = localOrderPayloads[0].amount
  books[2].price_amount = 15900
  const repricedBook = await api.previewCheckoutPricing(user, {
    purchase_type: 'book',
    book_id: books[2].id,
  })
  assert.equal(repricedBook.final_amount, 15900)
  assert.equal(localOrderPayloads[0].amount, historicalBookAmount)
  books[2].price_amount = 14900

  const passOrder = await api.createCheckoutOrder(user, {
    purchase_type: 'pass',
    temporary_access_pass_id: passId,
    amount: 1,
  })
  assert.equal(passOrder.amount, 9900)
  assert.equal(localOrderPayloads.at(-1).temporary_access_pass_id, passId)
  assert.equal(localOrderPayloads.at(-1).book_id, null)
  assert.equal(localOrderPayloads.at(-1).series_id, null)
  assert.equal(localOrderPayloads.at(-1).collection_id, null)
  passActivations = [{ pass_id: passId, expires_at: '2099-01-01T00:00:00.000Z' }]
  await assert.rejects(
    api.createCheckoutOrder(user, { purchase_type: 'pass', temporary_access_pass_id: passId }),
    (error) => error?.code === 'already_entitled' && error?.statusCode === 409
  )
  passActivations = [{ pass_id: passId, expires_at: '2020-01-01T00:00:00.000Z' }]
  assert.equal((await api.previewCheckoutPricing(user, { purchase_type: 'pass', temporary_access_pass_id: passId })).final_amount, 9900)

  const discountedOrder = await api.createCheckoutOrder(user, {
    purchase_type: 'book',
    book_id: books[2].id,
    coupon_code: 'rIzZ',
  })
  assert.equal(discountedOrder.original_amount, 14900)
  assert.equal(discountedOrder.amount, 100)
  assert.equal(discountedOrder.coupon_code, 'RIZZ')
  assert.equal(razorpayRequests.at(-1).amount, 100)

  const invalidCouponOrder = await api.createCheckoutOrder(user, {
    purchase_type: 'series',
    series_id: seriesBId,
    coupon_code: 'NOPE',
  })
  assert.equal(invalidCouponOrder.original_amount, 49900)
  assert.equal(invalidCouponOrder.amount, 49900)
  assert.equal(invalidCouponOrder.coupon_code, null)

  orders = []
  grants = books.slice(0, 3).map((item) => grant(item.id))
  assert.equal((await api.resolveEffectivePurchaseEntitlement(user, seriesPurchase)).entitled, true)
  grants = []
  assert.equal((await api.resolveEffectivePurchaseEntitlement(user, bookPurchase)).entitled, false)
  assert.deepEqual(
    await api.resolveEffectivePurchaseEntitlement(user, publicBookPurchase),
    { entitled: true, reason: 'public' }
  )
  const razorpayCallsBeforePublicBook = razorpayCallCount
  await assert.rejects(
    api.createCheckoutOrder(user, { purchase_type: 'book', book_id: publicBook.id }),
    (error) => error?.code === 'public_book_not_purchasable' && error?.statusCode === 409
  )
  assert.equal(razorpayCallCount, razorpayCallsBeforePublicBook)
  grants = [grant(books[2].id)]
  assert.equal((await api.resolveEffectivePurchaseEntitlement(user, bookPurchase)).entitled, true)
  grants = [grant(books[2].id, { expires_at: '2020-01-01T00:00:00.000Z' })]
  assert.equal((await api.resolveEffectivePurchaseEntitlement(user, bookPurchase)).entitled, false)
  orders = [paidOrder('book', books[2].id)]
  assert.equal((await api.resolveEffectivePurchaseEntitlement(user, bookPurchase)).entitled, true)

  orders = [paidOrder('series', seriesAId, { purchase_type: null })]
  assert.equal((await api.resolveEffectivePurchaseEntitlement(user, seriesPurchase)).entitled, true)
  assert.equal((await api.resolveEffectivePurchaseEntitlement(user, bookPurchase)).entitled, true)
  assert.equal((await api.resolveEffectivePurchaseEntitlement(user, collectionPurchase)).entitled, false)

  orders = [paidOrder('series', seriesAId), paidOrder('series', seriesBId)]
  grants = books.map((item) => grant(item.id))
  assert.equal((await api.resolveEffectivePurchaseEntitlement(user, collectionPurchase)).entitled, false)
  assert.equal((await api.resolveEffectivePurchaseEntitlement(user, seriesPurchase)).entitled, true)

  orders = [paidOrder('collection', collectionId)]
  assert.equal((await api.resolveEffectivePurchaseEntitlement(user, collectionPurchase)).entitled, true)
  assert.equal((await api.resolveEffectivePurchaseEntitlement(user, seriesPurchase)).entitled, true)
  assert.equal((await api.resolveEffectivePurchaseEntitlement(user, bookPurchase)).entitled, true)

  profileRole = 'admin'
  orders = []
  grants = []
  assert.equal((await api.resolveEffectivePurchaseEntitlement(user, collectionPurchase)).entitled, true)
  profileRole = 'super_admin'
  assert.equal((await api.resolveEffectivePurchaseEntitlement(user, collectionPurchase)).entitled, true)
  profileRole = 'customer'
  orders = [paidOrder('collection', collectionId)]
  const razorpayCallsBeforeDuplicate = razorpayCallCount

  await assert.rejects(
    api.createCheckoutOrder(user, { purchase_type: 'collection', collection_id: collectionId }),
    (error) => error?.code === 'already_entitled' && error?.statusCode === 409
  )
  assert.equal(razorpayCallCount, razorpayCallsBeforeDuplicate)
})
