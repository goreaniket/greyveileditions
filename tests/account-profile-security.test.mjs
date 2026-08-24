import assert from 'node:assert/strict'
import { access, readFile } from 'node:fs/promises'
import test from 'node:test'

const source = (path) => readFile(new URL(path, import.meta.url), 'utf8')

test('Account uses one first-positioned Profile & Security card with the required control order', async () => {
  const html = await source('../account/index.html')
  const main = html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/)?.[1] || ''
  const topLevelOrder = [
    main.indexOf('account-profile-section'),
    main.indexOf('data-account-overview'),
    main.indexOf('data-account-library'),
    main.indexOf('id="one-day-access"'),
    main.indexOf('data-account-payments'),
  ]
  const profileCard = main.match(/<article\b[^>]*data-auth-view[^>]*>([\s\S]*?)<\/article>/)?.[1] || ''
  const profileControlOrder = [
    profileCard.indexOf('data-account-email'),
    profileCard.indexOf('id="account-display-name"'),
    profileCard.indexOf('>Save name<'),
    profileCard.indexOf('data-account-password-action'),
    profileCard.indexOf('data-account-actions'),
    profileCard.indexOf('data-logout-button'),
  ]

  assert.ok(topLevelOrder.every((position) => position >= 0), 'all Account content sections exist')
  assert.deepEqual([...topLevelOrder].sort((a, b) => a - b), topLevelOrder)
  assert.ok(profileControlOrder.every((position) => position >= 0), 'all profile controls exist')
  assert.deepEqual([...profileControlOrder].sort((a, b) => a - b), profileControlOrder)
  assert.equal((main.match(/contact-card feedback-form auth-card/g) || []).length, 1)
  assert.doesNotMatch(main, /account-security-section|data-account-security-view/)
  assert.match(profileCard, /data-account-password-action hidden/)
  assert.match(profileCard, /data-account-password-action[\s\S]*href="\/forgot-password\/"[\s\S]*>Reset password<[\s\S]*data-account-actions[\s\S]*data-logout-button/)
  assert.doesNotMatch(profileCard, /Signed in with Google|Password managed by Google|No password available/i)
})

test('Account toggles the complete password action from Supabase user identities', async () => {
  const auth = await source('../assets/js/auth.js')

  assert.match(auth, /passwordAction = document\.querySelector\('\[data-account-password-action\]'\)/)
  assert.match(auth, /passwordAction\.hidden = !hasPasswordIdentity\(currentUser\)/)
  assert.doesNotMatch(auth, /securityView|data-account-security-view/)
  assert.doesNotMatch(auth, /(?:localStorage|sessionStorage)[\s\S]{0,120}(?:provider|identity)/i)
})

test('Admin Portal remains role-gated and is inserted immediately before Sign out', async () => {
  const auth = await source('../assets/js/auth.js')

  assert.match(auth, /if \(!accountActions \|\| !isAdminRole\(role\)\) return/)
  assert.match(auth, /link\.textContent = 'Admin Portal'/)
  assert.match(auth, /accountActions\.insertBefore\(link, logoutButton\)/)
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

test('Account desktop and mobile share DOM order without adding a dependency or frontend secret', async () => {
  const [css, auth, authProfile] = await Promise.all([
    source('../assets/css/style.css'),
    source('../assets/js/auth.js'),
    source('../assets/js/auth-profile.js'),
  ])
  const frontend = `${auth}\n${authProfile}`

  assert.match(css, /\[hidden\]\s*{\s*display:\s*none\s*!important;/)
  assert.match(css, /@media \(max-width: 640px\)[\s\S]*\.account-security-action\s*{[\s\S]*flex-direction:\s*column;/)
  assert.match(css, /@media \(max-width: 560px\)[\s\S]*\.account-profile-section \.contact-actions \.button\s*{\s*width:\s*100%;/)
  assert.doesNotMatch(css, /account-(?:profile|overview|library|pass|payments|security)[^{]*{[^}]*\border\s*:/i)
  assert.doesNotMatch(frontend, /client[_ -]?secret|supabase_service_role_key/i)
  assert.doesNotMatch(authProfile, /^import\s/m)
  await assert.rejects(access(new URL('../package.json', import.meta.url)))
})
