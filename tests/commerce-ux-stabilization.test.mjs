import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const source = (path) => readFile(new URL(path, import.meta.url), 'utf8')

let snapshotHarnessNonce = 0
const importSource = async (path, mocks = '') => {
  let implementation = await source(path)
  implementation = implementation.replace(/^import(?:[\s\S]*?from\s+)?['"][^'"]+['"]\s*;?\s*$/gm, '')
  snapshotHarnessNonce += 1
  const moduleSource = `${mocks}\n${implementation}\n// snapshot-harness-${snapshotHarnessNonce}`
  return import(`data:text/javascript;base64,${Buffer.from(moduleSource).toString('base64')}`)
}

const createSnapshotHarness = async ({ initialUserId = null, blockedOwner = '__none__' } = {}) => {
  let releaseBlocked
  const harness = {
    currentUser: initialUserId ? { id: initialUserId } : null,
    blockedOwner,
    blocked: new Promise((resolve) => { releaseBlocked = resolve }),
    listeners: [],
    counts: {},
  }
  globalThis.__greyveilSnapshotHarness = harness
  const mocks = `
    const harness = globalThis.__greyveilSnapshotHarness;
    const ownerNow = () => harness.currentUser?.id || 'guest';
    const dataFor = (table, requestedUserId) => {
      if (table === 'orders' && requestedUserId) return [{ id: 'order-' + requestedUserId, user_id: requestedUserId, purchase_type: 'book', book_id: '1', status: 'paid' }];
      return [];
    };
    const supabase = {
      auth: { onAuthStateChange(callback) { harness.listeners.push(callback); return { data: { subscription: { unsubscribe() {} } } }; } },
      from(table) {
        const queryOwner = ownerNow();
        let requestedUserId = '';
        const builder = {
          select() { return builder; }, order() { return builder; }, gt() { return builder; },
          eq(column, value) { if (column === 'user_id') requestedUserId = String(value); return builder; },
          then(resolve, reject) {
            const key = queryOwner + ':' + table;
            harness.counts[key] = (harness.counts[key] || 0) + 1;
            const finish = () => ({ data: dataFor(table, requestedUserId), error: null });
            const result = queryOwner === harness.blockedOwner ? harness.blocked.then(finish) : Promise.resolve(finish());
            return result.then(resolve, reject);
          }
        };
        return builder;
      }
    };
    const getCurrentUser = async () => harness.currentUser ? { ...harness.currentUser } : null;
    const getCurrentProfile = async () => ({ role: 'customer', display_name: 'Reader' });
  `
  const access = await importSource('../assets/js/content-access.js', mocks)
  return {
    access,
    harness,
    release: () => releaseBlocked(),
    transition(userId) {
      harness.currentUser = userId ? { id: userId } : null
      const event = userId ? 'SIGNED_IN' : 'SIGNED_OUT'
      const session = userId ? { user: { id: userId } } : null
      harness.listeners.forEach((listener) => listener(event, session))
    },
  }
}

test('auth-owned snapshot replaces pending User A data with User B data', async () => {
  const setup = await createSnapshotHarness({ initialUserId: 'user-a', blockedOwner: 'user-a' })
  const staleRequest = setup.access.getEntitlementSnapshot()
  await Promise.resolve()
  setup.transition('user-b')
  const current = await setup.access.getEntitlementSnapshot()
  setup.release()
  const staleCallerResult = await staleRequest

  assert.equal(current.ownerKey, 'user-b')
  assert.equal(staleCallerResult.ownerKey, 'user-b')
  assert.equal(staleCallerResult, current)
})

test('auth-owned snapshot replaces pending signed-in data after logout', async () => {
  const setup = await createSnapshotHarness({ initialUserId: 'user-a', blockedOwner: 'user-a' })
  const staleRequest = setup.access.getEntitlementSnapshot()
  await Promise.resolve()
  setup.transition(null)
  const guest = await setup.access.getEntitlementSnapshot()
  setup.release()

  assert.equal(guest.ownerKey, 'guest')
  assert.equal((await staleRequest).ownerKey, 'guest')
})

test('auth-owned snapshot replaces pending guest data after login', async () => {
  const setup = await createSnapshotHarness({ blockedOwner: 'guest' })
  const staleRequest = setup.access.getEntitlementSnapshot()
  await Promise.resolve()
  setup.transition('user-a')
  const signedIn = await setup.access.getEntitlementSnapshot()
  setup.release()

  assert.equal(signedIn.ownerKey, 'user-a')
  assert.equal((await staleRequest).ownerKey, 'user-a')
})

