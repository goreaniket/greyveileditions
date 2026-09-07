import {
  applyCoupon,
  assertNotEntitled,
  authenticate,
  errorResponse,
  handleOptions,
  json,
  parseBody,
  resolvePurchase,
  serviceClient,
} from '../_shared/payment.ts'

Deno.serve(async (request) => {
  const preflight = handleOptions(request)
  if (preflight) return preflight
  if (request.method !== 'POST') {
    return json(405, { success: false, error: { code: 'method_not_allowed', message: 'Use POST.' } }, request)
  }

  try {
    const admin = serviceClient()
    const user = await authenticate(request, admin)
    const body = await parseBody(request)
    const resolved = await resolvePurchase(admin, body)
    await assertNotEntitled(admin, user, resolved)
    const purchase = await applyCoupon(admin, resolved, body.coupon_code, user.id)

    return json(200, {
      success: true,
      pricing: {
        valid: Boolean(purchase.couponCode),
        coupon_code: purchase.couponCode,
        item_name: purchase.itemName,
        original_amount: purchase.originalAmount,
        final_amount: purchase.amount,
        discount_amount: purchase.discountAmount,
        currency: purchase.currency,
      },
    }, request)
  } catch (error) {
    return errorResponse(error, request)
  }
})
