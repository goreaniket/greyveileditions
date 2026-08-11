const {
  allowMethods,
  authenticateUser,
  createCheckoutOrder,
  readJsonBody,
  sendError,
  sendJson,
} = require('./_lib/greyveil-api')

module.exports = async (req, res) => {
  try {
    if (!allowMethods(req, res, ['POST', 'OPTIONS'])) return

    const { user } = await authenticateUser(req)
    const body = await readJsonBody(req)
    const order = await createCheckoutOrder(user, body)

    sendJson(res, 200, {
      success: true,
      order,
    })
  } catch (error) {
    sendError(res, error)
  }
}
