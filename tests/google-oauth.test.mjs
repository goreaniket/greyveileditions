import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { GOOGLE_OAUTH_REDIRECT_URL, PRODUCTION_ORIGIN } from '../assets/js/site-config.js'

const source = (path) => readFile(new URL(path, import.meta.url), 'utf8')

test('Google OAuth uses the existing Supabase auth client and a fixed production account redirect', async () => {
  const [auth, client] = await Promise.all([
    source('../assets/js/auth.js'),
    source('../assets/js/supabase-client.js'),
  ])

  assert.equal(PRODUCTION_ORIGIN, 'https://greyveileditions.site')
  assert.equal(GOOGLE_OAUTH_REDIRECT_URL, 'https://greyveileditions.site/account/')
  const oauthCall = auth.match(/supabase\.auth\.signInWithOAuth\(\{[\s\S]*?\n\s*\}\)/)?.[0] || ''
  assert.match(oauthCall, /provider:\s*'google'/)
  assert.match(oauthCall, /redirectTo:\s*GOOGLE_OAUTH_REDIRECT_URL/)
  assert.match(auth, /import \{ getCurrentSessionOnce, supabase \} from '\.\/supabase-client\.js'/)
  assert.equal((client.match(/createClient\(/g) || []).length, 1)
  assert.doesNotMatch(oauthCall, /URLSearchParams|window\.location|safeReturnPath|[?&](?:next|redirect|return)=/i)
})

test('login and signup expose one lightweight wired Google button each', async () => {
  const [login, signup, css] = await Promise.all([
    source('../auth/login/index.html'),
    source('../auth/signup/index.html'),
    source('../assets/css/style.css'),
  ])

  for (const html of [login, signup]) {
    assert.equal((html.match(/\sdata-google-signin(?:\s|>)/g) || []).length, 1)
    assert.equal((html.match(/Continue with Google/g) || []).length, 1)
    assert.doesNotMatch(html, /accounts\.google\.com\/gsi|apis\.google\.com|google-signin-client/i)
  }
  assert.match(css, /\.auth-google-button/)
})

test('OAuth reuses database profile defaults, account data, session restoration, and logout', async () => {
  const [auth, profileRepair] = await Promise.all([
    source('../assets/js/auth.js'),
    source('../supabase/auth-profile-signup-repair.sql'),
  ])

  assert.match(profileRepair, /on_auth_user_created/)
  assert.match(profileRepair, /insert into public\.profiles \(id, display_name, role, created_at\)/)
  assert.match(profileRepair, /'customer',[\s\S]+on conflict \(id\) do nothing/)
  assert.doesNotMatch(profileRepair, /raw_user_meta_data\s*->>\s*'role'/)
  assert.match(auth, /getCurrentSessionOnce\(\)/)
  assert.match(auth, /\.from\('orders'\)/)
  assert.match(auth, /renderAccountLibrary\(/)
  assert.match(auth, /export async function signOut\(\)[\s\S]+supabase\.auth\.signOut\(\)/)
  assert.equal((auth.match(/signInWithOAuth\(/g) || []).length, 1)
})

test('frontend contains no privileged Google or Supabase credential', async () => {
  const frontend = (await Promise.all([
    source('../assets/js/auth.js'),
    source('../assets/js/supabase-client.js'),
    source('../auth/login/index.html'),
    source('../auth/signup/index.html'),
  ])).join('\n')

  assert.doesNotMatch(frontend, /client[_ -]?secret/i)
  assert.doesNotMatch(frontend, /service[_ -]?role/i)
  assert.doesNotMatch(frontend, /supabase_service_role_key/i)
})
