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

const collectionId = '10000000-0000-4000-8000-000000000001'
const volumeId = '20000000-0000-4000-8000-000000000001'
const seriesAId = '30000000-0000-4000-8000-000000000001'
const seriesBId = '30000000-0000-4000-8000-000000000002'
const user = { id: '40000000-0000-4000-8000-000000000001' }
const context = { user, role: 'customer' }

const active = { is_active: true, visibility: 'paid' }
const collection = {
  id: collectionId,
  slug: 'human-paradox-collection',
  title: 'The Human Paradox Collection',
  ...active,
}
const volume = { id: volumeId, collection_id: collectionId, slug: 'volume', title: 'Volume', ...active }
const seriesA = { id: seriesAId, volume_id: volumeId, collection_id: null, slug: 'series-a', title: 'Series A', ...active }
const seriesB = { id: seriesBId, volume_id: volumeId, collection_id: null, slug: 'series-b', title: 'Series B', ...active }
const book = (id, seriesId = seriesAId) => ({
  id,
  series_id: seriesId,
  slug: `book-${id}`,
  title: `Book ${id}`,
  is_public: false,
  ...active,
})
const books = [book(1), book(2), book(3), book(4, seriesBId)]
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
  assert.equal(access.hasEffectivePurchaseEntitlement(collectionTarget, hierarchy, [], context, [oneSeriesOrder]), false)
  assert.equal(access.hasEffectivePurchaseEntitlement(collectionTarget, hierarchy, [], context, twoSeriesOrders), false)
  assert.equal(access.hasEffectivePurchaseEntitlement(collectionTarget, hierarchy, allBookGrants, context, []), false)
  assert.equal(access.hasEffectivePurchaseEntitlement(collectionTarget, hierarchy, [], context, [collectionOrder]), true)

  assert.equal(access.hasEffectivePurchaseEntitlement(seriesTarget, hierarchy, allBookGrants, context, []), false)
  assert.equal(access.hasEffectivePurchaseEntitlement(seriesTarget, hierarchy, [], context, [oneSeriesOrder]), true)
  assert.equal(access.hasEffectivePurchaseEntitlement(seriesTarget, hierarchy, [], context, [collectionOrder]), true)
  assert.equal(access.hasEffectivePurchaseEntitlement(collectionTarget, hierarchy, [], { user, role: 'admin' }, []), true)
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
  let razorpayCalled = false

  globalThis.fetch = async (input) => {
    const url = new URL(String(input))
    if (url.hostname === 'api.razorpay.com') razorpayCalled = true

    let rows = []
    if (url.pathname.endsWith('/profiles')) rows = [{ id: user.id, role: profileRole }]
    if (url.pathname.endsWith('/orders')) rows = orders
    if (url.pathname.endsWith('/book_access')) rows = grants
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

  orders = []
  grants = []
  assert.equal((await api.resolveEffectivePurchaseEntitlement(user, bookPurchase)).entitled, false)
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

  await assert.rejects(
    api.createCheckoutOrder(user, { purchase_type: 'collection', collection_id: collectionId }),
    (error) => error?.code === 'already_entitled' && error?.statusCode === 409
  )
  assert.equal(razorpayCalled, false)
})
