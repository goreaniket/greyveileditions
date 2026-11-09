# Greyveil Editions 2.0 — Architecture & Preservation Plan

Status: implementation baseline, 9 November 2026
Repository: `goreaniket/greyveiledtions`
Working branch: `greyveil-2-0-foundation`
Baseline commit: `f2df11da976cdf53d3eee8a9ec035bd61b7c1c66`

## Product direction

Greyveil Editions 2.0 is to evolve from a conventional publishing/catalogue website into a premium, human-centred literary experience. It must remain an editorial and publishing platform first: books, ideas, reading, reflection, discovery and meaningful reader connection. It must not become a generic wellness app, social feed, AI-diagnosis product or generic startup landing page.

## Verified existing foundations

- Static HTML/CSS/ES-module website with shared assets and page-specific directories.
- Root discovery experience: `index.html`, `discover.js`, `discover.css`.
- Catalogue data: `catalogue.json`; current discovery script reads its books, matches and topics.
- Existing reading experience under `reader/` and book content under `assets/books/`.
- Publishing catalogue and series pages under `projects/`.
- Founder, founder-note, credits, about and contact pages.
- Protected administration experience under `admin/`, including users, content, books, publishing jobs, book access, payments, billing/invoices, reviews, coupons, announcements, feedback and files.
- Supabase-backed application services, payment/access flows and private generation-candidate storage.
- Python book-generation worker under `tools/book-generator/`, with unit tests and a manually dispatched GitHub Actions workflow.

## Non-negotiable preservation rules

1. Do not delete, renumber, rewrite or silently reinterpret the existing 24-book catalogue.
2. Do not change Reader Match data, mapping logic, recommendation outcomes or existing topic/reading-order data without a separately tested migration and explicit approval.
3. Preserve authentication, user accounts, reading progress, bookmarks, saved lines, purchase records, payment verification, entitlements, invoices and admin permissions.
4. Preserve private storage and server-side payment verification. Never expose service-role credentials, private PDFs, candidate artifacts or privileged endpoints to the browser.
5. Preserve existing canonical URLs and redirects; do not break indexed book, chapter, founder, collection or reader routes.
6. No destructive database migration, payment-provider change, production deploy or live publishing-job dispatch as part of design work.
7. Keep changes in this branch until review. No direct push to the production branch.
8. Public credits may describe current responsibilities accurately; do not falsify historical contributions, contracts, ownership or account access.

## Experience architecture to design

### Global shell
- Premium editorial navigation with a clear hierarchy, responsive behavior and accessible keyboard operation.
- Consistent typography, spacing, color tokens, interaction states and motion rules.
- Strong page identity without making every page a copy of the homepage.
- Respect reduced-motion preferences; no scroll-jacking or autoplay audio.

### Core destinations
1. **Discover** — a distinctive editorial entry point; keep catalogue discovery and Reader Match intact.
2. **Explore** — navigate themes, questions, series, books and reading paths.
3. **The Mind** — curated access to mind/perception/identity work, not diagnosis.
4. **The Human** — lived experience, relationships, contradictions and reflection.
5. **Library** — all 24 books, volumes and six series, with accurate availability and access states.
6. **Reading Room** — preserve the current reader, reading modes, progress, bookmarks and saved lines.
7. **Connection** — structured, consent-led ways to engage with ideas and the publishing house; no unmoderated social feed by default.
8. **The Collective** — future community/editorial participation, only after moderation, privacy and safety design.
9. **Origin** — founder story and editorial philosophy, with Lalit Rakesh Mishra identified accurately as founder and creator.
10. **My Space** — personal library, access, reading activity and saved material.
11. **Control Room** — the existing protected admin capability, reorganized only after role, permission and workflow audit.

## Visual design direction

- Visual language: contemporary independent literary institution; restrained, tactile, thoughtful and unmistakably editorial.
- Initial palette to validate in prototypes: Obsidian `#111216`, Porcelain `#F0EDE5`, Slate `#777B91`, Sage `#A8B3A1`, Amethyst `#B7A6BE`, Terracotta `#B98D76`.
- Typography pairing: expressive literary serif for display/editorial moments; highly legible sans-serif for navigation and body; restrained mono for metadata.
- Avoid generic rounded-card dashboards, template-like gradients, excessive glass effects, decorative motion and generic AI imagery.
- Design responsive desktop, tablet and mobile states, with focus, hover, loading, empty, error and authenticated states.

## Founder and credits

The founder page and public credits should consistently identify Lalit Rakesh Mishra as Founder and CEO, and attribute only work he actually created or directed. Present roles as clear responsibilities rather than inventing a large staffed executive team. Remove outdated active-team presentation only after reviewing the current credits page and ensuring historical/legal records remain accurate.

## Implementation sequence

1. Complete route, asset, data, backend, database, payment, security and deployment inventory.
2. Capture a baseline of existing routes, catalogue counts, Reader Match records/outcomes, reader behavior and admin workflows.
3. Produce page-by-page information architecture and low-fidelity layout specifications.
4. Build and review the shared design system and global navigation.
5. Implement one route family at a time on this branch, preserving canonical routes.
6. Regression-test catalogue, Reader Match, reader, auth, purchases, payment webhooks, entitlements and admin.
7. Run accessibility, mobile, performance, SEO and security checks.
8. Open a review pull request; deploy preview only after CI is green.
9. Production release requires explicit approval and a rollback plan.

## Known limits of this repository-only review

The connected GitHub view does not expose the user's uncommitted VS Code working tree, live Supabase data, provider dashboard settings, local browser behavior or production secrets. Those must not be represented as audited or tested until their actual outputs are available. The baseline audit is therefore a source-repository inspection, not a complete live-system certification.