test('stale in-flight completion transparently rebinds to the current auth generation', async () => {
  const setup = await createSnapshotHarness({ initialUserId: 'user-a', blockedOwner: 'user-a' })
  const staleRequest = setup.access.getEntitlementSnapshot()
  await Promise.resolve()
  setup.transition('user-b')
  setup.release()
  const rebound = await staleRequest
  const cached = await setup.access.getEntitlementSnapshot()

  assert.equal(rebound.ownerKey, 'user-b')
  assert.equal(rebound, cached)
  assert.equal(setup.harness.counts['user-a:collections'], 1)
  assert.equal(setup.harness.counts['user-b:collections'], 1)
})

test('same-user snapshot requests still dedupe without persistent storage', async () => {
  const setup = await createSnapshotHarness({ initialUserId: 'user-a' })
  const snapshots = await Promise.all([
    setup.access.getEntitlementSnapshot(),
    setup.access.getEntitlementSnapshot(),
    setup.access.getEntitlementSnapshot(),
  ])

  assert.equal(snapshots[0].ownerKey, 'user-a')
  assert.equal(snapshots[0], snapshots[1])
  assert.equal(snapshots[1], snapshots[2])
  assert.equal(setup.harness.counts['user-a:collections'], 1)
  assert.equal(setup.harness.counts['user-a:orders'], 1)
})

