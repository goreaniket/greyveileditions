# Greyveil Editions Copyright Ownership and Asset Audit

Audit date: August 3, 2026

Scope reviewed: public book manifests under `assets/books/*/book.json`, the linked `02-copyright*.json` notice files for all 14 active books, public website pages, credits page, public image folders, CSS, JavaScript, sitemap, and repository-visible notices. No manuscript, reader, authentication, or payment files were modified during this audit.

## Ownership Matrix

| Book title | Credited author | Stated copyright owner | Publisher | Year | Source of confirmation | Confidence | Unresolved conflict |
|---|---|---|---|---|---|---|---|
| The End of Interpretation | Lalit R. Mishra | Not named on copyright line; notice says original work by Lalit R. Mishra and requires permission from the author | Greyveil Editions | 2026 | `assets/books/the-end-of-interpretation/book.json`; `assets/books/the-end-of-interpretation/chapters/02-copyright-notice.json` | Medium | Owner is not explicitly named on the copyright line. |
| The Fiction of Awareness | Lalit R. Mishra | Not named on copyright line; notice refers to the author's original narrative framework | Greyveil Editions | 2026 | `assets/books/the-fiction-of-awareness/book.json`; `assets/books/the-fiction-of-awareness/chapters/02-copyright.json` | Medium | Owner is not explicitly named on the copyright line. |
| The Fiction of Becoming | Lalit R. Mishra | Lalit R. Mishra | Greyveil Editions | 2026 | `assets/books/the-fiction-of-becoming/book.json`; `assets/books/the-fiction-of-becoming/chapters/02-copyright.json` | High | None found in reviewed files. |
| The Fiction of the Human | Lalit R. Mishra | Lalit R. Mishra | Greyveil Editions | 2026 | `assets/books/the-fiction-of-human/book.json`; `assets/books/the-fiction-of-human/chapters/02-copyright.json` | High | None found in reviewed files. |
| The Fiction of Meaning | Lalit R. Mishra | Lalit R. Mishra | Greyveil Editions | 2026 from metadata; notice omits year | `assets/books/the-fiction-of-meaning/book.json`; `assets/books/the-fiction-of-meaning/chapters/02-copyright.json` | Medium | Copyright notice names owner but omits the year. |
| The Last Shift | Lalit R. Mishra | Lalit R. Mishra | Greyveil Editions | 2025 in notice; 2026 in metadata | `assets/books/the-last-shift/book.json`; `assets/books/the-last-shift/chapters/02-copyright.json` | Medium | Copyright notice year and metadata edition year differ. |
| The Last Shift II | Lalit R. Mishra | Unresolved; copyright line reads "The Last Shift" where an owner would normally appear | Greyveil Editions | 2026 | `assets/books/the-last-shift-ii/book.json`; `assets/books/the-last-shift-ii/chapters/02-copyright.json` | Low | Copyright owner line appears malformed or conflicts with metadata author. |
| The Loop Within | Lalit R. Mishra | LALIT R MISHRA | Greyveil Editions | 2026 from metadata; notice omits year | `assets/books/the-loop-within/book.json`; `assets/books/the-loop-within/chapters/02-copyright.json` | Medium | Copyright notice names owner but omits the year and uses a spelling variant. |
| The Paradox of Awareness | Lalit R. Mishra | Not named on copyright line; notice says the book and contents are intellectual property of the author | Greyveil Editions | 2026 | `assets/books/the-paradox-of-awareness/book.json`; `assets/books/the-paradox-of-awareness/chapters/02-copyright-notice.json` | Medium | Owner is referred to as author but not named on the copyright line. |
| The Paradox of Explanation | Lalit R. Mishra | Not named on copyright line; notice says original writing by Lalit R Mishra and requires permission from the author | Greyveil Editions | 2026 | `assets/books/the-paradox-of-explanation/book.json`; `assets/books/the-paradox-of-explanation/chapters/02-copyright-notice.json` | Medium | Owner is not explicitly named on the copyright line; author name spelling lacks a period. |
| The Paradox of Reality | Lalit R. Mishra | Lalit R. Mishra | Greyveil Editions | 2026 | `assets/books/the-paradox-of-reality/book.json`; `assets/books/the-paradox-of-reality/chapters/02-copyright.json` | High | None found in reviewed files. |
| The Paradox of Stillness | Lalit R. Mishra | Lalit R. Mishra | Greyveil Editions | 2026 | `assets/books/the-paradox-of-stillness/book.json`; `assets/books/the-paradox-of-stillness/chapters/02-copyright-notice.json` | High | None found in reviewed files. |
| The Quiet I Started Living With | Lalit R. Mishra | Lalit R. Mishra | Greyveil Editions | 2026 | `assets/books/the-quiet-i-started-living-with/book.json`; `assets/books/the-quiet-i-started-living-with/chapters/02-copyright.json` | High | Notice wording includes "by Lalit R. Mishra"; no conflict found in reviewed files. |
| When Understanding Begins | Lalit R. Mishra | Lalit R Mishra | Greyveil Editions | 2026 | `assets/books/when-understanding-begins/book.json`; `assets/books/when-understanding-begins/chapters/02-copyright.json` | High | Author/owner spelling variant lacks a period. |

