const {
  allowMethods,
  authenticateUser,
  previewCheckoutPricing,
  readJsonBody,
  sendError,
  sendJson,
} = require('./_lib/greyveil-api')

module.exports = async (req, res) => {
  try {
    if (!allowMethods(req, res, ['POST', 'OPTIONS'])) return

    const { user } = await authenticateUser(req)
    const body = await readJsonBody(req)
    const pricing = await previewCheckoutPricing(user, body)

    sendJson(res, 200, {
      success: true,
      pricing,
    })
  } catch (error) {
    sendError(res, error)
  }
}
