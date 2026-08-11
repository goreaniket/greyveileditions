const {
  ApiError,
  allowMethods,
  processWebhookEvent,
  readRawBodyBuffer,
  sendError,
  sendJson,
  verifyWebhookSignature,
} = require('./_lib/greyveil-api')

const handler = async (req, res) => {
  try {
    if (!allowMethods(req, res, ['POST', 'OPTIONS'])) return

    const signature = req.headers['x-razorpay-signature']
    const rawBody = await readRawBodyBuffer(req)
    verifyWebhookSignature(rawBody, signature)

    let event = null
    try {
      event = JSON.parse(rawBody.toString('utf8'))
    } catch (_error) {
      throw new ApiError(400, 'Webhook body must be valid JSON.', 'invalid_json')
    }

    const result = await processWebhookEvent(event)
    sendJson(res, 200, {
      success: true,
      result,
    })
  } catch (error) {
    sendError(res, error)
  }
}

handler.config = {
  api: {
    bodyParser: false,
  },
}

module.exports = handler