## Ownership Summary

- All 14 public book manifests reviewed list Lalit R. Mishra as credited author.
- All 14 public book manifests reviewed list Greyveil Editions as publisher.
- Explicit named copyright-owner lines were found for several books, but not all.
- No repository-visible rights agreements, registration records, cover-art licences, photo releases, font licence files, or third-party asset licences were found during this audit.
- The new public policy therefore uses neutral ownership wording and does not claim ownership over third-party material.

## Third-Party Asset Audit

| Asset group | Source found in repository | Licence or permission evidence found | Attribution requirement found | Confidence | Unresolved risk |
|---|---|---|---|---|---|
| Google Fonts: Cormorant Garamond and Inter | Imported from `fonts.googleapis.com` / `fonts.gstatic.com` in public HTML | No local licence copy or attribution note found | None documented in repo | Medium | Confirm current Google Fonts licence terms before making external-use or redistribution claims. |
| Book covers and generated cover variants | `assets/books/*/cover/*`; `projects/*/assets/covers/*.jpeg` | No source files, contracts, licence records, or attribution notes found beyond local asset files | Unknown | Low to medium | Confirm cover artist/designer/source and whether attribution or restrictions apply. |
| Founder and team photographs | `assets/images/Lalit.jpeg`, `assets/images/aniket.jpg`, `assets/images/purnendu.jpeg` | No photo release, photographer credit, or licence record found | Unknown | Low to medium | Confirm photographer/source permissions before expanding public usage. |
| Logo, favicon, OG image, and series identity images | `assets/images/greyveil-logo.png`, `favicon.png`, `greyveil-og-cover.jpg`, series images | No separate brand source or licence record found | None documented in repo | Medium | Likely first-party brand material, but source/provenance should be recorded. |
| Home hero images | `assets/images/home-hero-*.jpg` and `.webp` | No source or licence record found | Unknown | Low to medium | Confirm whether these are derived from book covers, generated assets, or third-party images. |
| Icons | Inline Instagram-style SVGs in public HTML | No third-party icon library detected; Instagram brand reference present | No attribution note found | Medium | Platform icons/trademarks may be subject to Instagram/Meta brand rules. |
| JavaScript libraries | `assets/js/main.js` and `assets/js/reader.js`; no third-party frontend library import detected in public HTML | Local source only | None documented | High for "no external JS library detected" | Ownership/licence of site-authored scripts should still be documented internally. |
| External services and embeds | Google Apps Script feedback endpoint in feedback page and book manifests; Instagram, WhatsApp, phone, and mail links | Service terms or permissions not stored in repo | Not applicable to ordinary outbound links | Medium | External services are not site assets, but their terms and data-handling obligations should be reviewed separately. |
| Music/audio references | No public audio files or music embeds found in the reviewed public asset list | Not applicable | Not applicable | High | None found in this scope. |
| Stock image provider references | No Unsplash, Pexels, Pixabay, or obvious stock-provider references found in public HTML/CSS/JS | Not found | Unknown for local images | Medium | Local image provenance is still undocumented, so absence of stock-provider text is not proof of clearance. |
