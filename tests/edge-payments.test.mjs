import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const source = (path) => readFile(new URL(path, import.meta.url), 'utf8')

test('Edge create-order authenticates, resolves trusted targets, and reads persisted pricing', async () => {
  const [shared, createOrder] = await Promise.all([
    source('../supabase/functions/_shared/payment.ts'),
    source('../supabase/functions/create-order/index.ts'),
  ])

  assert.match(shared, /admin\.auth\.getUser/)
  assert.match(shared, /price_amount/)
  assert.match(shared, /configuredPrice/)
  assert.doesNotMatch(shared, /const BOOK_PRICE/)
  assert.match(shared, /provided\.length !== 1/)
  assert.match(shared, /already_entitled/)
  assert.match(createOrder, /resolvePurchase\(admin, body\)/)
  assert.match(createOrder, /applyCoupon\(admin, resolved, body\.coupon_code, user\.id\)/)
  assert.match(createOrder, /amount: purchase\.amount/)
  assert.doesNotMatch(createOrder, /amount:\s*body\./)
  assert.doesNotMatch(createOrder, /user_id:\s*body\./)
  assert.match(createOrder, /temporary_access_pass_id: purchase\.temporaryAccessPassId/)
})

test('hierarchical commerce migration keeps parent ownership dynamic and temporary passes server-authoritative', async () => {
  const sql = await source('../supabase/hierarchical-commerce-access.sql')
  assert.match(sql, /add column if not exists price_amount integer/)
  assert.match(sql, /greyveil_resolve_book_access/)
  assert.match(sql, /order_row\.series_id = hierarchy\.series_id/)
  assert.match(sql, /order_row\.collection_id = hierarchy\.collection_id/)
  assert.match(sql, /temporary_access_pass_activations/)
  assert.match(sql, /activation_time \+ make_interval\(hours => pass_row\.duration_hours\)/)
  assert.match(sql, /revoke all on function public\.greyveil_resolve_book_access/)
  assert.match(sql, /greyveil_admin_update_catalog_price/)
  assert.match(sql, /greyveil_admin_update_catalog_visibility/)
  const directFulfillment = sql.match(/create or replace function public\.greyveil_grant_paid_order_access\(\)[\s\S]*?\$\$;/)?.[0] || ''
  assert.match(directFulfillment, /new\.purchase_type <> 'book'/)
  assert.doesNotMatch(directFulfillment, /new\.purchase_type = 'series'/)
  assert.doesNotMatch(directFulfillment, /new\.purchase_type = 'collection'/)
})

test('Edge verification checks ownership, signature, Razorpay state, amount, and currency', async () => {
  const [shared, verify] = await Promise.all([
    source('../supabase/functions/_shared/payment.ts'),
    source('../supabase/functions/verify-payment/index.ts'),
  ])

  assert.match(verify, /\.eq\('user_id', user\.id\)/)
  assert.match(verify, /order\.razorpay_order_id !== razorpayOrderId/)
  assert.match(verify, /verifyHmac\(requireEnv\('RAZORPAY_KEY_SECRET'\)/)
  assert.match(verify, /paymentMatches\(payment, order\)/)
  assert.match(verify, /paymentCaptured\(payment\)/)
  assert.match(shared, /Number\(payment\?\.amount\) === Number\(order\?\.amount\)/)
  assert.match(shared, /payment\?\.currency/)
  assert.match(shared, /difference \|=/)
  assert.match(shared, /onConflict: 'razorpay_payment_id'/)
})

test('Edge webhook validates the raw body and reconciles captured, failed, and refunded payments', async () => {
  const webhook = await source('../supabase/functions/razorpay-webhook/index.ts')
  assert.match(webhook, /const rawBody = await request\.text\(\)/)
  assert.match(webhook, /RAZORPAY_WEBHOOK_SECRET/)
  assert.match(webhook, /payment\.failed/)
  assert.match(webhook, /paymentCaptured\(payment\) && paymentMatches\(payment, order\)/)
  assert.match(webhook, /refund\?\.payment_id/)
  assert.match(webhook, /status: 'refunded'/)
})

test('paid-order migration grants eligible book, series, and collection access idempotently', async () => {
  const sql = await source('../supabase/razorpay-standard-checkout.sql')
  assert.match(sql, /greyveil_grant_paid_order_access/)
  assert.match(sql, /new\.purchase_type = 'book' and book\.id = new\.book_id/)
  assert.match(sql, /new\.purchase_type = 'series' and series_item\.id = new\.series_id/)
  assert.match(sql, /new\.purchase_type = 'collection' and collection_item\.id = new\.collection_id/)
  assert.match(sql, /access_type = 'purchase'/)
  assert.match(sql, /is_visible = true/)
  assert.match(sql, /can_read = true/)
  assert.match(sql, /expires_at = null/)
  assert.match(sql, /pg_advisory_xact_lock/)
  assert.match(sql, /not exists[\s\S]+existing_access\.user_id = new\.user_id[\s\S]+existing_access\.book_id = book\.id/)
  assert.match(sql, /coalesce\(book\.is_active, true\)/)
  assert.match(sql, /book\.visibility[\s\S]+<> 'private'/)
})

test('payment customer email is exposed only through an admin-checked database function', async () => {
  const [sql, admin] = await Promise.all([
    source('../supabase/razorpay-standard-checkout.sql'),
    source('../assets/js/admin.js'),
  ])
  assert.match(sql, /if not public\.greyveil_is_admin\(\)/)
  assert.match(sql, /from auth\.users account/)
  assert.match(sql, /grant execute on function public\.greyveil_admin_payment_customers\(\) to authenticated/)
  assert.match(admin, /supabase\.rpc\('greyveil_admin_payment_customers'\)/)
  assert.match(admin, /feedbackDetailField\('Email'/)
})

test('server secrets remain confined to Edge code and config enables an unsigned webhook endpoint only', async () => {
  const [shared, webhook, config, commerce, checkout] = await Promise.all([
    source('../supabase/functions/_shared/payment.ts'),
    source('../supabase/functions/razorpay-webhook/index.ts'),
    source('../supabase/config.toml'),
    source('../assets/js/commerce.js'),
    source('../assets/js/checkout.js'),
  ])
  const edgeSource = `${shared}\n${webhook}`
  for (const secret of ['RAZORPAY_KEY_SECRET', 'RAZORPAY_WEBHOOK_SECRET', 'SUPABASE_SERVICE_ROLE_KEY']) {
    assert.match(edgeSource, new RegExp(secret))
    assert.doesNotMatch(commerce, new RegExp(secret))
    assert.doesNotMatch(checkout, new RegExp(secret))
  }
  assert.match(config, /\[functions\.create-order\][\s\S]+verify_jwt = true/)
  assert.match(config, /\[functions\.verify-payment\][\s\S]+verify_jwt = true/)
  assert.match(config, /\[functions\.razorpay-webhook\][\s\S]+verify_jwt = false/)
})
