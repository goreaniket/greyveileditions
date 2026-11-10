# Greyveil Editions

Open `index.html` inside this folder to view the main website.

## Structure

- `assets/`: shared CSS, JavaScript, images, fonts, animation files, and shared reader assets
- `assets/books/`: per-book reader manifests, chapter JSON, design specs, and theme files
- `about/`: Greyveil Editions brand, publishing philosophy, and collection structure
- `founder/`: canonical founder profile for Lalit Rakesh Mishra
- `projects/`: project listing
- `projects/human-mind/`: the Human Mind project section
- `projects/human-mind/books/`: individual book pages
- `projects/human-mind/chapters/`: manually replaceable first chapter files
- `contact/`: contact page
- `privacy/`: privacy policy for accounts, purchases, protected reading, and Human Response
- `shared/`: reserved for reusable snippets or exported components

Greyveil Editions is the parent identity. The Human Paradox Collection is the broader collection, with Human Mind, Human Paradox, and Human Fiction as series within it.

## Greyveil 2.0

The connected Greyveil 2.0 application is the root `index.html`; its shared styles and client code remain in `greyveil-2-preview/`. Serve the repository over HTTP to use the experience. The `/greyveil-2-preview/` route remains available as a no-index design preview. Both entry points link to the existing protected book pages, account, checkout, founder page, contact form, and privacy policy.

Feel Heard drafts, bookmarks, reading history, private letters, and Lines I Kept are stored in the visitor's browser only. They are not account-synced. Story submissions, personal editor responses, response history, public stories, moderation, reports, and public-consent withdrawal use the existing Supabase client and require the signed-in user's session. Personal recommendations can link to existing catalogue books and the three Greyveil Reading Room essays.

The Human Response schema is `supabase/greyveil-2-experience.sql`. It must be applied and verified in an authorized development Supabase project before story services are enabled; do not apply it to production without approval. Until then, the visitor experience fails closed and reports that nothing was saved or sent. Public stories are returned only by the consent-, approval-, and withdrawal-filtered database function. Personal replies are delivered only through each reader's authenticated My Space; no email or response time is promised.

### Owner Command Centre

`/admin/command-center/` is the separate Owner/staff operations interface. Its database migration is `supabase/greyveil-owner-command-center.sql` and depends on `supabase/greyveil-2-experience.sql` and the existing profile, catalogue, order, and feedback schema. Neither migration has been applied or verified against an authorized development database in this workspace. The command centre and story services must be treated as unavailable until that validation is completed.

The Owner migration deliberately aborts unless an operator supplies Lalit's independently verified `auth.users` UUID as the session setting `greyveil.owner_user_id`; it never guesses or promotes an account. Apply both migrations only in the authorized development project, verify the owner identity and MFA, deploy the `invite-command-center-staff` Edge Function with its server-side Supabase service-role configuration, and allow the `/auth/accept-invite/` redirect in Supabase Auth. Never expose the service-role key to the browser. The command-centre RLS replaces legacy Human Response admin policies, requires MFA for privileged RPCs and staff access to private stories, and audits invitations, assignments, moderation, private conversation views, and responses. Login history and provider health metrics require Supabase-side observability not present in this application.
