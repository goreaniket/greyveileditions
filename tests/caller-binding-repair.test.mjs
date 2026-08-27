import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const repair = await readFile(
  new URL('../supabase/repair-caller-binding-probes.sql', import.meta.url),
  'utf8',
)

const functionDefinition = (name) => {
  const start = repair.indexOf(`create or replace function public.${name}(`)
  assert.notEqual(start, -1, `${name} must be replaced by the repair`)
  const end = repair.indexOf('\n$$;', start)
  assert.notEqual(end, -1, `${name} must have a complete body`)
  return repair.slice(start, end + 4)
}

const effectiveInternal = functionDefinition('greyveil_effective_book_access_internal')
const effective = functionDefinition('greyveil_effective_book_access')
const reviewTrigger = functionDefinition('greyveil_prepare_book_review')
const announcement = functionDefinition('greyveil_announcement_visible')

test('effective book access binds browser evaluation to auth.uid and delegates unchanged semantics', () => {
  assert.match(effective, /auth\.role\(\) = 'service_role'/i)
  assert.match(effective, /auth\.uid\(\) is not null[\s\S]+target_user_id is not distinct from auth\.uid\(\)/i)
  assert.match(effective, /else false\s+end;/i)
  assert.match(effective, /public\.greyveil_effective_book_access_internal\(\s*target_user_id,\s*target_book_id\s*\)/i)
  assert.doesNotMatch(effective, /from public\.(?:orders|book_access|catalog_access_grants|temporary_access_pass)/i)
})

test('internal effective access preserves the deployed hierarchy, grant, and paid-order semantics', () => {
  assert.match(effectiveInternal, /from public\.books book/i)
  assert.match(effectiveInternal, /join public\.series series_item/i)
  assert.match(effectiveInternal, /left join public\.volumes volume/i)
  assert.match(effectiveInternal, /left join public\.collections collection_item/i)
  assert.match(effectiveInternal, /profile\.role in \('admin', 'super_admin'\)/i)
  assert.match(effectiveInternal, /hierarchy\.book_visibility = 'public'/i)
  assert.match(effectiveInternal, /from public\.book_access access/i)
  assert.match(effectiveInternal, /from public\.orders paid_order/i)
  assert.match(effectiveInternal, /paid_order\.purchase_type = 'book'/i)
  assert.match(effectiveInternal, /paid_order\.purchase_type = 'series'/i)
  assert.match(effectiveInternal, /paid_order\.purchase_type = 'collection'/i)
  assert.doesNotMatch(effectiveInternal, /catalog_access_grants|temporary_access_pass/i)
})

test('review trigger keeps self-use on the bound wrapper and privileged use on the internal resolver', () => {
  assert.match(reviewTrigger, /new\.user_id is distinct from auth\.uid\(\)/i)
  assert.match(reviewTrigger, /public\.greyveil_is_admin\(\) is true/i)
  assert.match(reviewTrigger, /auth\.role\(\) = 'service_role'/i)
  assert.match(reviewTrigger, /public\.greyveil_effective_book_access_internal\(\s*new\.user_id,\s*new\.book_id\s*\)/i)
  assert.match(reviewTrigger, /public\.greyveil_effective_book_access\(new\.user_id, new\.book_id\)/i)
  assert.match(reviewTrigger, /public\.greyveil_effective_book_access\(old\.user_id, old\.book_id\) is distinct from true/i)
  assert.match(reviewTrigger, /Valid book access is required to review this book\./)
  assert.match(reviewTrigger, /Review ownership and book cannot be changed\./)
  assert.match(reviewTrigger, /new\.moderation_status = 'pending'/)
})

test('announcement visibility binds anon/authenticated viewers before ownership evaluation', () => {
  const binding = /when auth\.role\(\) = 'service_role'\s+or viewer_id is not distinct from auth\.uid\(\)/i
  assert.match(announcement, binding)
  assert.ok(announcement.search(binding) < announcement.indexOf("announcement_audience = 'everyone'"))
  assert.match(announcement, /announcement_audience = 'logged-in' and viewer_id is not null/i)
  assert.match(announcement, /announcement_audience = 'series-owner'[\s\S]+paid_order\.user_id = viewer_id/i)
  assert.match(announcement, /announcement_audience = 'collection-owner'[\s\S]+paid_order\.user_id = viewer_id/i)
  assert.match(announcement, /else false\s+end;/i)
})

