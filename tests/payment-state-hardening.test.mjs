import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const [repair, shared, createOrder, verifyPayment, webhook] = await Promise.all([
  readFile(new URL('../supabase/repair-payment-state-and-duplicate-orders.sql', import.meta.url), 'utf8'),
  readFile(new URL('../supabase/functions/_shared/payment.ts', import.meta.url), 'utf8'),
  readFile(new URL('../supabase/functions/create-order/index.ts', import.meta.url), 'utf8'),
  readFile(new URL('../supabase/functions/verify-payment/index.ts', import.meta.url), 'utf8'),
  readFile(new URL('../supabase/functions/razorpay-webhook/index.ts', import.meta.url), 'utf8'),
])

const sqlFunction = (name) => {
  const start = repair.indexOf(`create or replace function public.${name}(`)
  assert.notEqual(start, -1, `${name} must exist in the targeted repair`)
  const end = repair.indexOf('\n$$;', start)
  assert.notEqual(end, -1, `${name} must have a complete body`)
  return repair.slice(start, end + 4)
}

const orderGuard = sqlFunction('greyveil_enforce_order_status_transition')
const paymentGuard = sqlFunction('greyveil_enforce_payment_status_transition')
const duplicateGuard = sqlFunction('greyveil_prevent_duplicate_payable_order')
const transitionRpc = sqlFunction('greyveil_record_payment_transition')

const nextOrderStatus = (current, requested) => {
  if (requested === 'refunded') return 'refunded'
  if (current === 'refunded') return 'refunded'
  if (current === 'paid') return 'paid'
  if (requested === 'paid') return 'paid'
  if (['failed', 'cancelled'].includes(current)) return current
  if (['failed', 'cancelled'].includes(requested)) return requested
  return 'pending'
}

test('order transitions are monotonic and refund is terminal under delayed or duplicate events', () => {
  const cases = [
    ['pending to paid', 'pending', 'paid', 'paid'],
    ['paid to refunded', 'paid', 'refunded', 'refunded'],
    ['refunded plus delayed captured', 'refunded', 'paid', 'refunded'],
    ['duplicate captured', 'paid', 'paid', 'paid'],
    ['duplicate refund', 'refunded', 'refunded', 'refunded'],
    ['paid plus delayed failure', 'paid', 'failed', 'paid'],
    ['failed plus noncaptured retry', 'failed', 'pending', 'failed'],
    ['failed plus authoritative capture', 'failed', 'paid', 'paid'],
  ]
  for (const [label, current, requested, expected] of cases) {
    assert.equal(nextOrderStatus(current, requested), expected, label)
  }

  assert.match(orderGuard, /old\.status[\s\S]*= 'refunded'[\s\S]*new\.status := 'refunded'/i)
  assert.match(orderGuard, /old\.status[\s\S]*= 'paid'[\s\S]*new\.status not in \('paid', 'refunded'\)/i)
  assert.match(paymentGuard, /old\.status[\s\S]*= 'refunded'[\s\S]*new\.status := 'refunded'/i)
  assert.match(paymentGuard, /old\.status[\s\S]*= 'captured'[\s\S]*new\.status <> 'refunded'/i)
  assert.match(paymentGuard, /old\.status[\s\S]*= 'failed'[\s\S]*new\.status not in \('failed', 'refunded'\)/i)
})

test('payment persistence and order transition share one locked database transaction', () => {
  assert.match(transitionRpc, /from public\.orders[\s\S]*for update/i)
  assert.match(transitionRpc, /from public\.payments[\s\S]*for update/i)
  assert.match(transitionRpc, /insert into public\.payments/i)
  assert.match(transitionRpc, /on conflict \(razorpay_payment_id\)/i)
  assert.match(transitionRpc, /update public\.orders/i)
  assert.match(transitionRpc, /update public\.coupon_usages/i)
  assert.match(transitionRpc, /when requested_status = 'refunded' then 'refunded'/i)
  assert.match(transitionRpc, /when lower\(coalesce\(order_row\.status, 'pending'\)\) = 'refunded' then 'refunded'/i)
  assert.match(transitionRpc, /incoming_payment_status <> 'captured' or incoming_captured is distinct from true/i)
  assert.match(transitionRpc, /lower\(payment_row\.status\) <> 'captured' or payment_row\.captured is distinct from true/i)
  assert.match(transitionRpc, /order_row\.status, 'pending'\)\) <> 'refunded'/i)
  assert.match(transitionRpc, /payment_matches/i)
  assert.match(repair, /revoke all on function public\.greyveil_record_payment_transition[^;]+from public, anon, authenticated, service_role/i)
  assert.match(repair, /grant execute on function public\.greyveil_record_payment_transition[^;]+to service_role/i)
})

test('concurrent checkout creation is serialized per user and exact entitlement', () => {
  assert.match(duplicateGuard, /pg_advisory_xact_lock/i)
  assert.match(duplicateGuard, /existing_order\.user_id = new\.user_id/i)
  assert.match(duplicateGuard, /existing_order\.status, 'pending'/i)
  for (const target of ['book_id', 'series_id', 'collection_id', 'temporary_access_pass_id']) {
    assert.match(duplicateGuard, new RegExp(`existing_order\\.${target} = new\\.${target}`, 'i'))
  }
  assert.match(duplicateGuard, /errcode = '23505'/i)
  assert.match(createOrder, /localError\?\.code === '23505'/)
  assert.match(createOrder, /payable_order_exists/)
})

test('verify and webhook callers use the atomic RPC and retain all payment checks', () => {
  assert.match(shared, /admin\.rpc\('greyveil_record_payment_transition'/)
  assert.match(verifyPayment, /verifyHmac\(requireEnv\('RAZORPAY_KEY_SECRET'/)
  assert.match(verifyPayment, /paymentMatches\(payment, order\)/)
  assert.match(verifyPayment, /paymentCaptured\(payment\)/)
  assert.match(verifyPayment, /\.eq\('user_id', user\.id\)/)
  assert.match(webhook, /RAZORPAY_WEBHOOK_SECRET/)
  assert.match(webhook, /recordPaymentTransition\(admin, order, payment/)
})

test('Book, Series, Collection, and Pass checkout remain server-priced and target-bound', () => {
  for (const type of ['book', 'series', 'collection', 'pass']) {
    assert.match(shared, new RegExp(`['\"]${type}['\"]`))
  }
  assert.match(createOrder, /amount: purchase\.amount/)
  assert.doesNotMatch(createOrder, /amount:\s*body\./)
  assert.match(createOrder, /temporary_access_pass_id: purchase\.temporaryAccessPassId/)
})

test('repair is targeted to payment state and creates no production data changes', () => {
  assert.match(repair, /^begin;/m)
  assert.match(repair, /^commit;/m)
  assert.match(repair, /^notify pgrst, 'reload schema';/m)
  assert.doesNotMatch(repair, /update public\.(?:books|series|collections|book_access|generation_jobs)/i)
  assert.doesNotMatch(repair, /insert into public\.(?:books|series|collections|book_access|generation_jobs)/i)
  assert.doesNotMatch(repair, /create or replace function public\.greyveil_(?:reader|effective_book_access|generation|admin_catalog)/i)
})
