import assert from 'node:assert/strict'
import { glob, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url))
const productionOrigin = 'https://greyveileditions.site'
const excludedDirectories = [
  '.agents/',
  '.git/',
  '.github/',
  'docs/',
  'generated/',
  'output/',
  'supabase/',
  'tests/',
  'tmp/',
  'tools/',
]

const isDeployablePath = (filePath) => {
  const normalized = filePath.replaceAll('\\', '/')
  return !excludedDirectories.some((directory) => normalized.startsWith(directory))
    && !/\/chapters\/(?:PDF|WORD|word)\//.test(normalized)
}

const deployableHtmlFiles = async () => {
  const files = []
  for await (const filePath of glob('**/*.html', { cwd: repositoryRoot })) {
    if (isDeployablePath(filePath)) files.push(filePath.replaceAll('\\', '/'))
  }
  return files.sort()
}

const routeForFile = (filePath) => {
  if (filePath === 'index.html') return '/'
  if (filePath.endsWith('/index.html')) return `/${filePath.slice(0, -'index.html'.length)}`
  return `/${filePath}`
}

const fileExists = async (candidate) => {
  try {
    return (await stat(candidate)).isFile()
  } catch (_error) {
    return false
  }
}

const resolveDeployedFile = async (pathname) => {
  const relativePath = decodeURIComponent(pathname).replace(/^\/+/, '')
  const candidates = relativePath
    ? pathname.endsWith('/')
      ? [path.join(repositoryRoot, relativePath, 'index.html')]
      : [
          path.join(repositoryRoot, relativePath),
          path.join(repositoryRoot, `${relativePath}.html`),
          path.join(repositoryRoot, relativePath, 'index.html'),
        ]
    : [path.join(repositoryRoot, 'index.html')]

  for (const candidate of candidates) {
    if (await fileExists(candidate)) return candidate
  }
  return null
}

const htmlAttributeValues = (html, tagName, attribute) => {
  const values = []
  const tagPattern = new RegExp(`<${tagName}\\b[^>]*>`, 'gi')
  const attributePattern = new RegExp(`\\b${attribute}\\s*=\\s*(["'])(.*?)\\1`, 'i')
  for (const tag of html.match(tagPattern) || []) {
    const value = tag.match(attributePattern)?.[2]
    if (value !== undefined) values.push({ tag, value })
  }
  return values
}

test('deployable route inventory contains every public, auth, commerce, admin, and reader endpoint', async () => {
  const files = await deployableHtmlFiles()
  const routes = files.map(routeForFile)

  assert.equal(routes.length, 49, 'Update the audited route inventory when routes are intentionally added or removed.')
  assert.equal(routes.filter((route) => route.endsWith('/reader/')).length, 14)
  assert.equal(routes.filter((route) => /\/books\/[^/]+\.html$/.test(route)).length, 14)

  for (const requiredRoute of [
    '/', '/about/', '/founder/', '/projects/', '/account/', '/admin/',
    '/auth/login/', '/auth/signup/', '/forgot-password/', '/reset-password/',
    '/checkout/', '/contact/', '/credits/', '/404.html',
    '/google15fc12813d867a6a.html',
  ]) assert.ok(routes.includes(requiredRoute), `Missing route: ${requiredRoute}`)
})

