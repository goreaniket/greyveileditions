import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  isValidDisplayName,
  normalizeDisplayName,
  SIGNUP_OUTCOMES,
  signupOutcomeFor,
  updateOwnDisplayName,
} from '../assets/js/auth-profile.js'

const profileClient = ({
  updateResponse = { data: { id: 'reader-1' }, error: null },
  profileResponse = { data: { id: 'reader-1', display_name: 'New Name', role: 'customer' }, error: null },
  metadataResponse = { data: { user: { id: 'reader-1', user_metadata: { display_name: 'New Name' } } }, error: null },
} = {}) => {
  const calls = []
  const responses = [updateResponse, profileResponse]
  const supabase = {
    from(table) {
      calls.push(['from', table])
      const builder = {
        update(value) {
          calls.push(['update', value])
          return builder
        },
        select(columns) {
          calls.push(['select', columns])
          return builder
        },
        eq(column, value) {
          calls.push(['eq', column, value])
          return builder
        },
        maybeSingle() {
          calls.push(['maybeSingle'])
          return Promise.resolve(responses.shift())
        },
      }
      return builder
    },
    auth: {
      updateUser(payload) {
        calls.push(['updateUser', payload])
        return Promise.resolve(metadataResponse)
      },
    },
  }
  return { calls, supabase }
}

test('confirmation-required signup treats a null session as expected success', () => {
  const user = { id: 'reader-1', identities: [{ id: 'identity-1' }] }
  const result = signupOutcomeFor({ data: { user, session: null }, error: null })

  assert.equal(result.outcome, SIGNUP_OUTCOMES.CONFIRMATION_REQUIRED)
  assert.equal(result.user, user)
  assert.equal(result.error, undefined)
})

test('successful email-confirmation signup cannot become a setup failure', () => {
  const result = signupOutcomeFor({
    data: { user: { id: 'reader-1' }, session: null },
  })

  assert.notEqual(result.outcome, SIGNUP_OUTCOMES.FAILED)
  assert.equal(result.outcome, SIGNUP_OUTCOMES.CONFIRMATION_REQUIRED)
})

test('signup errors remain failures and existing-account responses remain distinct', () => {
  const error = { code: 'unexpected_failure', message: 'Database error saving new user' }
  assert.deepEqual(signupOutcomeFor({ error }), {
    outcome: SIGNUP_OUTCOMES.FAILED,
    error,
  })
  assert.equal(signupOutcomeFor({
    data: { user: { id: 'masked-user', identities: [] }, session: null },
  }).outcome, SIGNUP_OUTCOMES.EXISTING_ACCOUNT)
})

test('display names are trimmed, normalized, and validated', () => {
  assert.equal(normalizeDisplayName('  Greyveil   Reader  '), 'Greyveil Reader')
  assert.equal(isValidDisplayName('   '), false)
  assert.equal(isValidDisplayName('A'), false)
  assert.equal(isValidDisplayName('Greyveil Reader'), true)
  assert.equal(isValidDisplayName(`Reader\u0000Name`), false)
})

test('own display-name update confirms one row, refetches the profile, and syncs metadata', async () => {
  const { calls, supabase } = profileClient()
  const result = await updateOwnDisplayName({
    supabase,
    user: { id: 'reader-1', user_metadata: {} },
    displayName: '  New   Name ',
  })

  assert.equal(result.ok, true)
  assert.equal(result.displayName, 'New Name')
  assert.equal(result.profile.role, 'customer')
  assert.deepEqual(calls.filter(([operation]) => operation === 'from'), [
    ['from', 'profiles'],
    ['from', 'profiles'],
  ])
  assert.deepEqual(calls.find(([operation]) => operation === 'update'), [
    'update',
    { display_name: 'New Name' },
  ])
  assert.deepEqual(calls.filter(([operation]) => operation === 'select').map(([, columns]) => columns), [
    'id',
    'id, display_name, role',
  ])
  assert.deepEqual(calls.find(([operation]) => operation === 'updateUser'), [
    'updateUser',
    { data: { display_name: 'New Name' } },
  ])
})

test('zero-row and denied display-name updates produce the correct failures', async () => {
  const missing = profileClient({ updateResponse: { data: null, error: null } })
  assert.equal((await updateOwnDisplayName({
    supabase: missing.supabase,
    user: { id: 'reader-1' },
    displayName: 'New Name',
  })).reason, 'profile-missing')

  const deniedError = { code: '42501', status: 403, message: 'new row violates row-level security policy' }
  const denied = profileClient({ updateResponse: { data: null, error: deniedError } })
  const deniedResult = await updateOwnDisplayName({
    supabase: denied.supabase,
    user: { id: 'reader-1' },
    displayName: 'New Name',
  })
  assert.equal(deniedResult.ok, false)
  assert.equal(deniedResult.reason, 'update-denied')
  assert.equal(deniedResult.error, deniedError)
})

test('display-name update requires an authenticated user and a valid name', async () => {
  const { supabase } = profileClient()
  assert.equal((await updateOwnDisplayName({
    supabase,
    user: null,
    displayName: 'New Name',
  })).reason, 'authentication-required')
  assert.equal((await updateOwnDisplayName({
    supabase,
    user: { id: 'reader-1' },
    displayName: ' ',
  })).reason, 'invalid-name')
})

test('Account and header consumers receive the refetched display-name state immediately', async () => {
  const [auth, main] = await Promise.all([
    readFile(new URL('../assets/js/auth.js', import.meta.url), 'utf8'),
    readFile(new URL('../assets/js/main.js', import.meta.url), 'utf8'),
  ])

  assert.match(auth, /activeProfile = result\.profile/)
  assert.match(auth, /nameNode\.textContent = result\.displayName/)
  assert.match(auth, /greyveil:profile-changed[\s\S]+profile: activeProfile[\s\S]+user: activeUser/)
  assert.match(main, /greyveil:profile-changed[\s\S]+renderProfileNav\(slot, nextUser, nextProfile, authModule\)/)
})

test('customer profile access cannot update roles or internal columns', async () => {
  const [repair, platform] = await Promise.all([
    readFile(new URL('../supabase/auth-profile-signup-repair.sql', import.meta.url), 'utf8'),
    readFile(new URL('../supabase/platform-architecture-upgrade.sql', import.meta.url), 'utf8'),
  ])

  assert.match(repair, /greyveil_guard_customer_profile_fields/)
  assert.match(repair, /to_jsonb\(new\) - 'display_name'/)
  assert.match(repair, /Customers may update only their display name/)
  assert.match(repair, /grant update \(display_name\) on public\.profiles to authenticated/)
  assert.match(repair, /greyveil_guard_profile_role/)
  assert.doesNotMatch(repair, /raw_user_meta_data\s*->>\s*'role'/)
  assert.match(platform, /if requester_role <> 'super_admin'[\s\S]+Only a super admin may change roles/)
  assert.match(platform, /before update of role on public\.profiles/)
})
