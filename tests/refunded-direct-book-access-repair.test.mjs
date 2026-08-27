import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const repair = await readFile(
  new URL('../supabase/repair-refunded-direct-book-access.sql', import.meta.url),
  'utf8',
)
const [checkout, hierarchy, passReaderRepair, callerBindingRepair, webhook, api, readerEdge] = await Promise.all([
  readFile(new URL('../supabase/razorpay-standard-checkout.sql', import.meta.url), 'utf8'),
  readFile(new URL('../supabase/hierarchical-commerce-access.sql', import.meta.url), 'utf8'),
  readFile(new URL('../supabase/repair-refunded-pass-reader-access.sql', import.meta.url), 'utf8'),
  readFile(new URL('../supabase/repair-caller-binding-probes.sql', import.meta.url), 'utf8'),
  readFile(new URL('../supabase/functions/razorpay-webhook/index.ts', import.meta.url), 'utf8'),
  readFile(new URL('../api/_lib/greyveil-api.js', import.meta.url), 'utf8'),
  readFile(new URL('../supabase/functions/reader-content/index.ts', import.meta.url), 'utf8'),
])

const functionDefinition = (name) => {
  const start = repair.indexOf(`create or replace function public.${name}(`)
  assert.notEqual(start, -1, `${name} must be replaced by the targeted repair`)
  const standardEnd = repair.indexOf('\n$$;', start)
  const dynamicEnd = repair.indexOf('\n      $body$;', start)
  const candidates = [standardEnd, dynamicEnd].filter((position) => position !== -1)
  assert.ok(candidates.length, `${name} must have a complete body`)
  return repair.slice(start, Math.min(...candidates) + 15)
}

const grantValidator = functionDefinition('greyveil_valid_book_access_grant')
const effective = functionDefinition('greyveil_effective_book_access_internal')
const reader = functionDefinition('greyveil_reader_content_authorization')
const resolver = functionDefinition('greyveil_resolve_book_access')

