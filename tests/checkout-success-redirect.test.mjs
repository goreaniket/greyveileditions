import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const source = (path) => readFile(new URL(path, import.meta.url), 'utf8')

const loadCheckoutHelpers = async () => {
  let text = await source('../assets/js/checkout.js')
  text = text.replace(/^import(?:[\s\S]*?from\s+)?['"][^'"]+['"]\s*;?\s*$/gm, '')
  text = text.split('const initCheckout')[0]
  const mocks = `
    const getText = (value, fallback = '') => String(value ?? '').trim() || fallback;
    const hierarchyForBook = (book, seriesItems = [], collections = [], volumes = []) => {
      const series = seriesItems.find((item) => String(item.id) === String(book?.series_id)) || null;
      const volume = volumes.find((item) => String(item.id) === String(series?.volume_id)) || null;
      const collectionId = series?.collection_id || volume?.collection_id;
      const collection = collections.find((item) => String(item.id) === String(collectionId)) || null;
      return { book, series, volume, collection };
    };
    const canReadBook = ({ book, collection, grants = [], paidOrders = [], accessPasses = [], passActivations = [] }, context = {}) => {
      if (!book || !context.user?.id) return false;
      if (grants.some((item) => String(item.book_id) === String(book.id))) return true;
      if (paidOrders.some((item) => item.status === 'paid' && (
        String(item.book_id) === String(book.id)
        || String(item.series_id) === String(book.series_id)
        || String(item.collection_id) === String(collection?.id)
      ))) return true;
      return accessPasses.some((pass) => pass.active !== false
        && String(pass.collection_id) === String(collection?.id)
        && passActivations.some((activation) => String(activation.pass_id) === String(pass.id)
          && String(activation.user_id) === String(context.user.id)
          && Date.parse(activation.expires_at) > Date.now()));
    };
  `
  return import(`data:text/javascript;base64,${Buffer.from(`${mocks}\n${text}`).toString('base64')}`)
}

const collection = { id: 'collection-1', slug: 'human-paradox', is_active: true }
const volume = { id: 'volume-1', collection_id: collection.id, is_active: true }
const series = { id: 'series-1', slug: 'human-mind', volume_id: volume.id, collection_id: collection.id, is_active: true }
const book = { id: 1, slug: 'the-last-shift', series_id: series.id, is_active: true, visibility: 'paid' }
const user = { id: 'customer-1' }

const snapshot = (overrides = {}) => ({
  context: { user, role: 'customer' },
  hierarchy: { collections: [collection], volumes: [volume], seriesItems: [series], books: [book] },
  grants: [],
  paidOrders: [],
  accessPasses: [],
  passActivations: [],
  ...overrides,
})

test('verified Book payment resolves directly to the purchased Reader', async () => {
  const checkout = await loadCheckoutHelpers()
  const destination = checkout.resolveCheckoutSuccessDestination({
    selection: { purchaseType: 'book', targetId: book.id, returnPath: '/projects/' },
    snapshot: snapshot({ paidOrders: [{ status: 'paid', book_id: book.id }] }),
  })
  assert.equal(destination, '/projects/human-mind/books/the-last-shift/reader/')
})

test('verified Pass payment returns to a covered Book Reader', async () => {
  const checkout = await loadCheckoutHelpers()
  const pass = { id: 'pass-1', active: true, scope_type: 'collection', collection_id: collection.id }
  const destination = checkout.resolveCheckoutSuccessDestination({
    selection: {
      purchaseType: 'pass',
      targetId: pass.id,
      returnPath: '/projects/human-mind/books/the-last-shift.html?from=pass',
    },
    snapshot: snapshot({
      accessPasses: [pass],
      passActivations: [{ pass_id: pass.id, user_id: user.id, expires_at: '2099-01-01T00:00:00Z' }],
    }),
  })
  assert.equal(destination, '/projects/human-mind/books/the-last-shift/reader/')
})

