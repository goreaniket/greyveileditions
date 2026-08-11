const {
  allowMethods,
  authenticateUser,
  readJsonBody,
  sendError,
  sendJson,
  verifyCheckoutPayment,
} = require('./_lib/greyveil-api')

module.exports = async (req, res) => {
  try {
    if (!allowMethods(req, res, ['POST', 'OPTIONS'])) return

    const { user } = await authenticateUser(req)
    const body = await readJsonBody(req)
    const result = await verifyCheckoutPayment(user, body)

    sendJson(res, result.paid ? 200 : 202, result)
  } catch (error) {
    sendError(res, error)
  }
}
