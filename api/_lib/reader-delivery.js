const { inflateRawSync } = require('zlib')

const MAX_RESOURCES = 64
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024
const MAX_RESOURCE_BYTES = 4 * 1024 * 1024
const BOOK_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const RESOURCE_PATTERN = /^(?:book\.json|chapters\/[a-z0-9][a-z0-9._-]*\.json)$/i
const VERSION_PATTERN = '[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}'

class ReaderDeliveryError extends Error {
  constructor(status, message, code) {
    super(message)
    this.name = 'ReaderDeliveryError'
    this.status = status
    this.code = code
  }
}

const normalizeResources = (values) => {
  const resources = [...new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value || '').trim().replaceAll('\\', '/')))]
  if (!resources.length || resources.length > MAX_RESOURCES
      || resources.some((resource) => !RESOURCE_PATTERN.test(resource))) {
    throw new ReaderDeliveryError(400, 'Choose valid reader resources.', 'invalid_resource')
  }
  return resources
}

const parseReaderRequest = (body = {}) => {
  const bookSlug = String(body.book_slug || '').trim().toLowerCase()
  if (!BOOK_SLUG_PATTERN.test(bookSlug)) {
    throw new ReaderDeliveryError(400, 'Choose a valid book.', 'invalid_book')
  }
  const requested = Array.isArray(body.resources)
    ? body.resources
    : body.resource == null ? [] : [body.resource]
  return { bookSlug, resources: normalizeResources(requested) }
}

const authorizationFailure = (authorization) => {
  const reason = String(authorization?.reason || 'access_required')
  if (reason === 'login_required') {
    return new ReaderDeliveryError(401, 'Please sign in to continue.', reason)
  }
  if (reason === 'unavailable') {
    return new ReaderDeliveryError(404, 'Reader content is unavailable.', reason)
  }
  return new ReaderDeliveryError(403, 'This account does not have access to the book.', reason)
}

const validatePublishedSource = (record, bookSlug) => {
  if (!record) return null
  const storagePath = String(record.storage_path || '').trim().replaceAll('\\', '/')
  const expected = new RegExp(`^published/${bookSlug}/${VERSION_PATTERN}/source/[^/]+\\.zip$`, 'i')
  if (record.file_type !== 'source' || !expected.test(storagePath)) {
    throw new ReaderDeliveryError(500, 'The published Reader reference is invalid.', 'published_reference_invalid')
  }
  const fileSize = Number(record.file_size)
  if (Number.isFinite(fileSize) && (fileSize < 0 || fileSize > MAX_ARCHIVE_BYTES)) {
    throw new ReaderDeliveryError(500, 'The published Reader source is too large.', 'published_reference_invalid')
  }
  return { ...record, storage_path: storagePath }
}

const findEndOfCentralDirectory = (archive) => {
  const minimum = Math.max(0, archive.length - 65557)
  for (let offset = archive.length - 22; offset >= minimum; offset -= 1) {
    if (archive.readUInt32LE(offset) === 0x06054b50) return offset
  }
  return -1
}

const zipEntries = (value) => {
  const archive = Buffer.isBuffer(value) ? value : Buffer.from(value || [])
  if (!archive.length || archive.length > MAX_ARCHIVE_BYTES) {
    throw new ReaderDeliveryError(500, 'The published Reader source is invalid.', 'invalid_published_source')
  }
  const end = findEndOfCentralDirectory(archive)
  if (end < 0) throw new ReaderDeliveryError(500, 'The published Reader source is invalid.', 'invalid_published_source')

  const entries = new Map()
  const count = archive.readUInt16LE(end + 10)
  let offset = archive.readUInt32LE(end + 16)
  for (let index = 0; index < count; index += 1) {
    if (offset + 46 > archive.length || archive.readUInt32LE(offset) !== 0x02014b50) {
      throw new ReaderDeliveryError(500, 'The published Reader source is invalid.', 'invalid_published_source')
    }
    const method = archive.readUInt16LE(offset + 10)
    const compressedSize = archive.readUInt32LE(offset + 20)
    const uncompressedSize = archive.readUInt32LE(offset + 24)
    const nameLength = archive.readUInt16LE(offset + 28)
    const extraLength = archive.readUInt16LE(offset + 30)
    const commentLength = archive.readUInt16LE(offset + 32)
    const localOffset = archive.readUInt32LE(offset + 42)
    const name = archive.subarray(offset + 46, offset + 46 + nameLength).toString('utf8').replaceAll('\\', '/')
    entries.set(name, { method, compressedSize, uncompressedSize, localOffset })
    offset += 46 + nameLength + extraLength + commentLength
  }
  return { archive, entries }
}

