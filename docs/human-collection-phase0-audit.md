# The Human Collection — Phase 0 audit (working branch)

**Source:** approved 24-book Master Catalogue and Greyveil website-upgrade specification. **Scope:** repository read-only inspection; does not assert live database state. **User-confirmed:** login issue has already been fixed; do not reopen without new evidence.

## Verified current state

- Source repository: `goreaniket/greyveileditions`, default branch `master`. Existing static HTML/CSS/JS with Supabase auth, protected reader, payment functions, and tests.
- `projects/index.html` exists in source, but public deployment availability could not be verified; do not infer the route is broken or fixed solely from its presence.
- 14 existing book detail HTML files: Human Mind 5, Human Paradox 5, Human Fiction 4. No Human Experience detail pages in the inspected repository tree.
- Existing catalogues run through Supabase-backed public metadata; editorial discovery metadata must **not** replace production IDs, visibility, prices, entitlements, or purchase configuration.
- Supplied workbook: **24 books (5+5+4+10), 34 Reader Match concerns, 19 Topic Index entries, 24 journey rows**. A previously generated `greyveil-24-book-catalogue.json` file is incomplete: **29/34 Reader Match rows**. Never use that JSON uncorrected.

## Planned editorial-to-existing-route mapping

| Journey | Series | Approved title | Existing detail route (not a claim of availability) |
|---:|---|---|---|
| 01 | The Human Mind | The Last Shift | `/projects/human-mind/books/the-last-shift.html` |
| 02 | The Human Mind | The Last Shift — Part II | `/projects/human-mind/books/the-last-shift-ii.html` |
| 03 | The Human Mind | The Quiet I Started Living With | `/projects/human-mind/books/the-quiet-i-started-living-with.html` |
| 04 | The Human Mind | The Loop Within | `/projects/human-mind/books/the-loop-within.html` |
| 05 | The Human Mind | When Understanding Begins | `/projects/human-mind/books/when-understanding-begins.html` |
| 06 | The Human Paradox | The Paradox of Awareness | `/projects/human-paradox/books/the-paradox-of-awareness.html` |
| 07 | The Human Paradox | The Paradox of Explanation | `/projects/human-paradox/books/the-paradox-of-explanation.html` |
| 08 | The Human Paradox | The End of Interpretation | `/projects/human-paradox/books/the-end-of-interpretation.html` |
| 09 | The Human Paradox | The Paradox of Reality | `/projects/human-paradox/books/the-paradox-of-reality.html` |
| 10 | The Human Paradox | The Paradox of Stillness | `/projects/human-paradox/books/the-paradox-of-stillness.html` |
| 11 | The Human Fiction | The Fiction of Awareness | `/projects/human-fiction/books/the-fiction-of-awareness.html` |
| 12 | The Human Fiction | The Fiction of Meaning | `/projects/human-fiction/books/the-fiction-of-meaning.html` |
| 13 | The Human Fiction | The Fiction of Becoming | `/projects/human-fiction/books/the-fiction-of-becoming.html` |
| 14 | The Human Fiction | The Fiction of the Human | `/projects/human-fiction/books/the-fiction-of-human.html` |
| 15 | The Human Experience | The Person Who Was Tired of Being Strong | **Not present in inspected repo** |
| 16 | The Human Experience | The World We Thought We Saw | **Not present in inspected repo** |
| 17 | The Human Experience | An Unknown Part of Life | **Not present in inspected repo** |
| 18 | The Human Experience | The People We Couldn't Save | **Not present in inspected repo** |
| 19 | The Human Experience | Between Birth and Death | **Not present in inspected repo** |
| 20 | The Human Experience | The Things We Did Right and Still Lost | **Not present in inspected repo** |
| 21 | The Human Experience | The Life We Forgot While Building a Life | **Not present in inspected repo** |
| 22 | The Human Experience | The World That Never Leaves Us Alone | **Not present in inspected repo** |
| 23 | The Human Experience | The Distance Between Two Minds | **Not present in inspected repo** |
| 24 | The Human Experience | The Enough That Never Arrived | **Not present in inspected repo** |

**Identity warnings:** Journey #02 is titled `The Last Shift — Part II` in the editorial source, while its current filename/slug uses `the-last-shift-ii`. Preserve that existing slug. Original series numbering must remain separate from overall journey numbering. Four reading stages are editorial navigation, not necessarily current commerce `volumes`.

## Reader Match rows missing from the generated JSON

1. I want to read about love beyond surface-level romance
2. Everything in my life feels like one endless search
3. I want to stop overinterpreting every message or reaction
4. I want to understand the difference between knowing and understanding
5. Life keeps changing and I can't make sense of it

Import all 34 mappings from the **workbook**, not from the incomplete JSON. Validate primary/alternate journey IDs and avoid invented recommendations.

## Execution checklist

- [x] Identify canonical repository and preserve `master`.
- [x] Inventory 24 approved titles and compare to the 14 existing static detail routes.
- [x] Identify missing 5 Reader Match rows in local generated JSON.
- [ ] Verify Supabase canonical book IDs, statuses, slugs and visibility in an authorized environment; **do not guess publication status**.
- [ ] Check whether `/projects/index.html` works in an actual deployment/browser and identify any runtime/route failure if not.
- [ ] Import validated editorial metadata as an independent, read-only discovery layer, using stable journey IDs and explicit source mappings.
- [ ] Build The Human Collection landing page, all 4 series (preserve existing URLs), 34 Reader Match entries, 19 topics, 24-book journey, and individual book context.
- [ ] Add browser and node tests. Validate paid content security, login regression, mobile, accessibility, pricing and purchase entitlement before merging.

**Release policy:** This branch is review-only. No production deployment, backend migration, price change, auth adjustment, or paid reader content exposure is authorized by this audit.
