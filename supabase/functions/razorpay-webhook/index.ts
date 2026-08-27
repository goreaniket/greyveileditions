import { errorResponse, handleOptions, json, paymentCaptured, paymentMatches, razorpay, recordPaymentTransition, requireEnv, serviceClient, verifyHmac } from '../_shared/payment.ts'

Deno.serve(async (request) => {
  const preflight = handleOptions(request)
  if (preflight) return preflight
  if (request.method !== 'POST') return json(405, { success: false, error: { code: 'method_not_allowed', message: 'Use POST.' } }, request)
  try {
    const rawBody = await request.text()
    const signature = request.headers.get('x-razorpay-signature') || ''
    if (!await verifyHmac(requireEnv('RAZORPAY_WEBHOOK_SECRET'), rawBody, signature)) return json(400, { success: false, error: { code: 'invalid_webhook_signature', message: 'Webhook signature could not be verified.' } }, request)
    const event = JSON.parse(rawBody)
    const eventName = String(event?.event || '')
    let payment = event?.payload?.payment?.entity || null
    const refund = event?.payload?.refund?.entity || null
    if (!payment && refund?.payment_id) {
      payment = await razorpay(`/payments/${encodeURIComponent(refund.payment_id)}`)
    }
    const razorpayOrder = event?.payload?.order?.entity || null
    const razorpayOrderId = payment?.order_id || razorpayOrder?.id
    const admin = serviceClient()
    const { data: order } = razorpayOrderId ? await admin.from('orders').select('*').eq('razorpay_order_id', razorpayOrderId).maybeSingle() : { data: null }
    const refundEvent = payment?.status === 'refunded' || eventName === 'payment.refunded' || eventName === 'refund.processed'
    if (refundEvent && (payment?.id || refund?.payment_id)) payment = { ...payment, id: payment?.id || refund.payment_id, status: 'refunded' }
    if (payment?.id && !order) await recordPaymentTransition(admin, null, payment, { eventId: String(event?.id || eventName) })
    if (!order) return json(200, { success: true, processed: false, reason: 'local_order_not_found' }, request)
    if (eventName === 'payment.failed') {
      const transition = await recordPaymentTransition(admin, order, payment, { eventId: String(event?.id || eventName), status: 'failed' })
      return json(200, { success: true, processed: true, status: transition.order?.status || order.status }, request)
    }
    if (refundEvent) {
      const transition = await recordPaymentTransition(admin, order, payment, { eventId: String(event?.id || eventName), status: 'refunded', verified: true })
      return json(200, { success: true, processed: true, status: transition.order?.status || 'refunded' }, request)
    }
    if (payment && paymentCaptured(payment) && paymentMatches(payment, order)) {
      const transition = await recordPaymentTransition(admin, order, payment, { eventId: String(event?.id || eventName), status: 'paid', verified: true })
      return json(200, { success: true, processed: true, status: transition.order?.status || order.status }, request)
    }
    if (payment?.id) await recordPaymentTransition(admin, order, payment, { eventId: String(event?.id || eventName) })
    return json(200, { success: true, processed: true, status: order.status || 'pending' }, request)
  } catch (error) { return errorResponse(error, request) }
})
