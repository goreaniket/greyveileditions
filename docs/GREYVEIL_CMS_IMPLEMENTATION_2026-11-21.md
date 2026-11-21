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