test('Series and Collection preserve useful Greyveil destinations and otherwise fall back to Account', async () => {
  const checkout = await loadCheckoutHelpers()
  assert.equal(checkout.resolveCheckoutSuccessDestination({
    selection: { purchaseType: 'series', targetId: series.id, returnPath: '/projects/human-mind/' },
    snapshot: snapshot(),
  }), '/projects/human-mind/')
  assert.equal(checkout.resolveCheckoutSuccessDestination({
    selection: { purchaseType: 'collection', targetId: collection.id, returnPath: '/projects/human-paradox/' },
    snapshot: snapshot(),
  }), '/projects/human-paradox/')
  assert.equal(checkout.resolveCheckoutSuccessDestination({
    selection: { purchaseType: 'pass', targetId: 'pass-1', returnPath: '/projects/' },
    snapshot: snapshot(),
  }), '/account/')
})

test('unsafe external and protocol-like return targets are rejected', async () => {
  const checkout = await loadCheckoutHelpers()
  for (const returnPath of [
    'https://attacker.example/path',
    '//attacker.example/path',
    '/\\attacker.example/path',
    'javascript:alert(1)',
    'data:text/html,unsafe',
  ]) {
    assert.equal(checkout.safeCheckoutReturnPath(returnPath), '')
    assert.equal(checkout.resolveCheckoutSuccessDestination({
      selection: { purchaseType: 'pass', targetId: 'pass-1', returnPath },
      snapshot: snapshot(),
    }), '/account/')
  }
})

test('an unreadable preserved Reader target falls back safely', async () => {
  const checkout = await loadCheckoutHelpers()
  assert.equal(checkout.resolveCheckoutSuccessDestination({
    selection: {
      purchaseType: 'pass',
      targetId: 'wrong-pass',
      returnPath: '/projects/human-mind/books/the-last-shift/reader/',
    },
    snapshot: snapshot(),
  }), '/account/')
})

test('only a server-verified paid result is redirectable', async () => {
  const checkout = await loadCheckoutHelpers()
  assert.deepEqual(checkout.checkoutResultState({ paid: true }), { state: 'success', redirect: true })
  assert.deepEqual(checkout.checkoutResultState({ failed: true }), { state: 'payment_failed', redirect: false })
  assert.deepEqual(checkout.checkoutResultState({ dismissed: true }), { state: 'closed', redirect: false })
  assert.deepEqual(checkout.checkoutResultState(null), { state: 'failure', redirect: false })
})

test('successful checkout schedules automatic navigation to the resolved destination', async () => {
  const checkout = await loadCheckoutHelpers()
  let assigned = ''
  let delay = 0
  checkout.scheduleCheckoutRedirect({
    destination: '/projects/human-mind/books/the-last-shift/reader/',
    location: { assign: (value) => { assigned = value } },
    schedule: (callback, milliseconds) => {
      delay = milliseconds
      callback()
      return 1
    },
  })
  assert.equal(assigned, '/projects/human-mind/books/the-last-shift/reader/')
  assert.equal(delay, 500)
})

test('checkout copy and state transitions stay simple and refresh access before redirect', async () => {
  const [html, checkout] = await Promise.all([
    source('../checkout/index.html'),
    source('../assets/js/checkout.js'),
  ])
  assert.match(html, /Proceed to Payment/)
  assert.doesNotMatch(html, /Proceed to Razorpay|processed securely by Razorpay|payment gateway|verification/i)
  assert.doesNotMatch(checkout, /Checking server|server-owned price|Verifying HMAC|Checking Razorpay|Validating order/)
  assert.match(checkout, /Preparing payment…/)
  assert.match(checkout, /Confirming payment…/)
  assert.equal((checkout.match(/Confirming payment…/g) || []).length, 1)
  assert.match(checkout, /handler: async \(response\) => \{[\s\S]+onVerifying\(\)[\s\S]+edgeFunctionPost\('verify-payment'/)
  assert.match(checkout, /if \(paymentInFlight\) return[\s\S]+paymentInFlight = true/)
  assert.match(checkout, /getEntitlementSnapshot\(\{ force: true \}\)[\s\S]+resolveCheckoutSuccessDestination[\s\S]+scheduleCheckoutRedirect/)
  assert.match(checkout, /querySelectorAll\('\[data-checkout-return\]'\)[\s\S]+link\.hidden = true/)
  assert.match(html, /data-checkout-continue hidden/)
})
