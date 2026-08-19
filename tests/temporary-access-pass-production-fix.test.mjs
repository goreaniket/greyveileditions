import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const sql = await readFile(new URL('../supabase/temporary-access-pass-production-fix.sql', import.meta.url), 'utf8')

test('targeted pass migration preserves Book, Series, Collection, and adds only Pass order targets', () => {
  assert.match(sql, /purchase_type in \('book', 'series', 'collection', 'pass'\)/)
  assert.match(sql, /purchase_type = 'book'.*book_id is not null/s)
  assert.match(sql, /purchase_type = 'series'.*series_id is not null/s)
  assert.match(sql, /purchase_type = 'collection'.*collection_id is not null/s)
  assert.match(sql, /purchase_type = 'pass'.*temporary_access_pass_id is not null/s)
  assert.match(sql, /\) not valid;/)
  assert.doesNotMatch(sql, /update public\.(books|series|collections|orders|payments)/i)
  assert.doesNotMatch(sql, /delete from public\./i)
})

test('pass activation is paid-only, one-per-order, and server-expiring', () => {
  assert.match(sql, /create table if not exists public\.temporary_access_pass_activations/)
  assert.match(sql, /order_id uuid not null unique references public\.orders/)
  assert.match(sql, /new\.status is distinct from 'paid'/)
  assert.match(sql, /new\.purchase_type is distinct from 'pass'/)
  assert.match(sql, /activation_time \+ make_interval\(hours => pass_row\.duration_hours\)/)
  assert.match(sql, /on conflict \(order_id\) do nothing/)
})

test('Reader authorization adds scoped, expiring passes without removing existing access sources', () => {
  assert.match(sql, /effective_visibility = 'public'/)
  assert.match(sql, /viewer_role in \('admin', 'super_admin'\)/)
  assert.match(sql, /from public\.book_access access/)
  assert.match(sql, /paid_order\.purchase_type = 'book'/)
  assert.match(sql, /paid_order\.purchase_type = 'series'/)
  assert.match(sql, /paid_order\.purchase_type = 'collection'/)
  assert.match(sql, /activation\.user_id = target_user_id and activation\.expires_at > now\(\)/)
  assert.match(sql, /pass_row\.scope_type = 'library'/)
  assert.match(sql, /pass_row\.scope_type = 'collection' and pass_row\.collection_id = hierarchy\.resolved_collection_id/)
  assert.match(sql, /if target_user_id is null then allowed := false/)
})

test('RLS exposes only active offers, prevents self-grants, and allows Founder pass configuration', () => {
  assert.match(sql, /Public reads active temporary passes/)
  assert.match(sql, /for select to anon, authenticated using \(active or public\.greyveil_is_admin\(\)\)/)
  assert.match(sql, /Admins manage temporary passes/)
  assert.match(sql, /for all to authenticated using \(public\.greyveil_is_admin\(\)\) with check \(public\.greyveil_is_admin\(\)\)/)
  assert.match(sql, /Users and admins read pass activations/)
  assert.match(sql, /revoke insert, update, delete on public\.temporary_access_pass_activations from anon, authenticated/)
})