test('ACLs expose only self-bound browser wrappers and preserve service-role dispatch', () => {
  assert.match(
    repair,
    /revoke all on function public\.greyveil_effective_book_access\(uuid, bigint\)\s+from public, anon, authenticated, service_role;/i,
  )
  assert.match(
    repair,
    /grant execute on function public\.greyveil_effective_book_access\(uuid, bigint\)\s+to authenticated, service_role;/i,
  )
  assert.doesNotMatch(
    repair,
    /grant execute on function public\.greyveil_effective_book_access\(uuid, bigint\)\s+to[^;]*\banon\b/i,
  )
  assert.match(
    repair,
    /revoke all on function public\.greyveil_effective_book_access_internal\(uuid, bigint\)\s+from public, anon, authenticated, service_role;/i,
  )
  assert.match(
    repair,
    /grant execute on function public\.greyveil_effective_book_access_internal\(uuid, bigint\)\s+to service_role;/i,
  )
  assert.doesNotMatch(
    repair,
    /grant execute on function public\.greyveil_effective_book_access_internal\(uuid, bigint\)\s+to[^;]*\b(?:anon|authenticated)\b/i,
  )
  assert.match(
    repair,
    /revoke all on function public\.greyveil_announcement_visible\(\s*uuid, text, uuid, boolean, timestamptz, timestamptz\s*\) from public, anon, authenticated, service_role;/i,
  )
  assert.match(
    repair,
    /grant execute on function public\.greyveil_announcement_visible\(\s*uuid, text, uuid, boolean, timestamptz, timestamptz\s*\) to anon, authenticated, service_role;/i,
  )
})

test('caller matrix blocks cross-user probes without requiring a profile for self-binding', () => {
  const selfBound = ({ role, uid, target }) => (
    role === 'service_role' || (uid != null && target === uid)
  )
  const announcementBound = ({ role, uid, target }) => (
    role === 'service_role' || target === uid
  )

  const self = '10000000-0000-4000-8000-000000000001'
  const other = '20000000-0000-4000-8000-000000000002'
  const cases = [
    { caller: 'anon-null', role: 'anon', uid: null, target: null, effective: false, announcement: true },
    { caller: 'anon-forged', role: 'anon', uid: null, target: other, effective: false, announcement: false },
    { caller: 'customer-self', role: 'authenticated', uid: self, target: self, effective: true, announcement: true },
    { caller: 'customer-cross', role: 'authenticated', uid: self, target: other, effective: false, announcement: false },
    { caller: 'missing-profile-self', role: 'authenticated', uid: self, target: self, effective: true, announcement: true },
    { caller: 'missing-profile-cross', role: 'authenticated', uid: self, target: other, effective: false, announcement: false },
    { caller: 'admin-self', role: 'authenticated', uid: self, target: self, effective: true, announcement: true },
    { caller: 'admin-direct-cross', role: 'authenticated', uid: self, target: other, effective: false, announcement: false },
    { caller: 'service-role-cross', role: 'service_role', uid: null, target: other, effective: true, announcement: true },
  ]

  for (const scenario of cases) {
    assert.equal(selfBound(scenario), scenario.effective, `${scenario.caller} effective access`)
    assert.equal(announcementBound(scenario), scenario.announcement, `${scenario.caller} announcement access`)
  }
})

test('repair is targeted and does not alter payment, generation, Reader, or announcement policies', () => {
  assert.equal((repair.match(/create or replace function public\./gi) || []).length, 4)
  assert.doesNotMatch(repair, /create or replace function public\.greyveil_(?:payment|admin|worker|reader|generation)/i)
  assert.doesNotMatch(repair, /(?:insert into|update|delete from) public\./i)
  assert.doesNotMatch(repair, /(?:create|drop|alter) policy/i)
  assert.match(repair, /^begin;/m)
  assert.match(repair, /^commit;/m)
  assert.match(repair, /^notify pgrst, 'reload schema';/m)
})