test('access-sensitive purchase controls use a shared snapshot and neutral state before final rendering', async () => {
  const [access, purchases, css] = await Promise.all([
    source('../assets/js/content-access.js'),
    source('../assets/js/purchases.js'),
    source('../assets/css/style.css'),
  ])

  assert.match(access, /let entitlementSnapshotPromise = null/)
  assert.match(access, /if \(entitlementSnapshotPromise\) return entitlementSnapshotPromise/)
  assert.match(access, /fetchActiveAccessPasses\(\)/)
  assert.match(access, /fetchViewerPassActivations\(context\.user\.id\)/)
  assert.match(access, /accessPasses: accessPassesResult\.error \? \[\] : accessPassesResult\.data \|\| \[\]/)
  assert.match(access, /passActivations: passActivationsResult\.data \|\| \[\]/)
  assert.match(access, /hasActivePassEntitlement/)
  assert.match(access, /\|\| hasActivePassEntitlement\([\s\S]+\{ collection, volume, series, book \},[\s\S]+accessPasses,[\s\S]+passActivations,[\s\S]+context\.user\.id/)

  assert.match(purchases, /setPurchaseState\(button, 'checking'\)/)
  assert.match(purchases, /button\.textContent = 'Checking access…'/)
  assert.match(purchases, /button\.setAttribute\('aria-busy', 'true'\)/)
  assert.match(css, /body\[data-access-state="resolving"\] \[data-purchase-type\]/)
  assert.match(css, /greyveil-access-shimmer/)
  assert.doesNotMatch(purchases, /PRICE_LABELS/)
})

test('active Pass discovery is scoped, uses database values, and does not duplicate a sales-container option', async () => {
  const [access, purchases, homePass] = await Promise.all([
    source('../assets/js/content-access.js'),
    source('../assets/js/purchases.js'),
    source('../assets/js/access-pass.js'),
  ])

  assert.match(access, /pass\.scope_type === 'library'/)
  assert.match(access, /pass\.scope_type === 'collection' && idsMatch\(pass\.collection_id, collection\?\.id\)/)
  assert.match(purchases, /snapshot\.accessPasses \|\| \[\]/)
  assert.match(purchases, /pass\.scope_type === 'library'/)
  assert.match(purchases, /pass\.scope_type === 'collection' && String\(pass\.collection_id\) === String\(itemHierarchy\.collection\?\.id\)/)
  assert.match(purchases, /\[data-generated-pass-offer\]/)
  assert.match(purchases, /1-Day Access · \$\{duration\} hours · \$\{formatCurrency\(price\)\}/)
  assert.match(homePass, /const pass = snapshot\.accessPasses\?\.\[0\]/)
  assert.match(homePass, /pass\.duration_hours/)
  assert.match(homePass, /formatCurrency\(pass\.price_amount\)/)
})

test('Pass remains valid through both current server checkout implementations with trusted price resolution', async () => {
  const [edgePayment, apiPayment, migration] = await Promise.all([
    source('../supabase/functions/_shared/payment.ts'),
    source('../api/_lib/greyveil-api.js'),
    source('../supabase/temporary-access-pass-production-fix.sql'),
  ])

  for (const implementation of [edgePayment, apiPayment]) {
    assert.match(implementation, /new Set\(\['book', 'series', 'collection', 'pass'\]\)/)
    assert.match(implementation, /temporary_access_pass_id/)
    assert.match(implementation, /purchaseType === 'pass'/)
    assert.match(implementation, /configuredPrice\(pass, 'access pass'\)/)
  }
  assert.match(migration, /new\.purchase_type is distinct from 'pass'/)
  assert.match(migration, /activation_time \+ make_interval\(hours => pass_row\.duration_hours\)/)
})

test('payment copy is provider-neutral while payment implementation identifiers remain intact', async () => {
  const [checkoutHtml, checkoutJs, commerce] = await Promise.all([
    source('../checkout/index.html'),
    source('../assets/js/checkout.js'),
    source('../assets/js/commerce.js'),
  ])

  assert.match(checkoutHtml, /Proceed to Payment/)
  assert.doesNotMatch(checkoutHtml, /Proceed to Razorpay/)
  assert.match(checkoutJs, /Preparing payment…/)
  assert.doesNotMatch(checkoutHtml, /processed securely by Razorpay/i)
  assert.match(commerce, /checkout\.razorpay\.com/)
})

test('floating announcements retain a distinct compact, accessible presentation from hero highlights', async () => {
  const [announcements, css] = await Promise.all([
    source('../assets/js/announcements.js'),
    source('../assets/css/style.css'),
  ])

  assert.match(announcements, /renderHeroHighlight/)
  assert.match(announcements, /renderFloating/)
  assert.match(announcements, /card\.setAttribute\('role', 'region'\)/)
  assert.match(announcements, /closeControl\('floating-announcement__close'\)/)
  assert.match(announcements, /closeControl\('announcement-hero-highlight__close'\)/)
  assert.match(announcements, /icon\.setAttribute\('aria-hidden', 'true'\)/)
  assert.match(announcements, /card\.classList\.add\('is-visible'\)/)
  assert.match(announcements, /card\.classList\.add\('is-dismissing'\)/)
  assert.match(css, /width: min\(420px, calc\(100vw - 40px\)\)/)
  assert.match(css, /padding: 24px 20px 20px 24px/)
  assert.match(css, /font-size: clamp\(1\.36rem, 2\.2vw, 1\.58rem\)/)
  assert.match(css, /\.floating-announcement\.is-visible/)
  assert.match(css, /\.floating-announcement\.is-dismissing/)
  assert.match(css, /width: min\(360px, calc\(100vw - 24px\)\)/)
  assert.match(css, /max-height: min\(44svh, 360px\)/)
  assert.match(css, /\.floating-announcement \.announcement-title \{ max-width: none; font-size: 1\.08rem/)
  assert.match(css, /\.announcement-hero-highlight \{[\s\S]*?padding: 16px 44px 16px 18px/)
})

test('notification panel renders readable configured content without reserved blank space', async () => {
  const [announcements, css] = await Promise.all([
    source('../assets/js/announcements.js'),
    source('../assets/css/style.css'),
  ])

  assert.match(announcements, /if \(announcement\.message\) copy\.append\(create\('span', 'announcement-message', announcement\.message\)\)/)
  assert.match(announcements, /if \(announcement\.cta_label && ctaUrl\)/)
  assert.doesNotMatch(announcements, /Trial Available|One day Free Trial|The Last Shift/i)
  assert.match(announcements, /const list = create\('div', 'notification-center__list'\)/)
  assert.match(announcements, /closeControl\('notification-center__close', 'Close notifications'\)/)
  assert.match(announcements, /button\.setAttribute\('aria-controls', 'greyveil-notification-panel'\)/)
  assert.match(css, /\.notification-item \.announcement-message\s*\{[\s\S]*?color: #59636d/)
  assert.match(css, /\.notification-center__list\s*\{[\s\S]*?overflow-y: auto/)
  assert.match(css, /\.notification-item:last-child \{ border-bottom: 0; \}/)
  assert.match(css, /@media \(max-width: 1040px\)[\s\S]*?\.notification-center__panel\s*\{[\s\S]*?position: static/)
})
