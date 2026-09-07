const {
  proxyEdgeFunction,
  sendError,
} = require('./_lib/greyveil-api')

const handler = async (req, res) => {
  try {
    await proxyEdgeFunction(req, res, 'validate-coupon')
  } catch (error) {
    sendError(res, error)
  }
}

handler.config = { api: { bodyParser: false } }

module.exports = handler
