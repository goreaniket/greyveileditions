# Greyveil Editions CMS implementation — 21 November 2026

## Branch and baseline
- Base: `master`
- Feature branch: `feat/greyveil-cms-admin-20261121`
- Production branch and production deployment were not changed.

## Delivered
- Admin Dashboard tab: Website & Media.
- Page management: create, edit, draft, publish, archive, SEO title and description.
- Page sections: create, edit, order, publish/draft, attach images, and delete with confirmation.
- Homepage: renders published CMS-managed sections before the existing homepage content. Existing static homepage sections are preserved.
- Public CMS page route: `/cms-page.html?slug=<slug>`.
- Media library: upload, list, copy public image URL, and delete unreferenced images.
- Revision snapshots before page/section edits and before page archive.
- CMS audit log records for create/update/archive/delete/upload actions.

## Supabase
- Added `cms_pages`, `cms_sections`, `cms_media`, `cms_revisions`, and `cms_audit_logs`.
- RLS enabled on every new CMS table.
- Public access is read-only and limited to published pages/sections.
- Admin writes use the existing `public.greyveil_is_admin()` role helper.
- `cms-media` is a public image bucket, limited to JPG/PNG/WebP/GIF up to 25 MB; upload/update/delete require admin authorization.
- PDFs/EPUBs are intentionally excluded from the public CMS bucket and continue through the existing protected Books / Files system.

## Verification performed
- Verified all five CMS tables exist and RLS is enabled.
- Verified Homepage seed page exists as published.
- Verified CMS RLS policies and image-only storage MIME allowlist.
- Supabase performance advisor no longer flags duplicate permissive CMS SELECT policies. Remaining performance notices relate to pre-existing community/story/profile tables.
- Existing production catalogue, Reader Match data, orders, payments, book access, profiles, and community/story records were not changed.

## Not included in this implementation slice
- AI command execution: requires choosing/configuring an LLM provider and server-side API secret. No fake AI assistant was added.
- Navigation/footer visual builder and full theme/layout builder.
- Full generic private file vault; existing protected Books / Files remains the private document workflow.
- New role taxonomy, customer CRM expansion, and AI analytics actions.
- 439-situation Reader Match data source is not yet located; inspected repository copies still contain 96 matches. No recommendation data was changed.

## Deployment
A Vercel preview was requested from this feature branch. Use the deployment card/status and test authenticated admin flows before merging to `master`.

## Public collection implementation update — 21 November 2026
- Reworked `/projects/` as The Human Collection landing page.
- Added `/projects/journey/` with four reading stages, distinct from the four original series.
- Added `/projects/topics/` using the canonical topic index.
- Reworked `/projects/human-experience/` to present The Human Experience as original Series IV with all ten titles.
- Added shared `assets/js/collection-pages.js` to render the catalogue from the existing `catalogue.json`.
- Preserved the existing catalogue source exactly: 24 books, 96 Reader Match entries and 19 topics. No Reader Match rows or recommendation logic were changed.
- Corrected the homepage CMS script's relative Supabase client import.

## Critical release blockers discovered during validation
1. The current connected Supabase project is wired in `assets/js/supabase-client.js`, but its live schema does not contain the core commerce/catalogue tables expected by the current app: `books`, `series`, `collections`, `volumes`, `orders`, `payments`, `book_access`, `feedbacks`, `book_files`, and `book_covers`. Its Edge Functions list is empty. Do not run the historical broad SQL files against this project; the old project/data source must be reconciled first.
2. Previous Greyveil handoff records reference a different Supabase project. That project is not accessible through the currently connected Supabase accounts. Existing payment and entitlement history must not be recreated as empty tables.
3. Ten Human Experience PDFs are committed under `projects/human-experience/books/` and are directly accessible as `application/pdf` from the production domain. Their book pages explicitly link to them as “Read Book (PDF)”. This is a confirmed public-content exposure. Do not call the publishing platform release-safe until these PDFs are migrated to private `book-files` storage and the public links are replaced by the protected reader flow. Do not delete them before a verified private migration.
4. Owner Command Centre SQL is intentionally guarded: it requires the story RPC set plus `books`, `orders`, and `feedbacks`, and a separately verified owner Auth UUID. Those prerequisites are not met in the currently connected project.
5. AI Command Centre runtime is not yet implemented. Vercel AI Gateway currently has no configured spend budgets. Do not enable model calls until the owner approves a budget and the server-side command permissions are implemented.

## Current preview
- Latest preview deployment: https://greyveileditions-cvigt9ulb-goreanikets-projects.vercel.app
- Vercel deployment state: READY.
- Preview is not production. No merge or production deployment has been performed.
