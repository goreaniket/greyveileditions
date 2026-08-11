const {
  allowMethods,
  authenticateUser,
  listAdminUsers,
  sendError,
  sendJson,
} = require('./_lib/greyveil-api')

module.exports = async (req, res) => {
  try {
    if (!allowMethods(req, res, ['GET', 'OPTIONS'])) return
    const { user } = await authenticateUser(req)
    const users = await listAdminUsers(user)
    sendJson(res, 200, { success: true, users })
  } catch (error) {
    sendError(res, error)
  }
}
