import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const source = (path) => readFile(new URL(path, import.meta.url), 'utf8')

const functionBody = (sql, name) => {
  const match = sql.match(new RegExp(
    `create or replace function public\\.${name}\\b[\\s\\S]*?as \\$\\$([\\s\\S]*?)\\$\\$;`,
    'i',
  ))
  assert.ok(match, `Missing database function public.${name}().`)
  return match[1]
}

test('the redesigned application is the discoverable root entry point', async () => {
  const html = await source('../index.html')
  const heading = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1]
    ?.replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim()

  assert.equal(heading, "Welcome to everything we don't say.")
  assert.match(html, /Ideas\. Emotions\. Contradictions\. Stories\. The human experience\./)
  assert.match(html, /id="book-grid"/)
  assert.match(html, /id="concern-select"/)
  assert.match(html, /THE LIVING CANVAS/)
  assert.match(html, /WORDS THAT MOVE/)
  assert.match(html, /THE THOUGHT GALLERY/)
  assert.match(html, /A Quiet Corner/)
  assert.match(html, /Explore by feeling or question/i)
  assert.match(html, /LETTERS YOU DIDN'T KNOW YOU NEEDED/)
  assert.match(html, /A HUMAN TIMELINE/)
  assert.match(html, /href="#library">The Library/)
  assert.match(html, /href="#collective">The Collective/)
  assert.match(html, /href="#origin">The Origin/)
  assert.match(html, /href="\.\/greyveil-2-preview\/style\.css"/)
  assert.match(html, /src="\.\/greyveil-2-preview\/preview\.js"/)
  assert.match(html, /href="https:\/\/greyveileditions\.site\/"/)
  assert.doesNotMatch(html, /name="robots" content="noindex/i)
  assert.doesNotMatch(html, /PRIVATE DESIGN PREVIEW|Not deployed/i)
})

test('editorial typography and the Words That Move ticker respect accessibility preferences', async () => {
  const css = await source('../greyveil-2-preview/style.css')
  assert.match(css, /--sans: "Inter"/)
  assert.match(css, /"Manrope", Arial, sans-serif/)
  assert.match(css, /--mono: "IBM Plex Mono"/)
  assert.match(css, /@keyframes ticker-words/)
  assert.match(css, /prefers-reduced-motion: reduce[\s\S]*?\.ticker-track \{ animation: none; \}/)
})

test('story submissions are created only through an authenticated, validated RPC', async () => {
  const [sql, client] = await Promise.all([
    source('../supabase/greyveil-2-experience.sql'),
    source('../greyveil-2-preview/preview.js'),
  ])
  const submit = functionBody(sql, 'greyveil_submit_story')

  assert.match(sql, /create or replace function public\.greyveil_submit_story\([\s\S]*?\)\s*returns[\s\S]*?security definer/i)
  assert.match(submit, /auth\.uid\(\) is null/i)
  assert.match(submit, /char_length\(btrim\(p_title\)\) not between 1 and 120/i)
  assert.match(submit, /char_length\(btrim\(p_story\)\) not between 40 and 6000/i)
  assert.match(submit, /author_id[\s\S]*?auth\.uid\(\)/i)
  assert.match(submit, /private_consent[\s\S]*?true/i)
  assert.match(submit, /case when coalesce\(p_is_anonymous, true\) then null/i)
  assert.match(sql, /revoke all on function public\.greyveil_submit_story\([\s\S]*?\) from public, anon/i)
  assert.match(sql, /grant execute on function public\.greyveil_submit_story\([\s\S]*?\) to authenticated/i)
  assert.match(client, /supabaseClient\.rpc\('greyveil_submit_story'/)
  assert.doesNotMatch(client, /\.from\('story_submissions'\)\s*\.insert\(/)
})

test('private story tables use RLS and do not grant anonymous or direct author writes', async () => {
  const sql = await source('../supabase/greyveil-2-experience.sql')
  for (const table of [
    'story_submissions',
    'story_publication_withdrawals',
    'story_internal_notes',
    'story_responses',
    'story_reports',
  ]) {
    assert.match(sql, new RegExp(`alter table public\\.${table} enable row level security`, 'i'))
    assert.match(sql, new RegExp(`revoke all on public\\.${table} from public, anon`, 'i'))
  }

  assert.match(sql, /author_id = \(select auth\.uid\(\)\) or \(select public\.greyveil_is_admin\(\)\)/i)
  assert.match(sql, /grant select, delete on public\.story_submissions to authenticated/i)
  assert.match(sql, /revoke insert, update on public\.story_submissions from authenticated/i)
  assert.match(sql, /grant update \(read_at\) on public\.story_responses to authenticated/i)
  assert.match(sql, /create policy "Admins manage private story notes"[\s\S]*?public\.greyveil_is_admin\(\)/i)
})

test('responses and publication require administrator authorization and active consent', async () => {
  const sql = await source('../supabase/greyveil-2-experience.sql')
  const respond = functionBody(sql, 'greyveil_admin_respond_to_story')
  const moderate = functionBody(sql, 'greyveil_admin_update_story_status')
  const publicStories = functionBody(sql, 'get_public_greyveil_stories')

  assert.match(respond, /auth\.uid\(\) is null or not public\.greyveil_is_admin\(\)/i)
  assert.match(sql, /grant execute on function public\.greyveil_admin_respond_to_story\([\s\S]*?\) to authenticated/i)
  assert.match(moderate, /auth\.uid\(\) is null or not public\.greyveil_is_admin\(\)/i)
  assert.match(moderate, /not story_public_consent or story_publication_withdrawn/i)
  assert.match(sql, /story_published_at_matches_status[\s\S]*?status = 'published'[\s\S]*?published_at is not null/i)
  assert.match(publicStories, /s\.status = 'published'/i)
  assert.match(publicStories, /s\.public_consent is true/i)
  assert.match(publicStories, /s\.published_at is not null/i)
  assert.match(publicStories, /not exists[\s\S]*?story_publication_withdrawals/i)
  assert.doesNotMatch(publicStories, /s\.author_id|story_responses|story_internal_notes/i)
  assert.match(sql, /revoke all on function public\.get_public_greyveil_stories\(\) from public/i)
})

test('catalogue and existing account, payment, and reader entry points remain connected', async () => {
  const [catalogueText, html, client] = await Promise.all([
    source('../catalogue.json'),
    source('../index.html'),
    source('../greyveil-2-preview/preview.js'),
  ])
  const catalogue = JSON.parse(catalogueText)

  assert.equal(catalogue.books.length, 24)
  assert.ok(catalogue.matches.length > 0)
  assert.match(html, /href="https:\/\/greyveileditions\.site\/auth\/login\/"/)
  assert.match(html, /href="https:\/\/greyveileditions\.site\/account\/"/)
  assert.match(html, /href="https:\/\/greyveileditions\.site\/checkout\/"/)
  assert.match(client, /greyveil-2-preview:shelf/)
  assert.match(client, /greyveil-2-preview:lines/)
  assert.match(client, /writeLocalList\(LINES_KEY/)
  assert.match(client, /concern-select/)
})

test('the privacy policy is reachable from the homepage and documents private story handling', async () => {
  const [homepage, policy] = await Promise.all([
    source('../index.html'),
    source('../privacy/index.html'),
  ])
  assert.match(homepage, /href="https:\/\/greyveileditions\.site\/privacy\/"/)
  assert.match(policy, /anonymous.*public byline only/i)
  assert.match(policy, /separately grant public-sharing permission/i)
  assert.match(policy, /not synced to your Greyveil account/i)
})
