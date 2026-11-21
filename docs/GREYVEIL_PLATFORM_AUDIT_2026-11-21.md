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
