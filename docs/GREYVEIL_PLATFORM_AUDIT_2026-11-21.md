# Greyveil Editions — Digital Platform Baseline Audit
Date: 21 November 2026
Working branch: `feat/digital-platform-command-centre-20261121`
Base branch: `greyveil-2-0-foundation`
Production branch: `master`

## Scope
Read-only inspection of the connected GitHub repository and the Supabase project referenced by the site's browser-safe Supabase client. No production files, database rows, schema, secrets, payment settings, storage objects, or deployment settings were changed during this audit.

## Confirmed application baseline
- Repository: `goreaniket/greyveileditions`; default branch: `master`.
- The application is a static HTML/CSS/ES-module site with page-specific directories and Supabase-backed modules; no root `package.json` was found at the checked branch.
- Existing protected admin entry: `/admin/`; existing Owner Command Centre route: `/admin/command-center/`.
- Existing admin source `assets/js/admin.js` is a large, active module (~177 KB) and references these public tables: `book_access`, `book_covers`, `book_files`, `books`, `collections`, `feedbacks`, `orders`, `payments`, `profiles`, `series`, and `volumes`.
- Homepage currently has 19 hard-coded section IDs in `index.html`; it is not yet a database-driven page builder.
- `catalogue.json` contains 24 books, 96 Reader Match records, and 19 topics on the inspected branches (`master`, `greyveil-2-0-foundation`, `feature/439-situations-audit`, and `feature/greyveil-reader-match-final`).

## Confirmed Supabase baseline
- Project: `greyveileditions`, ref `fanixwnyglkvkgsxxrtn`, status `ACTIVE_HEALTHY`, PostgreSQL 17.
- The site's `assets/js/supabase-client.js` points to this same project ref.
- The live `public` schema currently contains only 13 base tables:
  `community_comments`, `community_posts`, `community_requests`, `connect_enrollments`, `connect_offerings`, `contributor_applications`, `profiles`, `reader_reflections`, `story_internal_notes`, `story_publication_withdrawals`, `story_reports`, `story_responses`, `story_submissions`.
- The live schema does not currently contain the catalog, hierarchy, file, order, payment, or book-access tables referenced by the existing admin module.
- Three auth users exist. Existing profile role values are `reader` (2) and `super_admin` (1). Do not expand or rename roles until the actual authorization model and all RLS policies have been reconciled.
- Ten Supabase migration-history entries are present, but the live public schema does not match the tables expected by the repository's admin and commerce code.

## Critical discrepancies / blockers
1. **Database-to-application mismatch:** admin code references at least 11 public tables, while the live public schema currently exposes only the 13 community/story/profile tables above. This is a real integration blocker, not a UI-only issue.
2. **Reader Match count mismatch:** repository copies inspected contain 96 match records, not the 439 situations previously specified as protected project data. Treat the user's 439-record dataset as an unverified external/source-of-truth asset; do not overwrite it, regenerate it, or claim it is present in this repo.
3. **No CMS/page-builder backend:** homepage sections and page content are hard-coded in HTML. There is no confirmed CMS schema or dynamic publishing layer in the live public schema.
4. **Role model mismatch:** the requested expanded role list is not represented in the current `profiles.role` constraint. Authorization must remain server/database enforced and cannot be implemented by simply adding UI role labels.

## Safe implementation order
1. Locate and reconcile the authoritative source for the 439 Reader Match situations before touching catalogue/discovery data.
2. Reconcile the missing core catalog/commerce schema against the exact SQL history and expected production state. Do not run the repository's large SQL scripts blindly; some depend on base tables that are absent in the live database.
3. Build a CMS/page builder and media library as an isolated, permissioned module with drafts, previews, publish/archive, revisions, and audit logs.
4. Add AI command execution only through validated server-side operations with role checks, previews, confirmations for destructive changes, and an audit record.
5. Integrate users/customers, publishing, billing and reader modules only after their existing data contracts are verified.
6. Regression-test existing auth, catalogue, Reader Match, reader access, payment verification, entitlements, invoices, and admin before any production release.

## Branch and deployment state
- Created working branch: `feat/digital-platform-command-centre-20261121`, based on `greyveil-2-0-foundation`.
- No commit has yet been deployed.
- No production database migration or production deployment was run.
- Continue implementation on this feature branch; do not push changes directly to `master`.

## CMS implementation update — 21 November 2026
Implemented on the feature branch:
- Added `cms_pages`, `cms_sections`, `cms_media`, `cms_revisions`, and `cms_audit_logs`.
- Enabled RLS on all five CMS tables. Public reads are limited to published pages and published sections on published pages. Admin write access uses the existing `public.greyveil_is_admin()` helper.
- Added the public `cms-media` image bucket with a 25 MB limit and image-only MIME allowlist; storage writes/deletes are admin-only. PDFs/EPUBs are not accepted into this public bucket and remain in the existing protected Books / Files workflow.
- Added the Admin Dashboard Website & Media tab: page drafts/publishing/archive, homepage section creation/edit/publish/delete, media upload/list/copy URL/delete, revision snapshots, and audit entries.
- Added a public CMS page renderer at `/cms-page.html?slug=<slug>`.
- Added a homepage section mount that renders published CMS homepage sections above the existing static homepage. Existing homepage sections remain intact.
- Added the SQL source file at `supabase/greyveil-cms-command-centre.sql`.

Database execution:
- The additive CMS SQL was applied to the connected Supabase project.
- Verified all five `cms_*` tables exist.
- Verified the `cms-media` bucket exists and its allowed MIME types are image-only.
- No existing catalogue, Reader Match, orders, payments, book access, profiles or community/story data was modified.

Deployment:
- Preview deployment created from the feature branch and reached Vercel `READY`.
- Preview URL: https://greyveileditions-kgqh68lts-goreanikets-projects.vercel.app
- Production branch `master` was not changed and production was not deployed.

Known remaining scope:
- AI command execution is not wired to an LLM provider; it needs a chosen model provider and server-side secret/API configuration. No fake AI controls were added.
- Navigation/footer builder, general non-book private file vault, advanced customer CRM, role expansion, and full AI operations remain later modules.
- Existing admin modules for users, books, publishing, book access, payments, coupons, feedback, announcements and book files were left intact.
- Existing repository catalogue still exposes 96 Reader Match records on the inspected branch; the user's 439-record source remains to be located and reconciled before discovery changes.
- Preview URL is deployment-ready, but authenticated UI workflows still require an admin sign-in test in a browser. No claim is made that the complete platform is finished.