test('every internal anchor resolves and every fragment names an element', async () => {
  const failures = []

  for (const filePath of await deployableHtmlFiles()) {
    const html = await readFile(path.join(repositoryRoot, filePath), 'utf8')
    const baseUrl = new URL(routeForFile(filePath), `${productionOrigin}/`)

    for (const { value: href } of htmlAttributeValues(html, 'a', 'href')) {
      if (!href.trim() || href.trim() === '#') {
        failures.push(`${filePath}: empty placeholder link`)
        continue
      }

      let targetUrl
      try {
        targetUrl = new URL(href, baseUrl)
      } catch (_error) {
        failures.push(`${filePath}: invalid link ${href}`)
        continue
      }

      if (!['http:', 'https:'].includes(targetUrl.protocol) || targetUrl.origin !== productionOrigin) continue
      const targetFile = await resolveDeployedFile(targetUrl.pathname)
      if (!targetFile) {
        failures.push(`${filePath}: missing destination ${href}`)
        continue
      }

      if (targetUrl.hash) {
        const fragment = decodeURIComponent(targetUrl.hash.slice(1))
        const targetHtml = await readFile(targetFile, 'utf8')
        const ids = new Set([...targetHtml.matchAll(/\bid\s*=\s*(["'])(.*?)\1/gi)].map((match) => match[2]))
        if (!ids.has(fragment)) failures.push(`${filePath}: missing fragment ${href}`)
      }
    }
  }

  assert.deepEqual(failures, [])
})

test('HTML, CSS, and module references point to deployable local assets', async () => {
  const failures = []

  for (const filePath of await deployableHtmlFiles()) {
    const html = await readFile(path.join(repositoryRoot, filePath), 'utf8')
    const baseUrl = new URL(routeForFile(filePath), `${productionOrigin}/`)
    const references = [
      ...htmlAttributeValues(html, 'img', 'src'),
      ...htmlAttributeValues(html, 'script', 'src'),
      ...htmlAttributeValues(html, 'link', 'href'),
    ]

    for (const { value: reference } of references) {
      const targetUrl = new URL(reference, baseUrl)
      if (!['http:', 'https:'].includes(targetUrl.protocol) || targetUrl.origin !== productionOrigin) continue
      if (!await resolveDeployedFile(targetUrl.pathname)) failures.push(`${filePath}: missing asset ${reference}`)
    }
  }

  for await (const filePath of glob('assets/**/*.css', { cwd: repositoryRoot })) {
    const normalizedPath = filePath.replaceAll('\\', '/')
    const css = await readFile(path.join(repositoryRoot, normalizedPath), 'utf8')
    for (const match of css.matchAll(/url\(\s*(["']?)(.*?)\1\s*\)/gi)) {
      const reference = match[2]
      if (!reference || /^(?:data:|https?:|#)/i.test(reference)) continue
      const candidate = path.resolve(path.dirname(path.join(repositoryRoot, normalizedPath)), decodeURIComponent(reference.split(/[?#]/)[0]))
      if (!await fileExists(candidate)) failures.push(`${normalizedPath}: missing asset ${reference}`)
    }
  }

  for await (const filePath of glob('assets/js/*.{js,mjs}', { cwd: repositoryRoot })) {
    const normalizedPath = filePath.replaceAll('\\', '/')
    const source = await readFile(path.join(repositoryRoot, normalizedPath), 'utf8')
    for (const match of source.matchAll(/(?:from\s+|import\s*\()(["'])(\.{1,2}\/[^"']+)\1/g)) {
      const reference = match[2].split(/[?#]/)[0]
      const candidate = path.resolve(path.dirname(path.join(repositoryRoot, normalizedPath)), reference)
      if (!await fileExists(candidate)) failures.push(`${normalizedPath}: missing module ${match[2]}`)
    }
  }

  assert.deepEqual(failures, [])
})

test('native hidden state cannot be overridden by component display rules', async () => {
  const css = await readFile(path.join(repositoryRoot, 'assets/css/style.css'), 'utf8')
  assert.match(css, /(?:^|\n)\[hidden\]\s*{\s*display:\s*none\s*!important;/)
})

test('the responsive Admin menu reports its open and closed state accessibly', async () => {
  const source = await readFile(path.join(repositoryRoot, 'assets/js/admin.js'), 'utf8')
  assert.match(source, /setAttribute\('aria-label', open \? 'Close admin navigation' : 'Open admin navigation'\)/)
  assert.match(source, /classList\.remove\('is-admin-nav-open'\)[\s\S]+setAttribute\('aria-expanded', 'false'\)[\s\S]+setAttribute\('aria-label', 'Open admin navigation'\)/)
})

test('static forms and non-submitting buttons have an effective native or scripted action', async () => {
  const javascriptFiles = []
  for await (const filePath of glob('assets/js/*.{js,mjs}', { cwd: repositoryRoot })) javascriptFiles.push(filePath)
  const javascript = (await Promise.all(javascriptFiles.map((filePath) => readFile(path.join(repositoryRoot, filePath), 'utf8')))).join('\n')
  const failures = []

  for (const filePath of await deployableHtmlFiles()) {
    const html = await readFile(path.join(repositoryRoot, filePath), 'utf8')

    for (const formTag of html.match(/<form\b[^>]*>/gi) || []) {
      const formMarker = formTag.match(/\bdata-([a-z0-9-]+-form)(?:\s|=|>)/i)?.[1]
      if (!formMarker) failures.push(`${filePath}: form has no script marker`)
      else if (!javascript.includes(`[data-${formMarker}]`)) failures.push(`${filePath}: unwired form data-${formMarker}`)
    }

    for (const buttonTag of html.match(/<button\b[^>]*>/gi) || []) {
      const type = buttonTag.match(/\btype\s*=\s*(["'])(.*?)\1/i)?.[2]?.toLowerCase() || 'submit'
      if (type === 'submit' || type === 'reset') continue

      const classWired = /\bclass\s*=\s*(["'])[^"']*\b(?:nav-toggle|dropdown-trigger)\b[^"']*\1/i.test(buttonTag)
      const dataMarker = buttonTag.match(/\bdata-((?:password-toggle|purchase-type|logout-button|library-refresh|checkout-(?:pay|coupon-remove)|admin-(?:logout|refresh|menu|tab(?:-link)?)|announcement-image-remove|book-filters-reset|series-access-revoke|access-mode-tab))(?:\s|=|>)/i)?.[1]
      const dataWired = dataMarker && javascript.includes(`[data-${dataMarker}`)
      if (!classWired && !dataWired) failures.push(`${filePath}: button has no effective handler: ${buttonTag}`)
    }
  }

  assert.deepEqual(failures, [])
})
