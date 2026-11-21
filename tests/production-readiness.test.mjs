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

  assert.equal(routes.length, 83, 'Update the audited route inventory when routes are intentionally added or removed.')
  assert.equal(routes.filter((route) => route.endsWith('/reader/')).length, 15)
  assert.equal(routes.filter((route) => /\/books\/[^/]+\.html$/.test(route)).length, 14)

  for (const requiredRoute of [
    '/', '/about/', '/founder/', '/projects/', '/account/', '/admin/',
    '/auth/login/', '/auth/signup/', '/forgot-password/', '/reset-password/',
    '/checkout/', '/contact/', '/credits/', '/reader/', '/404.html',
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
      const cssReference = decodeURIComponent(reference.split(/[?#]/)[0])
      const candidate = cssReference.startsWith('/')
        ? path.join(repositoryRoot, cssReference.replace(/^\/+/, ''))
        : path.resolve(path.dirname(path.join(repositoryRoot, normalizedPath)), cssReference)
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

test('Warm Editorial sanctuary tokens and theme persistence are reusable', async () => {
  const [css, theme, reader, globalNavigation] = await Promise.all([
    readFile(path.join(repositoryRoot, 'assets/css/warm-editorial.css'), 'utf8'),
    readFile(path.join(repositoryRoot, 'assets/js/theme-sanctuary.js'), 'utf8'),
    readFile(path.join(repositoryRoot, 'assets/js/reader.js'), 'utf8'),
    readFile(path.join(repositoryRoot, 'assets/js/global-navigation.js'), 'utf8'),
  ])
  assert.match(css, /--gv-warm-bg:\s*#FAF8F5/)
  assert.match(css, /--gv-warm-card:\s*#F0ECE1/)
  assert.match(css, /--gv-warm-ink:\s*#2C2C2C/)
  assert.match(css, /--gv-warm-sage:\s*#5F7A61/)
  assert.match(css, /--gv-warm-terracotta:\s*#C87D55/)
  assert.match(css, /\[data-theme="night"\][\s\S]*--gv-warm-bg:\s*#1E1E1C/)
  assert.match(theme, /greyveil-theme/)
  assert.match(theme, /Night Sanctuary/)
  assert.match(reader, /data-reader-distraction/)
  assert.match(reader, /reader-distraction-mode/)
  assert.match(globalNavigation, /theme-sanctuary\.js/)
})

test('native hidden state cannot be overridden by component display rules', async () => {
  const css = await readFile(path.join(repositoryRoot, 'assets/css/style.css'), 'utf8')
  assert.match(css, /(?:^|\n)\[hidden\]\s*{\s*display:\s*none\s*!important;/)
})

test('the responsive Admin menu reports its open and closed state accessibly', async () => {
  const [html, source] = await Promise.all([
    readFile(path.join(repositoryRoot, 'admin/index.html'), 'utf8'),
    readFile(path.join(repositoryRoot, 'assets/js/admin.js'), 'utf8'),
  ])
  assert.match(html, /id="admin-navigation"[^>]*data-admin-sidebar/)
  assert.match(html, /data-admin-menu[^>]*aria-label="Open admin navigation"[^>]*aria-controls="admin-navigation"[^>]*aria-expanded="false"/)
  assert.match(html, /data-admin-menu-close[^>]*aria-label="Close admin navigation"/)
  assert.match(source, /setAdminNavigationOpen/)
  assert.match(source, /setAttribute\('aria-label', open \? 'Close admin navigation' : 'Open admin navigation'\)/)
  assert.match(source, /menuClose\?\.focus\(\{ preventScroll: true \}\)/)
  assert.match(source, /const restoreMenuFocus = document\.body\.classList\.contains\('is-admin-nav-open'\)[\s\S]*?setAdminNavigationOpen\(false, \{ restoreFocus: restoreMenuFocus \}\)/)
  assert.match(source, /event\.key !== 'Escape'[\s\S]*?setAdminNavigationOpen\(false, \{ restoreFocus: true \}\)/)
})

test('Admin mobile navigation has one viewport-safe scroll owner isolated to the drawer breakpoint', async () => {
  const css = await readFile(path.join(repositoryRoot, 'assets/css/admin.css'), 'utf8')
  const mobileStart = css.indexOf('@media (max-width: 820px)')
  const mobileEnd = css.indexOf('@media (max-width: 560px)', mobileStart)
  const mobile = mobileStart >= 0 && mobileEnd > mobileStart ? css.slice(mobileStart, mobileEnd) : ''
  const mobileNav = mobile.match(/\.admin-nav \{([^}]*)\}/)?.[1] || ''

  assert.match(css, /\.admin-menu-button,\s*\.admin-nav-close \{\s*display: none;/)
  assert.match(mobile, /\.admin-sidebar \{[\s\S]*?height: 100vh;[\s\S]*?height: 100svh;[\s\S]*?height: 100dvh;/)
  assert.match(mobile, /\.admin-sidebar \{[\s\S]*?max-height: 100dvh;[\s\S]*?overflow: hidden;/)
  assert.match(mobile, /env\(safe-area-inset-top\)[\s\S]*?env\(safe-area-inset-bottom\)/)
  assert.match(mobile, /\.admin-nav \{[\s\S]*?min-height: 0;[\s\S]*?flex: 1 1 auto;[\s\S]*?overflow-x: hidden;[\s\S]*?overflow-y: auto;/)
  assert.match(mobile, /overscroll-behavior: contain;[\s\S]*?touch-action: pan-y;/)
  assert.match(mobile, /\.admin-nav-close \{[\s\S]*?display: grid;[\s\S]*?width: 44px;[\s\S]*?height: 44px;/)
  assert.doesNotMatch(mobileNav, /height:\s*\d+px/)
})

test('static forms and non-submitting buttons have an effective native or scripted action', async () => {
  const javascriptFiles = []
  for await (const filePath of glob('assets/js/*.{js,mjs}', { cwd: repositoryRoot })) javascriptFiles.push(filePath)
  for await (const filePath of glob('greyveil-2-preview/**/*.js', { cwd: repositoryRoot })) javascriptFiles.push(filePath)
  const javascript = (await Promise.all(javascriptFiles.map((filePath) => readFile(path.join(repositoryRoot, filePath), 'utf8')))).join('\n')
  const failures = []

  for (const filePath of await deployableHtmlFiles()) {
    const html = await readFile(path.join(repositoryRoot, filePath), 'utf8')

    for (const formTag of html.match(/<form\b[^>]*>/gi) || []) {
      const formMarker = formTag.match(/\bdata-([a-z0-9-]+-form)(?:\s|=|>)/i)?.[1]
      const formId = formTag.match(/\bid\s*=\s*(["'])(.*?)\1/i)?.[2]
      if (formMarker && !javascript.includes(`[data-${formMarker}]`)) failures.push(`${filePath}: unwired form data-${formMarker}`)
      else if (!formMarker && (!formId || !javascript.includes(`#${formId}`))) failures.push(`${filePath}: unwired form #${formId || '(missing id)'}`)
    }

    for (const buttonTag of html.match(/<button\b[^>]*>/gi) || []) {
      const type = buttonTag.match(/\btype\s*=\s*(["'])(.*?)\1/i)?.[2]?.toLowerCase() || 'submit'
      if (type === 'submit' || type === 'reset') continue

      const classWired = /\bclass\s*=\s*(["'])[^"']*\b(?:nav-toggle|dropdown-trigger|menu-toggle|gv-global-toggle)\b[^"']*\1/i.test(buttonTag)
      const dataMarker = buttonTag.match(/\bdata-([a-z0-9-]+)(?:\s|=|>)/i)?.[1]
      const dataWired = dataMarker && javascript.includes(`[data-${dataMarker}`)
      const buttonId = buttonTag.match(/\bid\s*=\s*(["'])(.*?)\1/i)?.[2]
      const idWired = buttonId && javascript.includes(`#${buttonId}`)
      if (!classWired && !dataWired && !idWired) failures.push(`${filePath}: button has no effective handler: ${buttonTag}`)
    }
  }

  assert.deepEqual(failures, [])
})
