import assert from 'node:assert/strict'
import { glob, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { appOrigin, appUrl, PRODUCTION_ORIGIN, safeReturnPath } from '../assets/js/site-config.js'
import { friendlyAuthMessage, logAuthDiagnostic } from '../assets/js/auth-errors.js'

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url))
const source = (path) => readFile(new URL(path, import.meta.url), 'utf8')
const legacyHostname = ['greyveileditions', 'vercel', 'app'].join('.')
const productionHostname = new URL(PRODUCTION_ORIGIN).hostname
const wwwHostname = `www.${productionHostname}`

const textFiles = async () => {
  const patterns = ['**/*.html', '**/*.js', '**/*.mjs', '**/*.ts', '**/*.sql', '**/*.xml', '**/*.txt', '**/*.md', '**/*.json', '**/*.toml']
  const files = new Set()
  for (const pattern of patterns) {
    for await (const path of glob(pattern, { cwd: repositoryRoot })) files.add(path)
  }
  return [...files]
}

test('the legacy production hostname appears only in its explicit redirect condition', async () => {
  const stale = []
  for (const path of await textFiles()) {
    const text = await readFile(new URL(path.replaceAll('\\', '/'), new URL('../', import.meta.url)), 'utf8')
    if (text.includes(legacyHostname)) stale.push(path)
  }
  assert.deepEqual(stale, ['vercel.json'])
})