test('canonical producer, refund, and database-consumer paths are explicitly audited', () => {
  assert.match(checkout, /create trigger greyveil_paid_order_access[\s\S]+execute function public\.greyveil_grant_paid_order_access\(\)/i)
  assert.match(checkout, /new\.status <> 'paid'[\s\S]+access_type[\s\S]+'purchase'/i)
  assert.match(hierarchy, /create or replace function public\.greyveil_resolve_book_access/i)
  assert.match(hierarchy, /from public\.book_access access_row/i)
  assert.match(passReaderRepair, /create or replace function public\.greyveil_reader_content_authorization/i)
  assert.match(passReaderRepair, /from public\.book_access access/i)
  assert.match(callerBindingRepair, /create or replace function public\.greyveil_effective_book_access_internal/i)
  assert.match(callerBindingRepair, /from public\.book_access access/i)
  assert.match(webhook, /recordPaymentTransition\(admin, order, payment, \{[^}]*status: 'refunded'/)
  assert.match(api, /recordPaymentTransition\(order, payment, \{[^}]*status: 'refunded'/)
  assert.match(readerEdge, /\.rpc\('greyveil_reader_content_authorization'/)
})

test('purchase-sourced book_access requires a currently paid direct-Book order', () => {
  assert.match(grantValidator, /from public\.book_access access/i)
  assert.match(grantValidator, /access\.is_visible = true/i)
  assert.match(grantValidator, /access\.can_read = true/i)
  assert.match(grantValidator, /access\.expires_at is null or access\.expires_at > now\(\)/i)
  assert.match(grantValidator, /lower\(access\.access_type\) is distinct from 'purchase'/i)
  assert.match(grantValidator, /from public\.orders source_order/i)
  assert.match(grantValidator, /source_order\.status = 'paid'/i)
  assert.match(grantValidator, /\) = 'book'/i)
  assert.match(grantValidator, /source_order\.book_id = access\.book_id/i)
  assert.doesNotMatch(grantValidator, /status\s+(?:<>|!=)\s+'refunded'/i)
})

test('effective access preserves public, Admin, direct, Series, and Collection paths', () => {
  assert.match(effective, /profile\.role in \('admin', 'super_admin'\)/i)
  assert.match(effective, /hierarchy\.book_visibility = 'public'/i)
  assert.match(effective, /public\.greyveil_valid_book_access_grant\(\s*target_user_id,\s*target_book_id\s*\)/i)
  assert.match(effective, /paid_order\.status = 'paid'/i)
  assert.match(effective, /paid_order\.purchase_type = 'book'/i)
  assert.match(effective, /paid_order\.purchase_type = 'series'/i)
  assert.match(effective, /paid_order\.purchase_type = 'collection'/i)
})

test('Reader uses the validated grant while retaining paid parent and paid-source Pass access', () => {
  assert.match(reader, /viewer_role in \('admin', 'super_admin'\)/i)
  assert.match(reader, /effective_visibility = 'public'/i)
  assert.match(reader, /public\.greyveil_valid_book_access_grant\(\s*target_user_id,\s*hierarchy\.resolved_book_id\s*\)/i)
  assert.match(reader, /paid_order\.status = 'paid'/i)
  assert.match(reader, /paid_order\.purchase_type = 'series'/i)
  assert.match(reader, /paid_order\.purchase_type = 'collection'/i)
  assert.match(reader, /from public\.temporary_access_pass_activations activation/i)
  assert.match(reader, /join public\.orders activation_order on activation_order\.id = activation\.order_id/i)
  assert.match(reader, /activation_order\.status = 'paid'/i)
  assert.match(reader, /activation_order\.purchase_type = 'pass'/i)
})

test('later hierarchical resolver is patched only when installed and keeps all non-Book paths', () => {
  assert.match(repair, /if to_regprocedure\('public\.greyveil_resolve_book_access\(uuid,bigint\)'\) is not null then/i)
  assert.match(resolver, /public\.greyveil_valid_book_access_grant\(target_user_id, hierarchy\.book_id\)/i)
  assert.match(resolver, /access_state := 'DIRECTLY_OWNED'/i)
  assert.match(resolver, /access_state := 'SERIES_OWNED'/i)
  assert.match(resolver, /access_state := 'COLLECTION_OWNED'/i)
  assert.match(resolver, /from public\.catalog_access_grants grant_row/i)
  assert.match(resolver, /from public\.temporary_access_pass_activations activation/i)
  assert.match(resolver, /access_state := 'TEMPORARY_PASS'/i)
  assert.match(resolver, /access_state := 'ADMIN_ACCESS'/i)
  assert.match(resolver, /access_state := 'PUBLIC'/i)
})

test('entitlement matrix denies only refunded purchase rows', () => {
  const validBookAccess = ({ accessType, orderStatus }) => (
    accessType !== 'purchase' || orderStatus === 'paid'
  )
  const allowed = ({ publicBook = false, admin = false, accessType = null, directOrder = null, parentOrder = null, pass = false }) => (
    publicBook
    || admin
    || (accessType != null && validBookAccess({ accessType, orderStatus: directOrder }))
    || directOrder === 'paid'
    || parentOrder === 'paid'
    || pass
  )

  const cases = [
    { name: 'paid direct Book', input: { accessType: 'purchase', directOrder: 'paid' }, expected: true },
    { name: 'refunded direct Book', input: { accessType: 'purchase', directOrder: 'refunded' }, expected: false },
    { name: 'manual grant', input: { accessType: 'manual' }, expected: true },
    { name: 'Series entitlement', input: { parentOrder: 'paid' }, expected: true },
    { name: 'Collection entitlement', input: { parentOrder: 'paid' }, expected: true },
    { name: 'active Pass', input: { pass: true }, expected: true },
    { name: 'public Book', input: { publicBook: true }, expected: true },
    { name: 'Admin', input: { admin: true }, expected: true },
  ]

  for (const scenario of cases) {
    assert.equal(allowed(scenario.input), scenario.expected, scenario.name)
  }
})

test('new internal helper and repaired resolvers retain least-privilege ACLs', () => {
  for (const signature of [
    'greyveil_valid_book_access_grant(uuid, bigint)',
    'greyveil_effective_book_access_internal(uuid, bigint)',
    'greyveil_reader_content_authorization(uuid, text)',
  ]) {
    const escaped = signature.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    assert.match(repair, new RegExp(`revoke all on function public\\.${escaped}\\s+from public, anon, authenticated, service_role;`, 'i'))
    assert.match(repair, new RegExp(`grant execute on function public\\.${escaped}\\s+to service_role;`, 'i'))
  }
  assert.match(repair, /revoke all on function public\.greyveil_resolve_book_access\(uuid, bigint\) from public, anon, authenticated, service_role/i)
  assert.match(repair, /grant execute on function public\.greyveil_resolve_book_access\(uuid, bigint\) to service_role/i)
})

test('repair does not change payment transitions, grant creation, or unrelated code paths', () => {
  assert.doesNotMatch(repair, /create or replace function public\.greyveil_grant_paid_order_access/i)
  assert.doesNotMatch(repair, /create (?:constraint )?trigger/i)
  assert.doesNotMatch(repair, /update public\.(?:orders|payments|book_access)/i)
  assert.doesNotMatch(repair, /insert into public\.(?:orders|payments|book_access)/i)
  assert.doesNotMatch(repair, /coupon|razorpay|generation/i)
  assert.match(repair, /^begin;/m)
  assert.match(repair, /^commit;/m)
  assert.match(repair, /^notify pgrst, 'reload schema';/m)
})
