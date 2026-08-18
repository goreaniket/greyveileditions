# Greyveil Book Generator

This workspace prepares Greyveil Editions books from the same source files used
by the website reader. The reader remains the visual source of truth; generated
formats map from the book JSON, chapter JSON, cover assets, theme CSS, and
`design-spec.json`.

## Current source contract

Book source lives in:

```text
assets/books/<slug>/
  book.json
  design-spec.json
  theme.css
  chapters/
  cover/
```

The existing reader remains the visual source of truth. Generator code reads
the same files the reader uses instead of introducing a separate document design
system.

## Export modes

### Digital / visual mode

Outputs:

- PDF
- EPUB 3 fixed layout

Contract:

- Keep the reader visual design as the source of truth.
- Use full-page visual composition with warm paper color, reader typography,
  muted Greyveil color, displaced-rule ornamentation, and reader-like
  chapter/phase opening pages.
- Treat the front cover as a full-bleed digital cover page.
- Keep EPUB pre-paginated with one fixed 5.5 x 8.5 page canvas per spine item,
  real HTML/CSS text, fixed viewport metadata, and EPUB 3 rendition metadata.
- Derive EPUB geometry and styling from the same normalized export tokens as
  PDF instead of creating an independent reflowable ebook theme.

### Print / editable mode

Output:

- DOCX

Contract:

- Keep the Greyveil identity, typography, and restrained ornament system.
- Use print-safe 5.5 x 8.5 page geometry.
- Encode inside and outside margins, a binding gutter, top/bottom margins, and
  Word mirror margins.
- Include a centered, aspect-preserving cover as a native inline Word image
  contained inside the print-safe page area.
- Keep the cover editable and intentionally contained: no floating or absolute
  positioning, and no fake full-bleed treatment.

## Validate The Last Shift

From the repository root:

```bash
python tools/book-generator/generate_book.py the-last-shift --validate
```

The command checks that the book source can be parsed and normalized. It does
not generate final book files.

## Generate outputs

From the repository root:

```bash
python tools/book-generator/generate_book.py the-last-shift --pdf
python tools/book-generator/generate_book.py the-last-shift --epub
python tools/book-generator/generate_book.py the-last-shift --docx
python tools/book-generator/generate_book.py the-last-shift --all
```

## Import a DOCX manuscript

The input automation layer normalizes a Word manuscript into the same book
source consumed by the existing generator. It never overwrites an existing
`assets/books/<slug>/` folder.

```bash
python tools/book-generator/import_book.py path/to/manuscript.docx
python tools/book-generator/import_book.py path/to/manuscript.docx --cover path/to/cover.png --generate
python tools/book-generator/import_book.py --process-inbox --generate
```

The default inbox is `tools/book-generator/inbox/`; `~$*.docx` Word temporary
files are ignored. The importer detects explicit Word title/subtitle/author
styles and conservative structural headings, retains source runs and emphasis,
and uses `the-last-shift` design configuration unless `--design-from` is set.
Missing title, author, cover, or usable manuscript structure returns `NEEDS
ATTENTION` without creating or merging a book folder. With `--generate`, the
existing generator is invoked once per format and the resulting PDF, EPUB, and
DOCX receive structural QA.

Default outputs are written to:

```text
output/pdf/<slug>.pdf
output/epub/<slug>.epub
output/docx/<slug>-print-editable.docx
```

The legacy prototype command is still available:

```bash
python tools/book-generator/generate_book.py the-last-shift --pdf-prototype
```

## Generator boundaries

- Load a book by slug.
- Validate required files and folders.
- Parse `book.json` and `design-spec.json`.
- Locate `theme.css`.
- Locate cover assets.
- Load chapter/unit JSON files in order.
- Normalize content blocks into an in-memory model.
- Print a validation summary.
- Export reader-style PDF and EPUB files.
- Export fixed-layout EPUB 3 files with preserved navigation and page-list
  metadata.
- Export print-safe editable DOCX files.

Source ZIP export remains reserved for a later pipeline step.
