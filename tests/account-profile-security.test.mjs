import assert from 'node:assert/strict'
import { access, readFile } from 'node:fs/promises'
import test from 'node:test'

const source = (path) => readFile(new URL(path, import.meta.url), 'utf8')

test('Account groups profile controls first and keeps security and sign out in order', async () => {
  const html = await source('../account/index.html')
  const profileCard = html.match(/<article\b[^>]*data-auth-view[^>]*>([\s\S]*?)<\/article>/)?.[1] || ''
  const positions = [
    profileCard.indexOf('data-account-email'),
    profileCard.indexOf('id="account-display-name"'),
    profileCard.indexOf('>Save name<'),
    profileCard.indexOf('data-account-password-action'),
    profileCard.indexOf('data-logout-button'),
  ]

  assert.ok(positions.every((position) => position >= 0), 'all Profile & Security controls exist')
  assert.deepEqual([...positions].sort((a, b) => a - b), positions)
  assert.match(profileCard, /data-account-password-action hidden/)
  assert.match(profileCard, /data-account-password-action[\s\S]*href="\/forgot-password\/"[\s\S]*>Reset password</)
  assert.doesNotMatch(profileCard, /Signed in with Google|Password managed by Google|No password available/i)
})

test('Account toggles the complete password action from Supabase user identities', async () => {
  const auth = await source('../assets/js/auth.js')

  assert.match(auth, /passwordAction = document\.querySelector\('\[data-account-password-action\]'\)/)
  assert.match(auth, /passwordAction\.hidden = !hasPasswordIdentity\(currentUser\)/)
  assert.doesNotMatch(auth, /(?:localStorage|sessionStorage)[\s\S]{0,120}(?:provider|identity)/i)
})

test('password reset flow remains the existing secure Supabase email flow', async () => {
  const [auth, forgot] = await Promise.all([
    source('../assets/js/auth.js'),
    source('../forgot-password/index.html'),
  ])

  assert.match(forgot, /data-forgot-password-form/)
  assert.match(auth, /supabase\.auth\.resetPasswordForEmail\(email,\s*{\s*redirectTo: resetPasswordRedirectUrl\(\)/)
  assert.match(auth, /if \(page === 'forgot-password'\) initForgotPasswordPage\(\)/)
})

test('Account password hiding stays responsive and adds no dependency or frontend secret', async () => {
  const [css, auth, authProfile] = await Promise.all([
    source('../assets/css/style.css'),
    source('../assets/js/auth.js'),
    source('../assets/js/auth-profile.js'),
  ])
  const frontend = `${auth}\n${authProfile}`

  assert.match(css, /\[hidden\]\s*{\s*display:\s*none\s*!important;/)
  assert.match(css, /@media \(max-width: 640px\)[\s\S]*\.account-security-action\s*{[\s\S]*flex-direction:\s*column;/)
  assert.doesNotMatch(frontend, /client[_ -]?secret|supabase_service_role_key/i)
  assert.doesNotMatch(authProfile, /^import\s/m)
  await assert.rejects(access(new URL('../package.json', import.meta.url)))
})
