# Shared Reader Architecture

The Last Shift is the approved master reader implementation for Greyveil Editions.

## Shared Engine

These files are shared by every personalized reader:

- `/assets/js/reader.js`
- `/assets/css/reader.css`

Do not copy or fork those files for future books. Reader page structure, responsive behavior, pagination, toolbar controls, contents navigation, progress tracking, whole-book feedback, and accessibility behavior belong in the shared engine and base stylesheet.

## Per-Book Folder

Each book owns a folder under `/assets/books/{book-slug}/`:

```text
assets/books/{book-slug}/
  book.json
  design-spec.json
  theme.css
  chapters/
    00-opening.json
    01-contents.json
    ...
```

`book.json` is the runtime manifest. It provides metadata, `readerRoute`, optional `readerExitUrl`, `designSpecFile`, `themeStylesheet`, feedback settings, theme variables, and the ordered `units` list.

`chapters/*.json` files hold book content only. They should keep ordered elements and source paragraph anchors.

`design-spec.json` is the visual source of truth for that book. It should describe the identity decisions that the theme implements.

`theme.css` is the only book-specific styling file. It may define palette, type treatment, ornaments, page proportions, and special matter styling for that book class. It should not redefine the full reader shell, controls, drawer, progress system, feedback behavior, or pagination mechanics.

## Reader Route

Each reader route is a small shell that points to the shared reader assets and its book manifest:

```html
<link rel="stylesheet" href="/assets/css/reader.css" />
<body
  class="reader-book"
  data-book-url="/assets/books/{book-slug}/book.json"
>
  <script src="/assets/js/reader.js" defer></script>
</body>
```

The shared script generates the approved reader structure and loads the book's `themeStylesheet` from `book.json`.

## Master Book

`/assets/books/the-last-shift/` and `/projects/human-mind/books/the-last-shift/reader/` are the master implementation. Future books should match this architecture while replacing only book data, chapter content, design spec, theme identity, and route metadata.
