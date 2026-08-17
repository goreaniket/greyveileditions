import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

const ROOT = path.resolve(import.meta.dirname, '..')
const BOOKS_ROOT = path.join(ROOT, 'assets', 'books')
const BUCKET = 'reader-content'
const BOOK_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const RESOURCE_PATTERN = /^(?:book\.json|chapters\/[a-z0-9][a-z0-9._-]*\.json)$/i

export const normalizeResourcePath = (value) => String(value || '').trim().replaceAll('\\', '/')

export const collectReaderResources = async () => {
  const entries = await readdir(BOOKS_ROOT, { withFileTypes: true })
  const resources = []

  for (const entry of entries.filter((item) => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const manifestPath = path.join(BOOKS_ROOT, entry.name, 'book.json')
    let manifest
    try {
      manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    } catch (error) {
      if (error?.code === 'ENOENT') continue
      throw error
    }

    const slug = String(manifest.slug || entry.name).trim().toLowerCase()
    if (!BOOK_SLUG_PATTERN.test(slug) || slug !== entry.name) {
      throw new Error(`Reader manifest slug does not match its folder: ${entry.name}`)
    }

    const requested = ['book.json', ...(manifest.units || []).map((unit) => normalizeResourcePath(unit.file))]
    if (!Array.isArray(manifest.units) || requested.some((resource) => !RESOURCE_PATTERN.test(resource))) {
      throw new Error(`Reader manifest contains an invalid resource: ${entry.name}`)
    }

    for (const resource of new Set(requested)) {
      const localPath = path.join(BOOKS_ROOT, slug, ...resource.split('/'))
      const data = await readFile(localPath)
      JSON.parse(data.toString('utf8'))
      resources.push({ slug, resource, localPath, data })
    }
  }

  return resources
}

const encodeObjectPath = (slug, resource) => [slug, ...resource.split('/')]
  .map((segment) => encodeURIComponent(segment))
  .join('/')

const uploadResource = async ({ supabaseUrl, serviceKey, item }) => {
  const objectPath = encodeObjectPath(item.slug, item.resource)
  const headers = {
    apikey: serviceKey,
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'x-upsert': 'true',
  }
  if (!serviceKey.startsWith('sb_secret_')) headers.Authorization = `Bearer ${serviceKey}`

  const response = await fetch(`${supabaseUrl}/storage/v1/object/${BUCKET}/${objectPath}`, {
    method: 'POST',
    headers,
    body: item.data,
  })

  if (!response.ok) {
    const detail = await response.text()
    throw new Error(`Upload failed for ${item.slug}/${item.resource}: ${response.status} ${detail.slice(0, 240)}`)
  }
}

const main = async () => {
  const apply = process.argv.includes('--apply')
  const resources = await collectReaderResources()
  const totalBytes = resources.reduce((sum, item) => sum + item.data.length, 0)
  const bookCount = new Set(resources.map((item) => item.slug)).size

  if (!apply) {
    console.log(`Validated ${resources.length} reader JSON files across ${bookCount} books (${(totalBytes / 1024 / 1024).toFixed(2)} MB).`)
    console.log('No upload performed. Add --apply after setting SUPABASE_URL and a server-only Supabase secret key.')
    return
  }

  const supabaseUrl = String(process.env.SUPABASE_URL || '').replace(/\/$/, '')
  const serviceKey = String(process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '')
  if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(supabaseUrl) || !serviceKey) {
    throw new Error('Set SUPABASE_URL and SUPABASE_SECRET_KEY (or legacy SUPABASE_SERVICE_ROLE_KEY) in the current terminal session.')
  }

  let completed = 0
  for (const item of resources) {
    await uploadResource({ supabaseUrl, serviceKey, item })
    completed += 1
    if (completed % 25 === 0 || completed === resources.length) {
      console.log(`Uploaded ${completed}/${resources.length} reader files.`)
    }
  }

  console.log(`Private reader content upload complete for ${bookCount} books.`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  main().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
