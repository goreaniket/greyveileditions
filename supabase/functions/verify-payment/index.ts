import { authenticate, errorResponse, handleOptions, HttpError, json, parseBody, paymentCaptured, paymentMatches, razorpay, recordPaymentTransition, requireEnv, serviceClient, verifyHmac } from '../_shared/payment.ts'

Deno.serve(async (request) => {
  const preflight = handleOptions(request)
  if (preflight) return preflight
  if (request.method !== 'POST') return json(405, { success: false, error: { code: 'method_not_allowed', message: 'Use POST.' } }, request)
  try {
    const admin = serviceClient()
    const user = await authenticate(request, admin)
    const body = await parseBody(request)
    const localOrderId = String(body.local_order_id || '').trim()
    const paymentId = String(body.razorpay_payment_id || '').trim()
    const razorpayOrderId = String(body.razorpay_order_id || '').trim()
    const signature = String(body.razorpay_signature || '').trim()
    if (!localOrderId || !paymentId || !razorpayOrderId || !signature) throw new HttpError(400, 'Payment verification details are incomplete.', 'invalid_payment_verification')
    const { data: order } = await admin.from('orders').select('*').eq('id', localOrderId).eq('user_id', user.id).maybeSingle()
    if (!order) throw new HttpError(404, 'Order was not found for this account.', 'order_not_found')
    if (order.status === 'refunded') throw new HttpError(409, 'This order has been refunded.', 'order_refunded')
    if (order.razorpay_order_id !== razorpayOrderId) throw new HttpError(400, 'Payment order did not match the checkout order.', 'order_mismatch')
    if (!await verifyHmac(requireEnv('RAZORPAY_KEY_SECRET'), `${razorpayOrderId}|${paymentId}`, signature)) throw new HttpError(400, 'Payment signature could not be verified.', 'invalid_payment_signature')
    const payment = await razorpay(`/payments/${encodeURIComponent(paymentId)}`)
    if (!paymentMatches(payment, order)) {
      await recordPaymentTransition(admin, order, payment, { signature })
      throw new HttpError(400, 'Payment details did not match the order.', 'payment_mismatch')
    }
    if (!paymentCaptured(payment)) {
      const transition = await recordPaymentTransition(admin, order, payment, { signature, status: payment.status === 'failed' ? 'failed' : 'pending' })
      return json(200, { success: false, paid: false, status: transition.order?.status || payment.status, local_order_id: order.id, payment_id: transition.payment?.razorpay_payment_id || payment.id }, request)
    }
    const transition = await recordPaymentTransition(admin, order, payment, { signature, status: 'paid', verified: true })
    if (transition.order?.status === 'refunded') throw new HttpError(409, 'This order has been refunded.', 'order_refunded')
    return json(200, { success: true, paid: true, status: 'paid', local_order_id: order.id, purchase_type: order.purchase_type, item_name: order.item_name, payment_id: transition.payment?.razorpay_payment_id || payment.id, original_amount: order.original_amount, amount: order.amount, coupon_code: order.coupon_code, discount_amount: order.discount_amount }, request)
  } catch (error) { return errorResponse(error, request) }
})