const readZipEntry = ({ archive, entries }, name) => {
  const entry = entries.get(name)
  if (!entry || entry.uncompressedSize > MAX_RESOURCE_BYTES || entry.localOffset + 30 > archive.length
      || archive.readUInt32LE(entry.localOffset) !== 0x04034b50) {
    throw new ReaderDeliveryError(404, 'Published Reader content is missing.', 'source_missing')
  }
  const nameLength = archive.readUInt16LE(entry.localOffset + 26)
  const extraLength = archive.readUInt16LE(entry.localOffset + 28)
  const start = entry.localOffset + 30 + nameLength + extraLength
  const end = start + entry.compressedSize
  if (start < 0 || end > archive.length) {
    throw new ReaderDeliveryError(500, 'The published Reader source is invalid.', 'invalid_published_source')
  }
  const compressed = archive.subarray(start, end)
  let content
  if (entry.method === 0) content = compressed
  else if (entry.method === 8) content = inflateRawSync(compressed)
  else throw new ReaderDeliveryError(500, 'The published Reader source is invalid.', 'invalid_published_source')
  if (content.length !== entry.uncompressedSize || content.length > MAX_RESOURCE_BYTES) {
    throw new ReaderDeliveryError(500, 'The published Reader source is invalid.', 'invalid_published_source')
  }
  return content
}

const parseResourceJson = (value, missingCode = 'source_missing') => {
  try {
    return JSON.parse(Buffer.from(value).toString('utf8'))
  } catch (_error) {
    throw new ReaderDeliveryError(500, 'Reader content is invalid.', missingCode === 'source_missing' ? 'invalid_content' : missingCode)
  }
}

const resourcesFromPublishedArchive = (archive, bookSlug, resources) => {
  const zip = zipEntries(archive)
  return Object.fromEntries(resources.map((resource) => [
    resource,
    parseResourceJson(readZipEntry(zip, `${bookSlug}/${resource}`)),
  ]))
}

const resolveReaderResourceSet = async ({
  bookId,
  bookSlug,
  resources,
  findPublishedSource,
  downloadPublishedSource,
  downloadLegacyResource,
}) => {
  const source = validatePublishedSource(await findPublishedSource(bookId, bookSlug), bookSlug)
  if (source) {
    const archive = await downloadPublishedSource(source.storage_path)
    return { source: 'published', resources: resourcesFromPublishedArchive(archive, bookSlug, resources) }
  }

  const entries = await Promise.all(resources.map(async (resource) => {
    const content = await downloadLegacyResource(bookSlug, resource)
    if (content == null) throw new ReaderDeliveryError(404, 'Reader content is unavailable.', 'source_missing')
    return [resource, parseResourceJson(content)]
  }))
  return { source: 'legacy', resources: Object.fromEntries(entries) }
}

const handleReaderContentRequest = async ({ body, token = '' }, services) => {
  try {
    const { bookSlug, resources } = parseReaderRequest(body)
    const viewerId = await services.resolveViewerId(token)
    const authorization = await services.authorize(viewerId, bookSlug)
    if (!authorization) throw new ReaderDeliveryError(404, 'Reader content is unavailable.', 'book_not_found')
    if (!authorization.allowed) throw authorizationFailure(authorization)

    const resolved = await resolveReaderResourceSet({
      bookId: authorization.book_id,
      bookSlug: authorization.book_slug || bookSlug,
      resources,
      ...services,
    })
    return {
      status: 200,
      body: {
        success: true,
        book: {
          id: authorization.book_id,
          slug: authorization.book_slug,
          title: authorization.book_title,
          visibility: authorization.effective_visibility,
        },
        source: resolved.source,
        resources: resolved.resources,
      },
    }
  } catch (error) {
    const problem = error instanceof ReaderDeliveryError
      ? error
      : new ReaderDeliveryError(500, 'Reader content could not be loaded.', 'reader_delivery_failed')
    return {
      status: problem.status,
      body: {
        success: false,
        error: {
          code: problem.code,
          message: problem.status >= 500 ? 'Reader content could not be loaded.' : problem.message,
        },
      },
    }
  }
}

module.exports = {
  ReaderDeliveryError,
  handleReaderContentRequest,
  parseReaderRequest,
  resolveReaderResourceSet,
  resourcesFromPublishedArchive,
  validatePublishedSource,
}
