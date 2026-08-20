import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const source = (path) => readFile(new URL(path, import.meta.url), 'utf8')
const priceSql = await source('../supabase/repair-admin-catalog-price-rpc.sql')
const visibilitySql = await source('../supabase/repair-admin-catalog-visibility-rpc.sql')

const normalized = (value) => value == null ? null : String(value).trim().toLowerCase()
const supportedTarget = (value) => ['book', 'series', 'collection'].includes(normalized(value))
const supportedVisibility = (value) => ['public', 'paid', 'private'].includes(normalized(value))

const functionBody = (sql) => sql.match(/as \$\$([\s\S]*?)\$\$;/)?.[1] || ''

test('price RPC normalizes every supported catalog target before dispatch', () => {
  assert.match(priceSql, /normalized_target_type text := lower\(btrim\(target_type\)\)/)
  assert.match(priceSql, /if normalized_target_type = 'book'/)
  assert.match(priceSql, /elsif normalized_target_type = 'series'/)
  assert.match(priceSql, /elsif normalized_target_type = 'collection'/)
  assert.doesNotMatch(priceSql, /(?:if|elsif) target_type =/)

  for (const value of ['book', 'BOOK', ' Book ', 'book ', ' BoOk', 'series', ' SERIES ', 'collection', ' CoLlEcTiOn ']) {
    assert.equal(supportedTarget(value), true, `${JSON.stringify(value)} must resolve to a supported target`)
  }
  for (const value of [null, '', '   ', 'volume', 'book-series']) {
    assert.equal(supportedTarget(value), false, `${JSON.stringify(value)} must be rejected`)
  }
})

test('price RPC preserves positive integer paise validation and target-specific ID parsing', () => {
  assert.match(priceSql, /new_price_amount is null or new_price_amount <= 0/)
  assert.match(priceSql, /where id = target_id::bigint/)
  assert.equal((priceSql.match(/where id = target_id::uuid/g) || []).length, 2)
  assert.match(priceSql, /raise exception 'Unsupported catalog target\.'/)
  assert.match(priceSql, /if not found then[\s\S]+Catalog target was not found\./)

  const acceptedPrice = (value) => Number.isInteger(value) && value > 0
  for (const value of [null, 0, -1, -9900]) assert.equal(acceptedPrice(value), false)
  for (const value of [1, 100, 14900]) assert.equal(acceptedPrice(value), true)
})

test('visibility RPC normalizes valid values and rejects null or invalid input in its own guard', () => {
  assert.match(visibilitySql, /normalized_visibility text := lower\(btrim\(new_visibility\)\)/)
  assert.match(visibilitySql, /if normalized_visibility is null\s+or normalized_visibility not in \('public', 'paid', 'private'\) then/)
  assert.match(visibilitySql, /raise exception 'Unsupported visibility\.'/)

  for (const value of ['public', 'PUBLIC', ' paid ', 'private']) assert.equal(supportedVisibility(value), true)
  for (const value of [null, '', '   ', 'unlisted']) assert.equal(supportedVisibility(value), false)
})

test('visibility RPC keeps Book legacy-public synchronization and parent updates narrow', () => {
  assert.match(visibilitySql, /update public\.books\s+set visibility = normalized_visibility,\s+is_public = normalized_visibility = 'public'/)
  assert.match(visibilitySql, /update public\.series\s+set visibility = normalized_visibility/)
  assert.match(visibilitySql, /update public\.collections\s+set visibility = normalized_visibility/)

  const bookPublicFlag = (value) => normalized(value) === 'public'
  assert.equal(bookPublicFlag('public'), true)
  assert.equal(bookPublicFlag(' paid '), false)
  assert.equal(bookPublicFlag('private'), false)
})

test('both RPCs preserve Admin-only SECURITY DEFINER boundaries and catalog-only side effects', () => {
  for (const sql of [priceSql, visibilitySql]) {
    assert.match(sql, /language plpgsql\s+security definer\s+set search_path = public/)
    assert.match(sql, /if not public\.greyveil_is_admin\(\) then/)
    assert.match(sql, /Admin access required\.' using errcode = '42501'/)
    assert.match(sql, /revoke all on function public\./)
    assert.match(sql, /grant execute on function public\.[^(]+\([^;]+\) to authenticated/)
  }

  const priceBody = functionBody(priceSql)
  const visibilityBody = functionBody(visibilitySql)
  assert.deepEqual([...priceBody.matchAll(/update public\.([a-z_]+)/g)].map((match) => match[1]), ['books', 'series', 'collections'])
  assert.deepEqual([...visibilityBody.matchAll(/update public\.([a-z_]+)/g)].map((match) => match[1]), ['books', 'series', 'collections'])
  for (const body of [priceBody, visibilityBody]) {
    assert.doesNotMatch(body, /generation|publish|reader|orders|entitlement|temporary_access_pass|razorpay|manuscript|storage/i)
  }
})
