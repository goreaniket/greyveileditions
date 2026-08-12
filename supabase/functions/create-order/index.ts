import { applyCoupon, assertNotEntitled, authenticate, errorResponse, handleOptions, HttpError, json, parseBody, razorpay, requireEnv, resolvePurchase, serviceClient } from '../_shared/payment.ts'

Deno.serve(async (request) => {
  const preflight = handleOptions(request)
  if (preflight) return preflight
  if (request.method !== 'POST') return json(405, { success: false, error: { code: 'method_not_allowed', message: 'Use POST.' } })
  try {
    const admin = serviceClient()
    const user = await authenticate(request, admin)
    const body = await parseBody(request)
    const resolved = await resolvePurchase(admin, body)
    await assertNotEntitled(admin, user, resolved)
    const purchase = await applyCoupon(admin, resolved, body.coupon_code, user.id)
    const now = new Date().toISOString()
    const { data: localOrder, error: localError } = await admin.from('orders').insert({
      user_id: user.id, purchase_type: purchase.purchaseType, book_id: purchase.bookId, series_id: purchase.seriesId,
      collection_id: purchase.collectionId, item_name: purchase.itemName, original_amount: purchase.originalAmount,
      amount: purchase.amount, coupon_id: purchase.couponId, coupon_code: purchase.couponCode,
      discount_amount: purchase.discountAmount, currency: purchase.currency, status: 'pending', created_at: now, updated_at: now,
    }).select().single()
    if (localError || !localOrder) throw new HttpError(500, 'The local order could not be created.', 'order_create_failed')
    if (purchase.couponId) {
      const { error } = await admin.from('coupon_usages').insert({ coupon_id: purchase.couponId, order_id: localOrder.id, user_id: user.id, coupon_code: purchase.couponCode, discount_amount: purchase.discountAmount, status: 'pending', created_at: now, updated_at: now })
      if (error) {
        await admin.from('orders').update({ status: 'failed', updated_at: new Date().toISOString() }).eq('id', localOrder.id)
        throw new HttpError(409, 'This coupon is no longer available.', 'coupon_limit_reached')
      }
    }
    try {
      const razorpayOrder = await razorpay('/orders', { method: 'POST', body: JSON.stringify({ amount: purchase.amount, currency: purchase.currency, receipt: `gve_${String(localOrder.id).replace(/-/g, '').slice(0, 32)}`, notes: { local_order_id: localOrder.id, purchase_type: purchase.purchaseType, target_id: purchase.targetId } }) })
      if (!razorpayOrder?.id || Number(razorpayOrder.amount) !== purchase.amount || razorpayOrder.currency !== purchase.currency) throw new HttpError(502, 'Razorpay returned an unexpected order.', 'razorpay_order_mismatch')
      const { error: updateError } = await admin.from('orders').update({ razorpay_order_id: razorpayOrder.id, updated_at: new Date().toISOString() }).eq('id', localOrder.id)
      if (updateError) throw new HttpError(500, 'The Razorpay order could not be linked.', 'order_update_failed')
      return json(200, { success: true, order: { order_id: razorpayOrder.id, local_order_id: localOrder.id, key_id: requireEnv('RAZORPAY_KEY_ID'), amount: purchase.amount, original_amount: purchase.originalAmount, coupon_code: purchase.couponCode, discount_amount: purchase.discountAmount, currency: purchase.currency } })
    } catch (error) {
      await admin.from('orders').update({ status: 'failed', updated_at: new Date().toISOString() }).eq('id', localOrder.id)
      if (purchase.couponId) await admin.from('coupon_usages').update({ status: 'void', updated_at: new Date().toISOString() }).eq('order_id', localOrder.id)
      throw error
    }
  } catch (error) { return errorResponse(error) }
})
