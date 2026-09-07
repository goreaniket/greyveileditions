import {
  authenticate,
  errorResponse,
  handleOptions,
  HttpError,
  json,
  parseBody,
  reconcilePendingPayment,
  serviceClient,
  validRecordId,
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
    const localOrderId = String(body.local_order_id || '').trim()
    if (!validRecordId(localOrderId)) throw new HttpError(400, 'Order id is invalid.', 'invalid_order_id')

    const { data: order, error: orderError } = await admin
      .from('orders')
      .select('*')
      .eq('id', localOrderId)
      .eq('user_id', user.id)
      .maybeSingle()
    if (orderError) throw new HttpError(500, 'Order data could not be read.', 'database_read_failed')
    if (!order) throw new HttpError(404, 'Order was not found for this account.', 'order_not_found')

    const result = await reconcilePendingPayment(admin, order)
    return json(200, {
      success: true,
      paid: result.paid,
      status: result.status,
      local_order_id: order.id,
      payment_id: result.paymentId || null,
      reconciled: result.reconciled,
    }, request)
  } catch (error) {
    return errorResponse(error, request)
  }
})