test('the custom domain is the only canonical Greyveil origin in repository HTML', async () => {

  const htmlFiles = []
  for await (const path of glob('**/*.html', { cwd: repositoryRoot })) htmlFiles.push(path)
  for (const path of htmlFiles) {
    const html = await readFile(new URL(path.replaceAll('\\', '/'), new URL('../', import.meta.url)), 'utf8')
    for (const match of html.matchAll(/<link\s+rel=["']canonical["']\s+href=["']([^"']+)["']/gi)) {
      assert.ok(match[1].startsWith(`${PRODUCTION_ORIGIN}/`), `${path} has a non-production canonical URL`)
    }
    for (const match of html.matchAll(/<script\s+type=["']application\/ld\+json["']>([\s\S]*?)<\/script>/gi)) {
      assert.doesNotThrow(() => JSON.parse(match[1]), `${path} has invalid JSON-LD`)
    }
  }
})

test('noncanonical hosts have permanent, same-path, query-preserving redirects without loops', async () => {
  const config = JSON.parse(await source('../vercel.json'))
  assert.equal(config.redirects?.length, 2)

  const redirectsByHost = new Map(config.redirects.map((redirect) => [redirect.has?.[0]?.value, redirect]))
  assert.deepEqual([...redirectsByHost.keys()].sort(), [legacyHostname, wwwHostname].sort())

  for (const [hostname, redirect] of redirectsByHost) {
    assert.deepEqual(redirect.has, [{ type: 'host', value: hostname }])
    assert.equal(redirect.source, '/(.*)')
    assert.equal(redirect.destination, `${PRODUCTION_ORIGIN}/$1`)
    assert.equal(redirect.permanent, true)
    assert.equal(new URL(redirect.destination.replace('$1', '')).hostname, productionHostname)
    assert.notEqual(productionHostname, hostname)
    assert.ok(!redirect.destination.includes('?'), 'Vercel must inherit the original query string instead of replacing it')
  }

  const resolveRedirect = (hostname, pathAndQuery) => {
    const redirect = redirectsByHost.get(hostname)
    const url = new URL(pathAndQuery, `https://${hostname}`)
    const match = url.pathname.match(/^\/(.*)$/)
    assert.ok(match)
    return `${redirect.destination.replace('$1', match[1])}${url.search}`
  }

  assert.equal(resolveRedirect(legacyHostname, '/'), `${PRODUCTION_ORIGIN}/`)
  assert.equal(resolveRedirect(legacyHostname, '/about/'), `${PRODUCTION_ORIGIN}/about/`)
  assert.equal(resolveRedirect(legacyHostname, '/projects/human-mind/'), `${PRODUCTION_ORIGIN}/projects/human-mind/`)
  assert.equal(resolveRedirect(legacyHostname, '/about/?source=test&campaign=seo'), `${PRODUCTION_ORIGIN}/about/?source=test&campaign=seo`)
  assert.equal(resolveRedirect(legacyHostname, '/api/validate-coupon'), `${PRODUCTION_ORIGIN}/api/validate-coupon`)
  assert.equal(resolveRedirect(wwwHostname, '/founder/?source=www'), `${PRODUCTION_ORIGIN}/founder/?source=www`)
})

test('public pages have one exact self-canonical while intentionally private routes stay noindex', async () => {
  const specialFiles = new Set(['404.html', 'google15fc12813d867a6a.html'])
  const intentionalAlias = 'about/lalit-rakesh-mishra/index.html'
  const failures = []
  let publicCount = 0
  let noindexCount = 0

  for await (const rawPath of glob('**/*.html', { cwd: repositoryRoot })) {
    const path = rawPath.replaceAll('\\', '/')
    if (specialFiles.has(path)) continue
    const html = await readFile(new URL(path, new URL('../', import.meta.url)), 'utf8')
    const robots = html.match(/<meta\s+name=["']robots["']\s+content=["']([^"']+)["']/i)?.[1] || ''
    const canonicals = [...html.matchAll(/<link\s+rel=["']canonical["']\s+href=["']([^"']+)["']/gi)].map((match) => match[1])

    if (/\bnoindex\b/i.test(robots)) {
      noindexCount += 1
      if (path === intentionalAlias) assert.deepEqual(canonicals, [`${PRODUCTION_ORIGIN}/founder/`])
      continue
    }

    publicCount += 1
    const route = path === 'index.html'
      ? '/'
      : path.endsWith('/index.html')
        ? `/${path.slice(0, -'index.html'.length)}`
        : `/${path}`
    if (canonicals.length !== 1 || canonicals[0] !== `${PRODUCTION_ORIGIN}${route}`) {
      failures.push(`${path}: ${canonicals.join(', ') || 'missing canonical'}`)
    }
  }

  assert.equal(publicCount, 24)
  assert.equal(noindexCount, 23)
  assert.deepEqual(failures, [])
})

test('sitemap, robots, structured identities, and reader indexing rules use the intended domain', async () => {
  const [home, founder, sitemap, robots] = await Promise.all([
    source('../index.html'),
    source('../founder/index.html'),
    source('../sitemap.xml'),
    source('../robots.txt'),
  ])

  assert.match(home, /https:\/\/greyveileditions\.site\/#organization/)
  assert.match(founder, /https:\/\/greyveileditions\.site\/founder\/#person/)
  assert.doesNotMatch(sitemap, /<loc>(?!https:\/\/greyveileditions\.site\/)/)
  assert.match(robots, /Sitemap: https:\/\/greyveileditions\.site\/sitemap\.xml/)

  let readerCount = 0
  for await (const path of glob('projects/**/reader/index.html', { cwd: repositoryRoot })) {
    const html = await readFile(new URL(path.replaceAll('\\', '/'), new URL('../', import.meta.url)), 'utf8')
    assert.match(html, /<meta name="robots" content="noindex, follow" \/>/)
    readerCount += 1
  }
  assert.equal(readerCount, 14)
})

test('production auth callbacks use the custom origin while localhost remains local', () => {
  const productionPreview = new URL(`https://${['greyveil-preview', 'vercel', 'app'].join('.')}/auth/signup/?next=%2Faccount%2F`)
  const localhost = new URL('http://localhost:4173/auth/signup/')
  const loopback = new URL('http://127.0.0.1:8080/forgot-password/')

  assert.equal(appOrigin(productionPreview), PRODUCTION_ORIGIN)
  assert.equal(appUrl('/reset-password/', productionPreview), 'https://greyveileditions.site/reset-password/')
  assert.equal(appOrigin(localhost), 'http://localhost:4173')
  assert.equal(appOrigin(loopback), 'http://127.0.0.1:8080')
  assert.equal(safeReturnPath('/checkout/?type=book&id=1'), '/checkout/?type=book&id=1')
  assert.equal(safeReturnPath('//attacker.example/path'), '')
  assert.equal(safeReturnPath('https://attacker.example/path'), '')
})

test('signup, reset, checkout, and protected reader flows preserve safe destinations', async () => {
  const [auth, checkout, reader] = await Promise.all([
    source('../assets/js/auth.js'),
    source('../assets/js/checkout.js'),
    source('../assets/js/reader.js'),
  ])

  assert.match(auth, /emailRedirectTo: signupConfirmationRedirectUrl\(\)/)
  assert.match(auth, /hasAuthCallbackError\(\)/)
  assert.match(auth, /confirmation link is invalid or has expired/)
  assert.match(auth, /redirectTo: resetPasswordRedirectUrl\(\)/)
  assert.match(auth, /exchangeCodeForSession\(code\)/)
  assert.match(auth, /safeReturnPath\(next\)/)
  assert.match(checkout, /\/auth\/login\/\?next=\$\{encodeURIComponent\(next\)\}/)
  assert.match(reader, /readerLoginUrl\(\)/)
  assert.match(reader, /encodeURIComponent\(currentReaderReturnPath\(\)\)/)
})

test('auth errors are safe for users and structured only for local diagnostics', () => {
  assert.match(friendlyAuthMessage({ code: 'user_already_exists' }), /already exists/i)
  assert.match(friendlyAuthMessage({ code: 'email_address_invalid' }), /valid email/i)
  assert.match(friendlyAuthMessage({ code: 'weak_password' }), /stronger password/i)
  assert.match(friendlyAuthMessage({ code: 'signup_disabled' }), /temporarily unavailable/i)
  assert.match(friendlyAuthMessage({ status: 429, message: 'rate limit' }), /wait a few minutes/i)
  assert.match(friendlyAuthMessage({ message: 'Error sending confirmation email through SMTP' }), /confirmation email/i)
  assert.match(friendlyAuthMessage({ message: 'Database error saving new user' }), /finish setting up/i)
  assert.match(friendlyAuthMessage({ message: 'Failed to fetch' }), /reach the account service/i)
  assert.match(friendlyAuthMessage({ status: 503, code: 'unexpected_failure' }), /temporarily unavailable/i)

  const diagnostics = []
  logAuthDiagnostic('signup', { message: 'Database error saving new user', status: 500, code: 'unexpected_failure' }, new URL('http://localhost:4173/'), (...args) => diagnostics.push(args))
  assert.equal(diagnostics.length, 1)
  assert.deepEqual(Object.keys(diagnostics[0][1]).sort(), ['code', 'message', 'operation', 'status'])

  logAuthDiagnostic('signup', { message: 'hidden production detail', status: 500 }, new URL('https://greyveileditions.site/'), (...args) => diagnostics.push(args))
  assert.equal(diagnostics.length, 1)
})

test('profile repair preserves the existing trigger, hardcodes customer, and repairs own-profile RLS', async () => {
  const migration = await source('../supabase/auth-profile-signup-repair.sql')
  assert.match(migration, /alter column role set default 'customer'/)
  assert.match(migration, /security definer[\s\S]+set search_path = ''/)
  assert.match(migration, /insert into public\.profiles \(id, display_name, role, created_at\)/)
  assert.match(migration, /'customer',[\s\S]+on conflict \(id\) do nothing/)
  assert.match(migration, /tgname = 'on_auth_user_created'/)
  assert.match(migration, /Existing on_auth_user_created trigger definition/)
  assert.match(migration, /pg_get_functiondef\(signup_function_oid\)/)
  assert.match(migration, /create or replace function %I\.%I\(\)/)
  assert.doesNotMatch(migration, /create trigger\s+(?:greyveil_create_profile_after_signup|on_auth_user_created)/i)
  assert.doesNotMatch(migration, /drop trigger[^;]+on auth\.users/i)
  assert.match(migration, /Users read their own profile[\s\S]+for select[\s\S]+auth\.uid\(\) = id/)
  assert.match(migration, /Users update their own profile[\s\S]+for update[\s\S]+auth\.uid\(\) = id/)
  assert.match(migration, /greyveil_guard_customer_profile_fields/)
  assert.match(migration, /to_jsonb\(new\) - 'display_name'/)
  assert.match(migration, /grant update \(display_name\) on public\.profiles to authenticated/)
  assert.match(migration, /greyveil_guard_profile_role/)
  assert.doesNotMatch(migration, /raw_user_meta_data\s*->>\s*'role'/)
})

test('Edge browser CORS is origin-aware and leaves originless webhooks available', async () => {
  const [cors, shared, createOrder, verifyPayment, webhook, reader] = await Promise.all([
    source('../supabase/functions/_shared/cors.ts'),
    source('../supabase/functions/_shared/payment.ts'),
    source('../supabase/functions/create-order/index.ts'),
    source('../supabase/functions/verify-payment/index.ts'),
    source('../supabase/functions/razorpay-webhook/index.ts'),
    source('../supabase/functions/reader-content/index.ts'),
  ])

  assert.match(cors, /https:\/\/greyveileditions\.site/)
  assert.match(cors, /localhost/)
  assert.match(cors, /127\.0\.0\.1/)
  assert.match(cors, /GREYVEIL_ALLOWED_ORIGINS/)
  assert.doesNotMatch(cors, /'Access-Control-Allow-Origin': '\*'/)
  assert.match(cors, /if \(!origin\) return true/)
  assert.match(shared, /handleCors/)
  for (const handler of [createOrder, verifyPayment, webhook, reader]) assert.match(handler, /handle(?:Options|Cors)\(request\)/)
  assert.match(webhook, /request\.headers\.get\('x-razorpay-signature'\)/)
})

test('Search Console verification remains deployable from the root', async () => {
  const [verification, ignore] = await Promise.all([
    source('../google15fc12813d867a6a.html'),
    source('../.vercelignore'),
  ])
  assert.equal(verification.trim(), 'google-site-verification: google15fc12813d867a6a.html')
  assert.doesNotMatch(ignore, /google15fc12813d867a6a\.html/)
})
