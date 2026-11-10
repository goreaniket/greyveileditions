import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const source = (path) => readFile(new URL(path, import.meta.url), 'utf8')

test('Owner access is provisioned only from an explicit verified identity', async () => {
  const sql = await source('../supabase/greyveil-owner-command-center.sql')
  assert.match(sql, /user_id uuid not null unique references auth\.users\(id\)/i)
  assert.match(sql, /current_setting\('greyveil\.owner_user_id', true\)/i)
  assert.match(sql, /Lalit''s verified auth\.users UUID/i)
  assert.match(sql, /owner replacement requires a separately approved operation/i)
  assert.match(sql, /role_name := 'owner'/i)
  assert.match(sql, /role_permissions := '\["\*"\]'/i)
  assert.doesNotMatch(sql, /insert into public\.greyveil_owner_identity[\s\S]{0,80}values\s*\(\s*true\s*,\s*auth\.uid/i)
})

test('Human Response RLS removes legacy admin access and gates staff story access with MFA', async () => {
  const sql = await source('../supabase/greyveil-owner-command-center.sql')
  assert.match(sql, /for policy_row in[\s\S]*?drop policy %I on public\.%I/i)
  assert.match(sql, /greyveil_command_center_has_story_access\(p_story_id uuid\)[\s\S]*?aal2/i)
  assert.match(sql, /author_id = \(select auth\.uid\(\)\) or[\s\S]*?greyveil_command_center_has_story_access\(id\)/i)
  assert.match(sql, /revoke all on public\.story_internal_notes from public, anon, authenticated/i)
  assert.match(sql, /revoke all on public\.story_reports from public, anon, authenticated/i)
  assert.match(sql, /revoke all on function public\.greyveil_admin_respond_to_story\([\s\S]*?from public, anon, authenticated/i)
  assert.match(sql, /revoke all on function public\.greyveil_admin_update_story_status\(uuid, text\) from public, anon, authenticated/i)
  assert.match(sql, /case when s\.is_anonymous then null else s\.author_id end/i)
  assert.match(sql, /case when s\.is_anonymous then null else u\.email end/i)
})

test('privileged RPCs require explicit permissions and MFA, and private story reads are audited', async () => {
  const sql = await source('../supabase/greyveil-owner-command-center.sql')
  assert.match(sql, /greyveil_command_center_require\([\s\S]*?p_require_mfa boolean default true/i)
  assert.match(sql, /auth\.jwt\(\) ->> 'aal'.*'aal2'/i)
  assert.match(sql, /human\.private_conversation\.viewed/i)
  assert.match(sql, /staff\.invitation\.sent/i)
  assert.match(sql, /human\.response\.sent/i)
  assert.match(sql, /staff\.access\.revoked/i)
})

test('command-centre browser routes expose only assigned role navigation and do not query private tables directly', async () => {
  const [html, client] = await Promise.all([
    source('../admin/command-center/index.html'),
    source('../assets/js/owner-command-center.js'),
  ])
  for (const [view, permission] of [
    ['overview', 'analytics.read'],
    ['inbox', 'human.inbox.read'],
    ['readers', 'users.read'],
    ['team', 'staff.read'],
    ['moderation', 'moderation.read'],
    ['security', 'audit.read'],
  ]) {
    assert.match(html, new RegExp(`data-view="${view}" data-permission="${permission}"`))
  }
  assert.match(client, /supabase\.auth\.mfa\.getAuthenticatorAssuranceLevel/)
  assert.match(client, /supabase\.auth\.mfa\.challengeAndVerify/)
  assert.match(client, /greyveil_command_center_story/)
  assert.match(client, /greyveil_command_center_respond/)
  assert.doesNotMatch(client, /\.from\(['"]story_(?:submissions|responses|internal_notes)['"]\)/)
  assert.match(html, /data-invite-form/)
})

test('staff invitation endpoint checks identity and MFA authorization before privileged Auth actions', async () => {
  const [endpoint, accept, config] = await Promise.all([
    source('../supabase/functions/invite-command-center-staff/index.ts'),
    source('../assets/js/accept-staff-invite.js'),
    source('../supabase/config.toml'),
  ])
  const permissionCheck = endpoint.indexOf("p_permission: 'staff.manage'")
  const inviteCall = endpoint.indexOf('admin.auth.admin.inviteUserByEmail')
  assert.ok(permissionCheck >= 0 && inviteCall > permissionCheck)
  assert.match(endpoint, /p_require_mfa: true/)
  assert.match(endpoint, /greyveil_staff_access/)
  assert.match(endpoint, /greyveil_command_audit/)
  assert.match(endpoint, /\/auth\/accept-invite\//)
  assert.match(accept, /verifyOtp\(\{ token_hash: tokenHash, type: 'invite' \}\)/)
  assert.match(accept, /supabase\.auth\.updateUser\(\{ password \}\)/)
  assert.match(config, /\[functions\.invite-command-center-staff\]\s+verify_jwt = true/)
})
