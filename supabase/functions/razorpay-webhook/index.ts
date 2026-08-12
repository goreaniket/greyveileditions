import { errorResponse, handleOptions, json, markOrder, paymentCaptured, paymentMatches, persistPayment, razorpay, requireEnv, serviceClient, verifyHmac } from '../_shared/payment.ts'

Deno.serve(async (request) => {
  const preflight = handleOptions(request)
  if (preflight) return preflight
  if (request.method !== 'POST') return json(405, { success: false, error: { code: 'method_not_allowed', message: 'Use POST.' } })
  try {
    const rawBody = await request.text()
    const signature = request.headers.get('x-razorpay-signature') || ''
    if (!await verifyHmac(requireEnv('RAZORPAY_WEBHOOK_SECRET'), rawBody, signature)) return json(400, { success: false, error: { code: 'invalid_webhook_signature', message: 'Webhook signature could not be verified.' } })
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
    if (payment?.id) await persistPayment(admin, order, payment, {
      eventId: String(event?.id || eventName),
      verified: Boolean(order && paymentMatches(payment, order)),
    })
    if (!order) return json(200, { success: true, processed: false, reason: 'local_order_not_found' })
    if (eventName === 'payment.failed') {
      if (order.status !== 'paid') await markOrder(admin, order, 'failed')
      return json(200, { success: true, processed: true, status: 'failed' })
    }
    if (payment?.status === 'refunded' || eventName === 'payment.refunded' || eventName === 'refund.processed') {
      await markOrder(admin, order, 'refunded')
      const { error: refundUpdateError } = await admin.from('payments').update({
        status: 'refunded',
        webhook_event_id: String(event?.id || eventName),
        raw_payload: event,
        updated_at: new Date().toISOString(),
      }).eq('razorpay_payment_id', payment?.id || refund?.payment_id)
      if (refundUpdateError) throw refundUpdateError
      return json(200, { success: true, processed: true, status: 'refunded' })
    }
    if (payment && paymentCaptured(payment) && paymentMatches(payment, order)) {
      await markOrder(admin, order, 'paid', { paid_at: order.paid_at || new Date().toISOString(), verified_at: new Date().toISOString() })
      return json(200, { success: true, processed: true, status: 'paid' })
    }
    return json(200, { success: true, processed: true, status: order.status || 'pending' })
  } catch (error) { return errorResponse(error) }
})
