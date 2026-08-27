import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const repair = await readFile(
  new URL('../supabase/repair-security-definer-admin-guards.sql', import.meta.url),
  'utf8',
)

const rpcSignatures = [
  'greyveil_admin_create_generation_job(bigint)',
  'greyveil_admin_request_generation_detection(uuid, text, text)',
  'greyveil_admin_cancel_generation_job(uuid)',
  'greyveil_admin_publish_generation_job(uuid)',
  'greyveil_admin_update_catalog_price(text, text, integer)',
  'greyveil_admin_update_catalog_visibility(text, text, text)',
  'greyveil_admin_set_book_series(bigint, uuid)',
  'greyveil_admin_set_series_collection(uuid, uuid)',
  'greyveil_admin_payment_customers()',
]

const helperSignatures = [
  'greyveil_current_role()',
  'greyveil_is_admin()',
  'greyveil_is_super_admin()',
]

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const functionDefinition = (name) => {
  const start = repair.indexOf(`create or replace function public.${name}(`)
  assert.notEqual(start, -1, `${name} must be replaced by the targeted repair`)
  const end = repair.indexOf('\n$$;', start)
  assert.notEqual(end, -1, `${name} must have a complete dollar-quoted body`)
  return repair.slice(start, end + 4)
}

const sqlAdminPredicate = (profileRole) => {
  if (profileRole == null) return null
  return ['admin', 'super_admin'].includes(profileRole)
}

const guardAllows = (profileRole) => sqlAdminPredicate(profileRole) === true

test('all nine canonical Admin RPCs use a fail-closed guard before protected work', () => {
  assert.equal((repair.match(/create or replace function public\.greyveil_admin_/g) || []).length, 9)

  const firstProtectedStatement = new Map([
    ['greyveil_admin_create_generation_job', 'if target_book_id is not null'],
    ['greyveil_admin_request_generation_detection', "if target_manuscript_path !~"],
    ['greyveil_admin_cancel_generation_job', 'update public.book_generation_jobs'],
    ['greyveil_admin_publish_generation_job', 'select * into job'],
    ['greyveil_admin_update_catalog_price', 'if new_price_amount is null'],
    ['greyveil_admin_update_catalog_visibility', 'if normalized_visibility is null'],
    ['greyveil_admin_set_book_series', 'update public.books'],
    ['greyveil_admin_set_series_collection', 'update public.series'],
    ['greyveil_admin_payment_customers', 'return query'],
  ])

  for (const name of firstProtectedStatement.keys()) {
    const definition = functionDefinition(name)
    const guard = 'if public.greyveil_is_admin() is distinct from true then'
    assert.equal((definition.match(/is distinct from true/g) || []).length, 1, `${name} must have one NULL-safe guard`)
    assert.ok(definition.indexOf(guard) < definition.indexOf(firstProtectedStatement.get(name)), `${name} must authorize first`)
    assert.match(definition, /raise exception 'Admin access required\.' using errcode = '42501'/)
    assert.doesNotMatch(definition, /if not public\.greyveil_is_admin\(\)/i)
    assert.match(definition, /security definer\s+set search_path = (?:public|''?)/i)
  }
})

test('Admin RPC ACLs deny PUBLIC and anon while preserving authenticated dispatch', () => {
  for (const signature of rpcSignatures) {
    const escaped = escapeRegex(signature)
    assert.match(
      repair,
      new RegExp(`revoke all on function public\\.${escaped} from public, anon, authenticated;`, 'i'),
      `${signature} must have its inherited and explicit client ACLs reset`,
    )
    assert.match(
      repair,
      new RegExp(`grant execute on function public\\.${escaped} to authenticated;`, 'i'),
      `${signature} must remain callable by authenticated Admin and Super Admin sessions`,
    )
    assert.doesNotMatch(
      repair,
      new RegExp(`grant execute on function public\\.${escaped} to (?:public|anon);`, 'i'),
    )
  }
})

test('role helpers lose unintended PUBLIC execution and remain available to authenticated policies', () => {
  for (const signature of helperSignatures) {
    const escaped = escapeRegex(signature)
    assert.match(repair, new RegExp(`revoke all on function public\\.${escaped} from public, anon, authenticated;`, 'i'))
    assert.match(repair, new RegExp(`grant execute on function public\\.${escaped} to authenticated;`, 'i'))
    assert.doesNotMatch(repair, new RegExp(`grant execute on function public\\.${escaped} to (?:public|anon);`, 'i'))
  }
})

test('authorization matrix denies anon, customers, and missing profiles but permits both Admin roles', () => {
  const cases = [
    { caller: 'anon', profileRole: null, allowed: false },
    { caller: 'customer', profileRole: 'customer', allowed: false },
    { caller: 'missing-profile', profileRole: undefined, allowed: false },
    { caller: 'admin', profileRole: 'admin', allowed: true },
    { caller: 'super_admin', profileRole: 'super_admin', allowed: true },
  ]

  for (const scenario of cases) {
    assert.equal(guardAllows(scenario.profileRole), scenario.allowed, scenario.caller)
  }
})

test('repair stays within the audited Admin RPC and helper ACL scope', () => {
  assert.doesNotMatch(repair, /create or replace function public\.greyveil_(?:worker|reader|resolve|effective|announcement)/i)
  assert.doesNotMatch(repair, /temporary_access_pass|book_access|catalog_access_grants|razorpay|paymentCaptured|markOrder/i)
  assert.match(repair, /^begin;/m)
  assert.match(repair, /^commit;/m)
})
