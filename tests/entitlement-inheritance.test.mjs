import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const source = (path) => readFile(new URL(path, import.meta.url), 'utf8')

const loadContentAccess = async () => {
  const text = await source('../assets/js/content-access.js')
  const withoutImports = text.replace(/^import .*$/gm, '')
  const mocks = `
    const supabase = {};
    const getCurrentProfile = async () => null;
    const getCurrentUser = async () => null;
  `
  return import(`data:text/javascript;base64,${Buffer.from(`${mocks}\n${withoutImports}`).toString('base64')}`)
}

const collectionId = '7b5292b0-5487-454a-a171-bfe46e3f6729'
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
const publicBook = { ...book(5), slug: 'public-book', is_public: true, visibility: 'paid' }
const hierarchy = { collections: [collection], volumes: [volume], seriesItems: [seriesA, seriesB], books }
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
  const publicHierarchy = { ...hierarchy, books: [publicBook] }
  const item = access.hierarchyForBook(publicBook, publicHierarchy.seriesItems, publicHierarchy.collections, publicHierarchy.volumes)
  const guest = { user: null, role: 'guest' }
  const customer = { user, role: 'customer' }
  assert.equal(access.visibilityForBook(publicBook), 'public')
  assert.equal(access.canReadBook(item, guest), true)
  assert.deepEqual(
    access.purchaseEntitlementDetails({ purchaseType: 'book', targetId: publicBook.id }, publicHierarchy, [], guest, []),
    { entitled: true, reason: 'public' },
  )
  assert.equal(access.hasEffectivePurchaseEntitlement({ purchaseType: 'series', targetId: seriesAId }, publicHierarchy, [], customer, []), false)
  assert.equal(access.hasEffectivePurchaseEntitlement({ purchaseType: 'collection', targetId: collectionId }, publicHierarchy, [], customer, []), false)
  const privateBook = { ...publicBook, is_public: false, visibility: 'private' }
  assert.equal(access.canReadBook({ ...item, book: privateBook }, guest), false)
})

test('purchase CTA entitlement follows exact product ownership semantics', async () => {
  const access = await loadContentAccess()
  const collectionTarget = { purchaseType: 'collection', targetId: collectionId }
  const seriesTarget = { purchaseType: 'series', targetId: seriesAId }
  const allBookGrants = books.map((item) => grant(item.id))
  const seriesOrder = paidOrder('series', seriesAId)
  const collectionOrder = paidOrder('collection', collectionId)
  assert.equal(access.hasEffectivePurchaseEntitlement(collectionTarget, hierarchy, allBookGrants, context, []), false)
  assert.equal(access.hasEffectivePurchaseEntitlement(collectionTarget, hierarchy, [], context, [seriesOrder]), false)
  assert.equal(access.hasEffectivePurchaseEntitlement(collectionTarget, hierarchy, [], context, [collectionOrder]), true)
  assert.equal(access.hasEffectivePurchaseEntitlement(seriesTarget, hierarchy, allBookGrants, context, []), true)
  assert.equal(access.hasEffectivePurchaseEntitlement(seriesTarget, hierarchy, [], context, [collectionOrder]), true)
  assert.equal(access.hasEffectivePurchaseEntitlement(collectionTarget, hierarchy, [], { user, role: 'admin' }, []), true)
})

test('site collection mount and purchase CTA use the canonical database collection', async () => {
  const [html, main] = await Promise.all([
    source('../projects/index.html'),
    source('../assets/js/main.js'),
  ])
  assert.match(html, /data-catalog-collection="human-paradox-collection"/)
  assert.doesNotMatch(html, /data-purchase-collection-id|Buy Complete Collection - Rs\./)
  assert.match(main, /type: "collection", id: collection\.id, slug: collection\.slug/)
  assert.match(main, /priceAmount: collection\.price_amount/)
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
  assert.equal(access.canReadBook({ ...item, paidOrders: [paidOrder('collection', collectionId)] }, context), true)
})

test('canonical Edge backend keeps entitlement checks and all server-priced targets', async () => {
  const [shared, createOrder, validateCoupon] = await Promise.all([
    source('../supabase/functions/_shared/payment.ts'),
    source('../supabase/functions/create-order/index.ts'),
    source('../supabase/functions/validate-coupon/index.ts'),
  ])
  for (const type of ['book', 'series', 'collection', 'pass']) assert.match(shared, new RegExp(`['"]${type}['"]`))
  assert.match(shared, /already_entitled/)
  assert.match(shared, /public_book_not_purchasable/)
  assert.match(shared, /configuredPrice/)
  assert.match(createOrder, /amount: purchase\.amount/)
  assert.doesNotMatch(createOrder, /amount:\s*body\./)
  assert.match(validateCoupon, /applyCoupon\(admin, resolved, body\.coupon_code, user\.id\)/)
})
